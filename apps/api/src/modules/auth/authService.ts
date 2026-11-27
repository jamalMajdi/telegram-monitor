/**
 * منطق المصادقة والتسجيل واستعادة كلمة المرور.
 * قواعد ثابتة: الرسائل العامة لا تكشف وجود البريد، ولا تُسجَّل أسرار،
 * وكل قرار أمني مؤثر (نجاح/فشل/قفل/تعليق) يُدوَّن في سجل التدقيق.
 */
import type { PoolClient } from 'pg';
import { env } from '../../config/env.js';
import { query, withTransaction } from '../../db/pool.js';
import { sealPayload } from '../telegram/sessionCipher.js';
import { recordAudit } from '../../lib/audit.js';
import {
  accountLocked,
  conflict,
  forbidden,
  unauthorized,
} from '../../lib/errors.js';
import { burnPasswordCheck, hashPassword, validatePasswordStrength, verifyPassword } from '../../lib/password.js';
import { hashToken, randomToken } from '../../lib/tokens.js';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
  failed_login_count: number;
  locked_until: Date | null;
}

const PASSWORD_ERROR_MESSAGES: Record<string, string> = {
  too_short: 'كلمة المرور قصيرة جداً: 10 أحرف على الأقل.',
  too_long: 'كلمة المرور أطول من الحد المسموح.',
  common: 'كلمة المرور شائعة جداً. اختر كلمة مرور أخرى.',
  missing_letter_digit: 'يجب أن تحتوي كلمة المرور على حرف ورقم معاً.',
};

export function passwordErrorMessage(code: string): string {
  return PASSWORD_ERROR_MESSAGES[code] ?? 'كلمة المرور غير صالحة.';
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function registrationEnabled(): Promise<boolean> {
  const res = await query<{ value: { enabled?: boolean } }>(
    "select value from system_settings where key = 'system.registration_enabled'",
  );
  return res.rows[0]?.value?.enabled !== false;
}

async function defaultRetentionHours(): Promise<number> {
  const res = await query<{ value: { hours?: number } }>(
    "select value from system_settings where key = 'system.default_content_retention_hours'",
  );
  const hours = res.rows[0]?.value?.hours;
  return typeof hours === 'number' ? hours : 48;
}

async function activeAdminCount(client: PoolClient | null = null): Promise<number> {
  const sql = "select count(*)::int as count from users where role = 'admin' and status = 'active'";
  const res = client ? await client.query<{ count: number }>(sql) : await query<{ count: number }>(sql);
  return res.rows[0]?.count ?? 0;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
}

export function toPublicUser(row: {
  id: string;
  email: string;
  display_name: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
}): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
  };
}

export async function registerUser(
  input: { email: string; displayName: string; password: string },
  ctx: RequestContext,
): Promise<PublicUser> {
  if (!(await registrationEnabled())) {
    throw forbidden('التسجيل الذاتي معطّل حالياً. تواصل مع مدير النظام.');
  }
  const policyError = validatePasswordStrength(input.password);
  if (policyError) throw conflict('weak_password', passwordErrorMessage(policyError));

  const email = input.email.trim();
  const normalized = normalizeEmail(email);
  const passwordHash = await hashPassword(input.password);
  const retention = await defaultRetentionHours();

  return withTransaction(async (client) => {
    const existing = await client.query('select 1 from users where email_normalized = $1', [normalized]);
    if ((existing.rowCount ?? 0) > 0) {
      throw conflict('email_taken', 'هذا البريد الإلكتروني مسجّل مسبقاً.');
    }
    const bootstrapEmail = env.BOOTSTRAP_ADMIN_EMAIL ? normalizeEmail(env.BOOTSTRAP_ADMIN_EMAIL) : null;
    const isBootstrapAdmin = Boolean(bootstrapEmail) && bootstrapEmail === normalized && (await activeAdminCount(client)) === 0;

    const inserted = await client.query<{ id: string; email: string; display_name: string; role: 'user' | 'admin'; status: 'active' }>(
      `insert into users (email, display_name, password_hash, role)
       values ($1, $2, $3, $4)
       returning id, email, display_name, role, status`,
      [email, input.displayName.trim(), passwordHash, isBootstrapAdmin ? 'admin' : 'user'],
    );
    const user = inserted.rows[0]!;
    await client.query('insert into user_settings (user_id, content_retention_hours) values ($1, $2)', [
      user.id,
      retention,
    ]);
    await recordAudit(
      {
        action: 'auth.register',
        actorUserId: user.id,
        actorRole: user.role,
        targetType: 'user',
        targetId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { bootstrapAdmin: isBootstrapAdmin },
      },
      client,
    );
    return toPublicUser(user);
  });
}

export type LoginFailure =
  | { kind: 'invalid' }
  | { kind: 'locked'; retryAfterSeconds: number }
  | { kind: 'suspended' }
  | { kind: 'deleted' };

export async function authenticate(
  input: { email: string; password: string },
  ctx: RequestContext,
): Promise<{ user: PublicUser } | { failure: LoginFailure }> {
  const normalized = normalizeEmail(input.email);
  const res = await query<UserRecord>(
    `select id, email, display_name, password_hash, role, status, failed_login_count, locked_until
       from users where email_normalized = $1`,
    [normalized],
  );
  const user = res.rows[0];

  if (!user) {
    await burnPasswordCheck(input.password);
    await recordLoginAttempt(normalized, ctx.ip, 'unknown_user');
    await recordAudit(
      { action: 'auth.login', outcome: 'failure', ip: ctx.ip, userAgent: ctx.userAgent, metadata: { reason: 'unknown_user' } },
    );
    return { failure: { kind: 'invalid' } };
  }

  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    const retry = Math.ceil((user.locked_until.getTime() - Date.now()) / 1000);
    await recordLoginAttempt(normalized, ctx.ip, 'locked');
    await recordAudit({
      action: 'auth.login',
      outcome: 'denied',
      actorUserId: user.id,
      actorRole: user.role,
      targetType: 'user',
      targetId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'locked' },
    });
    return { failure: { kind: 'locked', retryAfterSeconds: retry } };
  }

  const passwordOk = await verifyPassword(input.password, user.password_hash);
  if (!passwordOk) {
    const outcome = await registerFailedLogin(user, normalized, ctx);
    if (outcome.locked) {
      return { failure: { kind: 'locked', retryAfterSeconds: outcome.retryAfterSeconds } };
    }
    return { failure: { kind: 'invalid' } };
  }

  // كلمة المرور صحيحة: تُفحص الحالة بعد التحقق حتى لا يكشف الرد حالة الحساب للغرباء.
  if (user.status === 'suspended') {
    await recordLoginAttempt(normalized, ctx.ip, 'suspended');
    await recordAudit({
      action: 'auth.login',
      outcome: 'denied',
      actorUserId: user.id,
      actorRole: user.role,
      targetType: 'user',
      targetId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'suspended' },
    });
    return { failure: { kind: 'suspended' } };
  }
  if (user.status === 'deleted') {
    return { failure: { kind: 'deleted' } };
  }

  await query(
    'update users set last_login_at = now(), failed_login_count = 0, locked_until = null where id = $1',
    [user.id],
  );
  await recordLoginAttempt(normalized, ctx.ip, 'success');
  await recordAudit({
    action: 'auth.login',
    actorUserId: user.id,
    actorRole: user.role,
    targetType: 'user',
    targetId: user.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return { user: toPublicUser(user) };
}

async function recordLoginAttempt(emailNormalized: string, ip: string | null, outcome: string): Promise<void> {
  await query('insert into login_attempts (email_normalized, ip, outcome) values ($1, $2::inet, $3)', [
    emailNormalized,
    ip,
    outcome,
  ]);
}

async function registerFailedLogin(
  user: UserRecord,
  normalized: string,
  ctx: RequestContext,
): Promise<{ locked: boolean; retryAfterSeconds: number }> {
  const windowStart = new Date(Date.now() - env.LOGIN_ATTEMPT_WINDOW_MINUTES * 60_000);
  const attempts = await query<{ count: number }>(
    `select count(*)::int as count from login_attempts
      where email_normalized = $1 and outcome in ('bad_credentials','unknown_user') and created_at >= $2`,
    [normalized, windowStart],
  );
  const failed = (attempts.rows[0]?.count ?? 0) + 1;
  const shouldLock = failed >= env.LOGIN_MAX_FAILED_ATTEMPTS;
  const lockedUntil = shouldLock ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000) : null;
  await query(
    `update users
        set failed_login_count = $2,
            locked_until = coalesce($3, locked_until)
      where id = $1`,
    [user.id, failed, lockedUntil],
  );
  await recordLoginAttempt(normalized, ctx.ip, 'bad_credentials');
  await recordAudit({
    action: shouldLock ? 'auth.login.locked' : 'auth.login',
    outcome: 'failure',
    actorUserId: user.id,
    actorRole: user.role,
    targetType: 'user',
    targetId: user.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { failedAttempts: failed, locked: shouldLock },
  });
  return {
    locked: shouldLock,
    retryAfterSeconds: shouldLock ? env.LOGIN_LOCK_MINUTES * 60 : 0,
  };
}

export async function requestPasswordReset(
  email: string,
  ctx: RequestContext,
): Promise<{ devToken?: string }> {
  const normalized = normalizeEmail(email);
  const res = await query<{ id: string; status: string }>(
    'select id, status from users where email_normalized = $1',
    [normalized],
  );
  const user = res.rows[0];
  // الاستجابة موحّدة دائماً: لا كشف لوجود البريد.
  if (!user || user.status !== 'active') {
    await burnPasswordCheck(email);
    return {};
  }
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000);
  await withTransaction(async (client) => {
    await client.query(
      'update password_reset_tokens set invalidated_at = now() where user_id = $1 and used_at is null and invalidated_at is null',
      [user.id],
    );
    await client.query(
      'insert into password_reset_tokens (user_id, token_hash, requested_ip, expires_at) values ($1, $2, $3::inet, $4)',
      [user.id, hashToken(token), ctx.ip, expiresAt],
    );
    /**
     * بريد الاستعادة (P0 — تدقيق ما قبل التسليم): صار الصندوق **مُستهلَكاً** فعلاً.
     * - الرمز يُخزَّن **مشفَّراً** (AES-256-GCM بمفتاح الجلسات، AAD = معرّف المستخدم)،
     *   فيبقى التخزين بلا رمز صريح كما كان، ويستطيع المستهلك بناء الرابط لحظة الإرسال.
     * - `dedupe_key` يمنع طلبين متطابقين من توليد بريدين.
     * - المفتاح غير مهيأ؟ يُدرَج الصف بلا رمز: المستهلك يرسل قالب «تواصل مع المدير»
     *   بدل رسالة صامتة أو رابط معطوب.
     */
    let sealed: string | null = null;
    try {
      sealed = sealPayload('login', user.id, { token }).ciphertext.toString('base64');
    } catch {
      sealed = null;
    }
    await client.query(
      `insert into notification_outbox (user_id, channel, recipient, template, payload, dedupe_key)
       values ($1, 'email', $2, 'auth.password_reset', $3::jsonb, $4)
       on conflict (dedupe_key) do nothing`,
      [
        user.id,
        normalized,
        JSON.stringify({ expiresAt: expiresAt.toISOString(), sealed }),
        `reset:${user.id}:${expiresAt.toISOString()}`,
      ],
    );
    await recordAudit(
      {
        action: 'auth.password_reset_requested',
        actorUserId: user.id,
        actorRole: 'user',
        targetType: 'user',
        targetId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
      client,
    );
  });
  return env.DEV_EXPOSE_RESET_TOKEN && env.NODE_ENV !== 'production' ? { devToken: token } : {};
}

export async function resetPassword(
  input: { token: string; password: string },
  ctx: RequestContext,
): Promise<void> {
  const policyError = validatePasswordStrength(input.password);
  if (policyError) throw conflict('weak_password', passwordErrorMessage(policyError));
  const tokenHash = hashToken(input.token);
  const res = await query<{ id: string; user_id: string }>(
    `select id, user_id from password_reset_tokens
      where token_hash = $1 and used_at is null and invalidated_at is null and expires_at > now()`,
    [tokenHash],
  );
  const row = res.rows[0];
  if (!row) {
    await recordAudit({
      action: 'auth.password_reset',
      outcome: 'failure',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'invalid_token' },
    });
    throw unauthorized('رمز الاستعادة غير صالح أو منتهي. اطلب رمزاً جديداً.');
  }
  const passwordHash = await hashPassword(input.password);
  await withTransaction(async (client) => {
    await client.query(
      'update users set password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = null where id = $1',
      [row.user_id, passwordHash],
    );
    await client.query('update password_reset_tokens set used_at = now() where id = $1', [row.id]);
    await client.query(
      'update password_reset_tokens set invalidated_at = now() where user_id = $1 and used_at is null and invalidated_at is null',
      [row.user_id],
    );
    await client.query(
      `update user_sessions set revoked_at = now(), revoked_reason = 'password_reset'
        where user_id = $1 and revoked_at is null`,
      [row.user_id],
    );
    await recordAudit(
      {
        action: 'auth.password_reset',
        actorUserId: row.user_id,
        targetType: 'user',
        targetId: row.user_id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
      client,
    );
  });
}

export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string },
  ctx: RequestContext & { sessionId: string },
): Promise<void> {
  const policyError = validatePasswordStrength(input.newPassword);
  if (policyError) throw conflict('weak_password', passwordErrorMessage(policyError));
  const res = await query<{ password_hash: string }>('select password_hash from users where id = $1', [userId]);
  const current = res.rows[0];
  if (!current) throw unauthorized();
  const ok = await verifyPassword(input.currentPassword, current.password_hash);
  if (!ok) {
    await recordAudit({
      action: 'user.password_change',
      outcome: 'failure',
      actorUserId: userId,
      targetType: 'user',
      targetId: userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    throw forbidden('كلمة المرور الحالية غير صحيحة.');
  }
  const newHash = await hashPassword(input.newPassword);
  await withTransaction(async (client) => {
    await client.query('update users set password_hash = $2, password_changed_at = now() where id = $1', [
      userId,
      newHash,
    ]);
    await client.query(
      `update user_sessions set revoked_at = now(), revoked_reason = 'password_change'
        where user_id = $1 and revoked_at is null and id <> $2`,
      [userId, ctx.sessionId],
    );
    await recordAudit(
      {
        action: 'user.password_change',
        actorUserId: userId,
        targetType: 'user',
        targetId: userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
      client,
    );
  });
}
