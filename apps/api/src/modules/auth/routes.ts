import { Router } from 'express';
import { authBearerFallback, env } from '../../config/env.js';
import { z } from 'zod';
import { asyncHandler, clientIp, parseBody, userAgent } from '../../lib/http.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { requireAuth, currentAuth } from '../../middleware/auth.js';
import {
  authenticate,
  changePassword,
  registerUser,
  requestPasswordReset,
  resetPassword,
} from './authService.js';
import {
  clearSessionCookie,
  createSession,
  revokeAllSessions,
  revokeSession,
  setSessionCookie,
} from './sessionService.js';
import { query } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { accountLocked, unauthorized } from '../../lib/errors.js';
import { hashToken, randomToken } from '../../lib/tokens.js';

const emailSchema = z.string().trim().email('صيغة البريد الإلكتروني غير صحيحة.').max(254);
const passwordSchema = z.string().min(1, 'كلمة المرور مطلوبة.').max(200);

const registerSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().min(2, 'الاسم قصير جداً.').max(120, 'الاسم طويل جداً.'),
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

const forgotSchema = z.object({ email: emailSchema });
const resetSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});
const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

const emailKey = (req: { body?: unknown }): string | null => {
  const body = req.body as { email?: unknown } | undefined;
  return typeof body?.email === 'string' ? body.email.trim().toLowerCase() : null;
};

export const authRouter: Router = Router();

/**
 * يُضاف رمز الجلسة إلى جسم الاستجابة فقط في وضع المعاينة (`AUTH_BEARER_FALLBACK=true`)،
 * حين لا يستطيع المتصفح حفظ ملف تعريف httpOnly داخل إطار محجوز.
 */
function bearerField(token: string): { accessToken?: string } {
  return authBearerFallback ? { accessToken: token } : {};
}

authRouter.post(
  '/register',
  rateLimit({ windowMs: 60 * 60_000, max: env.RATE_LIMIT_REGISTER_MAX, message: 'محاولات تسجيل كثيرة. حاول لاحقاً.', keyFrom: emailKey }),
  asyncHandler(async (req, res) => {
    const body = parseBody(registerSchema, req.body);
    const user = await registerUser(body, { ip: clientIp(req), userAgent: userAgent(req) });
    const session = await createSession({ userId: user.id, userAgent: userAgent(req), ip: clientIp(req) });
    setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ user, csrfToken: session.csrfToken, ...bearerField(session.token) });
  }),
);

authRouter.post(
  '/login',
  rateLimit({ windowMs: 15 * 60_000, max: env.RATE_LIMIT_LOGIN_MAX, message: 'محاولات دخول كثيرة من هذا الجهاز. حاول لاحقاً.', keyFrom: emailKey }),
  asyncHandler(async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const result = await authenticate(body, { ip: clientIp(req), userAgent: userAgent(req) });
    if ('failure' in result) {
      if (result.failure.kind === 'locked') {
        throw accountLocked(
          'تم قفل المحاولات مؤقتاً بسبب تكرار كلمة مرور غير صحيحة. حاول لاحقاً أو استعد كلمة المرور.',
          result.failure.retryAfterSeconds,
        );
      }
      if (result.failure.kind === 'suspended') throw unauthorized('الحساب موقوف. تواصل مع مدير النظام.');
      if (result.failure.kind === 'deleted') throw unauthorized();
      throw unauthorized('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
    }
    const session = await createSession({
      userId: result.user.id,
      userAgent: userAgent(req),
      ip: clientIp(req),
    });
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({ user: result.user, csrfToken: session.csrfToken, ...bearerField(session.token) });
  }),
);

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    await revokeSession(auth.sessionId, 'logout');
    await recordAudit({
      action: 'auth.logout',
      actorUserId: auth.user.id,
      actorRole: auth.user.role,
      ip: clientIp(req),
      userAgent: userAgent(req),
    });
    clearSessionCookie(res);
    res.status(204).end();
  }),
);

/**
 * حالة الجلسة الحالية. يُصدر رمز CSRF جديداً لهذه الجلسة ويعيده للعميل،
 * لأن الخادم يحفظ بصمة الرمز فقط ولا يستطيع إعادة عرض رمز سابق.
 */
authRouter.get(
  '/session',
  asyncHandler(async (req, res) => {
    if (!req.auth) {
      res.json({ authenticated: false });
      return;
    }
    const csrfToken = randomToken(32);
    await query('update user_sessions set csrf_hash = $2 where id = $1', [
      req.auth.sessionId,
      hashToken(csrfToken),
    ]);
    res.json({ authenticated: true, user: req.auth.user, csrfToken });
  }),
);

authRouter.post(
  '/password/forgot',
  rateLimit({ windowMs: 60 * 60_000, max: env.RATE_LIMIT_FORGOT_MAX, message: 'طلبات استعادة كثيرة. حاول لاحقاً.', keyFrom: emailKey }),
  asyncHandler(async (req, res) => {
    const body = parseBody(forgotSchema, req.body);
    const result = await requestPasswordReset(body.email, { ip: clientIp(req), userAgent: userAgent(req) });
    res.status(202).json({
      message: 'إذا كان البريد مسجّلاً فسيُرسل إليه رمز الاستعادة.',
      ...(result.devToken ? { devResetToken: result.devToken } : {}),
    });
  }),
);

authRouter.post(
  '/password/reset',
  rateLimit({ windowMs: 60 * 60_000, max: env.RATE_LIMIT_RESET_MAX, message: 'محاولات استعادة كثيرة. حاول لاحقاً.' }),
  asyncHandler(async (req, res) => {
    const body = parseBody(resetSchema, req.body);
    await resetPassword(body, { ip: clientIp(req), userAgent: userAgent(req) });
    clearSessionCookie(res);
    res.status(204).end();
  }),
);

authRouter.post(
  '/password/change',
  requireAuth,
  rateLimit({ windowMs: 15 * 60_000, max: 10, message: 'محاولات كثيرة. حاول لاحقاً.' }),
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const body = parseBody(changePasswordSchema, req.body);
    await changePassword(auth.user.id, body, {
      ip: clientIp(req),
      userAgent: userAgent(req),
      sessionId: auth.sessionId,
    });
    res.status(204).end();
  }),
);

authRouter.post(
  '/sessions/revoke-others',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const count = await revokeAllSessions(auth.user.id, 'user_revoked_others', auth.sessionId);
    await recordAudit({
      action: 'user.sessions_revoked',
      actorUserId: auth.user.id,
      actorRole: auth.user.role,
      ip: clientIp(req),
      userAgent: userAgent(req),
      metadata: { revoked: count, scope: 'others' },
    });
    res.json({ revoked: count });
  }),
);
