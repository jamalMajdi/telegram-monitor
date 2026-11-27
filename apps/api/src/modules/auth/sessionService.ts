/**
 * جلسات الويب: رمز عشوائي عشوائي 256 بت يُخزَّن منه SHA-256 فقط،
 * مع رمز CSRF مستقل لكل جلسة، وانتهاء خامل + انتهاء مطلق.
 * الجلسة منفصلة تماماً عن جلسات MTProto (تُنفَّذ في مرحلة لاحقة).
 */
import type { Request, Response } from 'express';
import { env, sessionCookieSameSite, sessionCookieSecure } from '../../config/env.js';
import { query, withTransaction } from '../../db/pool.js';
import { hashToken, randomToken } from '../../lib/tokens.js';

export interface SessionRow {
  id: string;
  user_id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
}

const IDLE_MS = env.SESSION_IDLE_MINUTES * 60_000;
const ABSOLUTE_MS = env.SESSION_ABSOLUTE_HOURS * 3_600_000;
const TOUCH_INTERVAL_MS = 60_000;

export interface IssuedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(input: {
  userId: string;
  userAgent: string | null;
  ip: string | null;
}): Promise<IssuedSession> {
  const token = randomToken(32);
  const csrfToken = randomToken(32);
  const now = Date.now();
  const expiresAt = new Date(now + IDLE_MS);
  const absoluteExpiresAt = new Date(now + ABSOLUTE_MS);
  const res = await query<{ id: string }>(
    `insert into user_sessions
       (user_id, token_hash, csrf_hash, user_agent, ip, expires_at, absolute_expires_at)
     values ($1, $2, $3, $4, $5::inet, $6, $7)
     returning id`,
    [input.userId, hashToken(token), hashToken(csrfToken), input.userAgent, input.ip, expiresAt, absoluteExpiresAt],
  );
  return { sessionId: res.rows[0]!.id, token, csrfToken, expiresAt };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: sessionCookieSameSite,
    secure: sessionCookieSecure,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(env.SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: sessionCookieSameSite,
    secure: sessionCookieSecure,
    path: '/',
  });
}

export function readSessionToken(req: Request): string | null {
  const raw = req.cookies?.[env.SESSION_COOKIE_NAME];
  return typeof raw === 'string' && raw.length > 20 ? raw : null;
}

/**
 * يقرأ رمز جلسة المعاينة من الترويسات (مسار `AUTH_BEARER_FALLBACK` فقط).
 * يدعم ترويستين: `x-session-token` (اسم مخصّص لا تعترضه عادةً وكلاء المعاينة)
 * و`Authorization: Bearer` للتوافق. يُرجع القناة المستخدمة للتشخيص.
 */
export function readPreviewToken(req: Request): { token: string; channel: 'header' | 'authorization' } | null {
  const custom = req.get('x-session-token');
  if (custom && /^[A-Za-z0-9_-]{20,200}$/.test(custom.trim())) {
    return { token: custom.trim(), channel: 'header' };
  }
  const header = req.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/i.exec(header.trim());
  return match?.[1] ? { token: match[1], channel: 'authorization' } : null;
}

export interface ResolvedSession {
  session: SessionRow;
  user: AuthenticatedUser;
  csrfTokenHash: string;
}

/** يتحقق من الجلسة ويطبّق الانتهاء الخامل والمطلق دون تسريب سبب الفشل للعميل. */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const res = await query<{
    id: string;
    user_id: string;
    user_agent: string | null;
    ip: string | null;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
    absolute_expires_at: Date;
    revoked_at: Date | null;
    csrf_hash: string;
    email: string;
    display_name: string;
    role: 'user' | 'admin';
    status: 'active' | 'suspended' | 'deleted';
  }>(
    `select s.id, s.user_id, s.user_agent, s.ip, s.created_at, s.last_seen_at, s.expires_at,
            s.absolute_expires_at, s.revoked_at, s.csrf_hash,
            u.email, u.display_name, u.role, u.status
       from user_sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1`,
    [hashToken(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  const now = Date.now();
  if (row.revoked_at || row.status !== 'active') return null;
  if (row.expires_at.getTime() <= now || row.absolute_expires_at.getTime() <= now) return null;

  // تمديد خامل محدود بالانتهاء المطلق، مع تقليل الكتابة إلى مرة كل دقيقة.
  if (now - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
    const nextExpiry = new Date(Math.min(now + IDLE_MS, row.absolute_expires_at.getTime()));
    await query(
      'update user_sessions set last_seen_at = now(), expires_at = $2 where id = $1 and revoked_at is null',
      [row.id, nextExpiry],
    );
    row.expires_at = nextExpiry;
  }

  return {
    session: {
      id: row.id,
      user_id: row.user_id,
      user_agent: row.user_agent,
      ip: row.ip,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      expires_at: row.expires_at,
      absolute_expires_at: row.absolute_expires_at,
      revoked_at: row.revoked_at,
    },
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
    },
    csrfTokenHash: row.csrf_hash,
  };
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await query(
    'update user_sessions set revoked_at = now(), revoked_reason = $2 where id = $1 and revoked_at is null',
    [sessionId, reason],
  );
}

/** إبطال كل جلسات مستخدم؛ يُستخدم عند تغيير كلمة المرور أو تعليق الحساب. */
export async function revokeAllSessions(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const res = await query(
    `update user_sessions
        set revoked_at = now(), revoked_reason = $2
      where user_id = $1 and revoked_at is null and ($3::uuid is null or id <> $3::uuid)`,
    [userId, reason, exceptSessionId ?? null],
  );
  return res.rowCount ?? 0;
}

export async function listSessions(userId: string, currentSessionId: string) {
  const res = await query<{
    id: string;
    user_agent: string | null;
    ip: string | null;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
    current: boolean;
  }>(
    `select id, user_agent, ip, created_at, last_seen_at, expires_at, revoked_at,
            (id = $2::uuid) as current
       from user_sessions
      where user_id = $1 and revoked_at is null and expires_at > now()
      order by last_seen_at desc`,
    [userId, currentSessionId],
  );
  return res.rows;
}

/** تنظيف الجلسات المنتهية (يُستدعى دورياً من عامل الصيانة في مرحلة لاحقة أو من مسار إداري). */
export async function purgeExpiredSessions(): Promise<number> {
  const res = await withTransaction(async (client) => {
    const deleted = await client.query(
      'delete from user_sessions where absolute_expires_at < now() or (revoked_at is not null and revoked_at < now() - interval \'7 days\')',
    );
    return deleted.rowCount ?? 0;
  });
  return res;
}
