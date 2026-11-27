/**
 * مخزن محاولات الربط المؤقتة: تُحفظ **مشفّرة** مع صلاحية زمنية وعدادات محاولات.
 * لا يُخزَّن رمز التحقق ولا كلمة مرور التحقق بخطوتين في أي لحظة؛ يُخزَّن فقط ما تحتاجه
 * استكمال طلب Telegram (رقم الهاتف، phone_code_hash، والجلسة المؤقتة) داخل المغلّف.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { openPayload, sealPayload } from './sessionCipher.js';

export type LoginStage = 'code' | 'password';

/** محتوى المحاولة المؤقت (سري بالكامل). */
export interface LoginChallengePayload {
  phoneNumber: string;
  phoneCodeHash: string;
  /** جلسة MTProto المؤقتة قبل المصادقة، للاستمرار بعد إعادة تشغيل الخادم. */
  tempSession: string;
}

export interface LoginChallenge {
  id: string;
  accountId: string;
  userId: string;
  stage: LoginStage;
  payload: LoginChallengePayload;
  codeAttempts: number;
  passwordAttempts: number;
  resendCount: number;
  lastSentAt: Date;
  expiresAt: Date;
}

export interface LoginChallengeStore {
  /** يستبدل أي محاولة نشطة سابقة للحساب بمحاولة جديدة (محاولة نشطة واحدة لكل حساب). */
  start(input: {
    accountId: string;
    userId: string;
    payload: LoginChallengePayload;
    expiresAt: Date;
  }): Promise<LoginChallenge>;
  findActive(input: { accountId: string; userId: string }): Promise<LoginChallenge | null>;
  /** يحدّث المحتوى المشفّر (جلسة مؤقتة متجددة) و/أو المرحلة. */
  update(input: { id: string; payload?: LoginChallengePayload; stage?: LoginStage; expiresAt?: Date }): Promise<void>;
  /** يزيد عدّاد المحاولات ويعيد القيمة الجديدة. */
  registerAttempt(input: { id: string; kind: 'code' | 'password' }): Promise<number>;
  registerResend(id: string): Promise<number>;
  consume(id: string): Promise<void>;
  /** يلغي كل المحاولات النشطة للحساب (إلغاء يدوي أو بدء محاولة جديدة). */
  closeAll(accountId: string, client?: PoolClient | null): Promise<void>;
}

interface Row {
  id: string;
  account_id: string;
  user_id: string;
  stage: LoginStage;
  ciphertext: Buffer;
  code_attempts: number;
  password_attempts: number;
  resend_count: number;
  last_sent_at: Date;
  expires_at: Date;
}

function toChallenge(row: Row): LoginChallenge {
  const { value } = openPayload<LoginChallengePayload>('login', row.account_id, row.ciphertext);
  return {
    id: row.id,
    accountId: row.account_id,
    userId: row.user_id,
    stage: row.stage,
    payload: value,
    codeAttempts: row.code_attempts,
    passwordAttempts: row.password_attempts,
    resendCount: row.resend_count,
    lastSentAt: row.last_sent_at,
    expiresAt: row.expires_at,
  };
}

const SELECT_COLUMNS = `id, account_id, user_id, stage, ciphertext, code_attempts, password_attempts,
                        resend_count, last_sent_at, expires_at`;

export class PgLoginChallengeStore implements LoginChallengeStore {
  async start(input: {
    accountId: string;
    userId: string;
    payload: LoginChallengePayload;
    expiresAt: Date;
  }): Promise<LoginChallenge> {
    const sealed = sealPayload<LoginChallengePayload>('login', input.accountId, input.payload);
    return withTransaction(async (client) => {
      // تنظيف محدود للسجلات المستهلكة القديمة (احتفاظ 24 ساعة): يمنع نمو الجدول بلا حد،
      // ولا يحذف أي محاولة نشطة.
      await client.query(
        `delete from telegram_login_challenges
          where consumed_at is not null and consumed_at < now() - interval '24 hours'`,
      );
      // إغلاق أي محاولة سابقة (يمنع خرق قيد "محاولة نشطة واحدة لكل حساب").
      await client.query(
        'update telegram_login_challenges set consumed_at = now() where account_id = $1 and consumed_at is null',
        [input.accountId],
      );
      const res = await client.query<Row>(
        `insert into telegram_login_challenges (account_id, user_id, ciphertext, key_version, expires_at)
         values ($1, $2, $3, $4, $5)
         returning ${SELECT_COLUMNS}`,
        [input.accountId, input.userId, sealed.ciphertext, sealed.keyVersion, input.expiresAt],
      );
      return toChallenge(res.rows[0]!);
    });
  }

  async findActive(input: { accountId: string; userId: string }): Promise<LoginChallenge | null> {
    const res = await query<Row>(
      `select ${SELECT_COLUMNS} from telegram_login_challenges
        where account_id = $1 and user_id = $2 and consumed_at is null
        order by created_at desc limit 1`,
      [input.accountId, input.userId],
    );
    const row = res.rows[0];
    return row ? toChallenge(row) : null;
  }

  async update(input: {
    id: string;
    payload?: LoginChallengePayload;
    stage?: LoginStage;
    expiresAt?: Date;
  }): Promise<void> {
    if (input.payload) {
      const row = await query<{ account_id: string }>(
        'select account_id from telegram_login_challenges where id = $1',
        [input.id],
      );
      const accountId = row.rows[0]?.account_id;
      if (!accountId) return;
      const sealed = sealPayload<LoginChallengePayload>('login', accountId, input.payload);
      await query(
        `update telegram_login_challenges
            set ciphertext = $2, key_version = $3,
                stage = coalesce($4, stage),
                expires_at = coalesce($5, expires_at)
          where id = $1`,
        [input.id, sealed.ciphertext, sealed.keyVersion, input.stage ?? null, input.expiresAt ?? null],
      );
      return;
    }
    await query(
      `update telegram_login_challenges
          set stage = coalesce($2, stage), expires_at = coalesce($3, expires_at)
        where id = $1`,
      [input.id, input.stage ?? null, input.expiresAt ?? null],
    );
  }

  async registerAttempt(input: { id: string; kind: 'code' | 'password' }): Promise<number> {
    const column = input.kind === 'code' ? 'code_attempts' : 'password_attempts';
    const res = await query<{ attempts: number }>(
      `update telegram_login_challenges set ${column} = ${column} + 1
        where id = $1 returning ${column} as attempts`,
      [input.id],
    );
    return res.rows[0]?.attempts ?? 0;
  }

  async registerResend(id: string): Promise<number> {
    const res = await query<{ resend_count: number }>(
      `update telegram_login_challenges
          set resend_count = resend_count + 1, last_sent_at = now()
        where id = $1 returning resend_count`,
      [id],
    );
    return res.rows[0]?.resend_count ?? 0;
  }

  async consume(id: string): Promise<void> {
    await query('update telegram_login_challenges set consumed_at = now() where id = $1 and consumed_at is null', [id]);
  }

  async closeAll(accountId: string, client: PoolClient | null = null): Promise<void> {
    const sql =
      'update telegram_login_challenges set consumed_at = now() where account_id = $1 and consumed_at is null';
    if (client) await client.query(sql, [accountId]);
    else await query(sql, [accountId]);
  }
}
