/**
 * وصول مدير الاتصالات إلى حساب تيليجرام في قاعدة البيانات.
 * كل عمليات القراءة مقيّدة بمالك الحساب؛ لا يُقبل معرّف مستخدم من العميل.
 */
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { loadTelegramSession, saveTelegramSession, deleteTelegramSession } from './sessionStore.js';
import type { SessionPayload } from './sessionCipher.js';

export type TelegramAccountStatus = 'pending_login' | 'active' | 'needs_reauth' | 'revoked' | 'suspended';

export interface TelegramAccountRecord {
  id: string;
  userId: string;
  label: string;
  status: TelegramAccountStatus;
  telegramUserId: string | null;
  telegramUsername: string | null;
}

/** عنصر قائمة الحسابات المعروض للمستخدم (بلا أي بيانات جلسة أو رقم كامل). */
export interface TelegramAccountListItem {
  id: string;
  label: string;
  status: TelegramAccountStatus;
  telegramUserId: string | null;
  telegramUsername: string | null;
  phoneLastDigits: string | null;
  lastConnectedAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
}

/** مخزن الحسابات: كل عملية مقيّدة بمالك الحساب (لا يُقبل معرّف مستخدم من العميل). */
export interface TelegramAccountStore {
  /** يتحقق من ملكية الحساب ويعيد سجله الدائم. */
  findOwned(accountId: string, userId: string): Promise<TelegramAccountRecord | null>;
  /**
   * مالك الحساب وحالته بمعرّفه الداخلي فقط — لمسار الالتقاط الذي يأتيه الحدث من المكتبة
   * (بلا معرّف مستخدم من العميل). لا يعيد أي بيانات حساسة.
   */
  findOwner(accountId: string): Promise<{ userId: string; status: TelegramAccountStatus } | null>;
  listByUser(userId: string): Promise<TelegramAccountListItem[]>;
  /** ينشئ سجلاً بحالة pending_login قبل اكتمال المصادقة. */
  createPendingAccount(input: {
    userId: string;
    label: string;
    phoneLastDigits: string;
    phoneHash: string;
  }): Promise<TelegramAccountListItem>;
  setPhoneHash(accountId: string, phoneHash: string): Promise<void>;
  findByPhoneHash(userId: string, phoneHash: string): Promise<{ id: string; status: TelegramAccountStatus } | null>;
  /** بعد نجاح المصادقة: الحالة active والهوية الفعلية من تيليجرام. */
  markActive(accountId: string, self: { id: string; username?: string }): Promise<void>;
  /** فصل الحساب: مسح الهوية والبصمة مع إبقاء سجل تاريخي (status = revoked). */
  markRevoked(accountId: string, client?: PoolClient | null): Promise<void>;
  /** حذف سجل لم يكتمل ربطه (إلغاء قبل المصادقة) — مقيّد بالمالك. */
  deletePendingAccount(accountId: string, userId: string): Promise<void>;
  /** الحسابات التي يُعاد توصيلها عند بدء الخادم (D03/O01). */
  listAccountsForRestore(): Promise<{ id: string; userId: string }[]>;
}

export interface ConnectionRepository {
  findOwned(accountId: string, userId: string): Promise<TelegramAccountRecord | null>;
  markConnected(accountId: string, self: { id: string; username?: string }): Promise<void>;
  markNeedsReauth(accountId: string, code: string): Promise<void>;
  markDisconnected(accountId: string): Promise<void>;
  markError(accountId: string, code: string): Promise<void>;
  loadSession(accountId: string, userId: string): Promise<(SessionPayload & { keyVersion: number }) | null>;
  saveSession(accountId: string, userId: string, payload: SessionPayload): Promise<void>;
  deleteSession(accountId: string, userId: string, client?: PoolClient | null): Promise<boolean>;
}

export class PgConnectionRepository implements ConnectionRepository, TelegramAccountStore {
  async findOwned(accountId: string, userId: string): Promise<TelegramAccountRecord | null> {
    const res = await query<{
      id: string;
      user_id: string;
      label: string;
      status: TelegramAccountStatus;
      telegram_user_id: string | null;
      telegram_username: string | null;
    }>(
      `select id, user_id, label, status, telegram_user_id::text as telegram_user_id, telegram_username
         from telegram_accounts where id = $1 and user_id = $2`,
      [accountId, userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      label: row.label,
      status: row.status,
      telegramUserId: row.telegram_user_id,
      telegramUsername: row.telegram_username,
    };
  }

  async markConnected(accountId: string, self: { id: string; username?: string }): Promise<void> {
    await query(
      `update telegram_accounts
          set status = 'active',
              telegram_user_id = $2::bigint,
              telegram_username = $3,
              last_connected_at = now(),
              last_error_code = null
        where id = $1`,
      [accountId, self.id, self.username ?? null],
    );
  }

  async markNeedsReauth(accountId: string, code: string): Promise<void> {
    await query(
      "update telegram_accounts set status = 'needs_reauth', last_error_code = $2 where id = $1",
      [accountId, code],
    );
  }

  async markDisconnected(accountId: string): Promise<void> {
    await query(
      "update telegram_accounts set last_error_code = null where id = $1 and status = 'active'",
      [accountId],
    );
  }

  async markError(accountId: string, code: string): Promise<void> {
    await query('update telegram_accounts set last_error_code = $2 where id = $1', [accountId, code]);
  }

  loadSession(accountId: string, userId: string) {
    return loadTelegramSession({ accountId, userId });
  }

  saveSession(accountId: string, userId: string, payload: SessionPayload) {
    return saveTelegramSession({ accountId, userId, payload });
  }

  deleteSession(accountId: string, userId: string, client: PoolClient | null = null) {
    return deleteTelegramSession(accountId, userId, client);
  }

  // ── مخزن الحسابات (واجهة TelegramAccountStore) ─────────────────────────────
  async findOwner(accountId: string): Promise<{ userId: string; status: TelegramAccountStatus } | null> {
    const res = await query<{ user_id: string; status: TelegramAccountStatus }>(
      'select user_id, status from telegram_accounts where id = $1',
      [accountId],
    );
    const row = res.rows[0];
    return row ? { userId: row.user_id, status: row.status } : null;
  }

  async listByUser(userId: string): Promise<TelegramAccountListItem[]> {
    const res = await query<{
      id: string;
      label: string;
      status: TelegramAccountStatus;
      telegram_user_id: string | null;
      telegram_username: string | null;
      phone_last_digits: string | null;
      last_connected_at: Date | null;
      last_error_code: string | null;
      created_at: Date;
    }>(
      `select id, label, status, telegram_user_id::text as telegram_user_id, telegram_username,
              phone_last_digits, last_connected_at, last_error_code, created_at
         from telegram_accounts where user_id = $1 order by created_at desc`,
      [userId],
    );
    return res.rows.map(toListItem);
  }

  async createPendingAccount(input: {
    userId: string;
    label: string;
    phoneLastDigits: string;
    phoneHash: string;
  }): Promise<TelegramAccountListItem> {
    const res = await query<{
      id: string;
      label: string;
      status: TelegramAccountStatus;
      telegram_user_id: string | null;
      telegram_username: string | null;
      phone_last_digits: string | null;
      last_connected_at: Date | null;
      last_error_code: string | null;
      created_at: Date;
    }>(
      `insert into telegram_accounts (user_id, label, phone_last_digits, phone_hash, status)
       values ($1, $2, $3, $4, 'pending_login')
       returning id, label, status, telegram_user_id::text as telegram_user_id, telegram_username,
                 phone_last_digits, last_connected_at, last_error_code, created_at`,
      [input.userId, input.label, input.phoneLastDigits, input.phoneHash],
    );
    return toListItem(res.rows[0]!);
  }

  async setPhoneHash(accountId: string, phoneHash: string): Promise<void> {
    await query('update telegram_accounts set phone_hash = $2 where id = $1', [accountId, phoneHash]);
  }

  async findByPhoneHash(
    userId: string,
    phoneHash: string,
  ): Promise<{ id: string; status: TelegramAccountStatus } | null> {
    const res = await query<{ id: string; status: TelegramAccountStatus }>(
      `select id, status from telegram_accounts
        where user_id = $1 and phone_hash = $2 and status <> 'revoked' limit 1`,
      [userId, phoneHash],
    );
    return res.rows[0] ?? null;
  }

  async markActive(accountId: string, self: { id: string; username?: string }): Promise<void> {
    await this.markConnected(accountId, self);
  }

  async markRevoked(accountId: string, client: PoolClient | null = null): Promise<void> {
    const sql = `update telegram_accounts
                    set status = 'revoked',
                        telegram_user_id = null,
                        telegram_username = null,
                        phone_hash = null,
                        is_active_reader = false,
                        last_error_code = null
                  where id = $1`;
    if (client) await client.query(sql, [accountId]);
    else await query(sql, [accountId]);
  }

  async listAccountsForRestore(): Promise<{ id: string; userId: string }[]> {
    const res = await query<{ id: string; user_id: string }>(
      `select id, user_id from telegram_accounts
        where status = 'active'
          and exists (select 1 from telegram_sessions s where s.account_id = telegram_accounts.id)
        order by last_connected_at desc nulls last, created_at asc`,
    );
    return res.rows.map((row) => ({ id: row.id, userId: row.user_id }));
  }

  async deletePendingAccount(accountId: string, userId: string): Promise<void> {
    await query(
      "delete from telegram_accounts where id = $1 and user_id = $2 and status = 'pending_login'",
      [accountId, userId],
    );
  }
}

function toListItem(row: {
  id: string;
  label: string;
  status: TelegramAccountStatus;
  telegram_user_id: string | null;
  telegram_username: string | null;
  phone_last_digits: string | null;
  last_connected_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
}): TelegramAccountListItem {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    telegramUserId: row.telegram_user_id,
    telegramUsername: row.telegram_username,
    phoneLastDigits: row.phone_last_digits ?? null,
    lastConnectedAt: row.last_connected_at ?? null,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
  };
}
