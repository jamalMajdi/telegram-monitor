/**
 * مسارات إدارة حسابات تيليجرام (تحت /api/v1/telegram).
 * كل المسارات تتطلب جلسة مستخدم مصادقاً عليها، وتُحمى من CSRF في طبقة التطبيق،
 * ولا تُرجع أي بيانات جلسة أو رمز أو رقم هاتف كامل.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { recordAudit } from '../../lib/audit.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { asyncHandler, clientIp, parseBody } from '../../lib/http.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { currentAuth, requireAuth } from '../../middleware/auth.js';
import type { TelegramRuntime } from './runtime.js';

const uuidSchema = z.string().uuid({ message: 'معرّف الحساب غير صالح.' });

const startSchema = z.object({
  phoneNumber: z
    .string()
    .trim()
    .min(8, { message: 'رقم الهاتف قصير جداً.' })
    .max(20, { message: 'رقم الهاتف طويل جداً.' }),
  label: z.string().trim().min(2).max(120).optional(),
});

const verifySchema = z.object({
  code: z
    .string()
    .trim()
    .min(3, { message: 'رمز الدخول غير صالح.' })
    .max(12, { message: 'رمز الدخول غير صالح.' })
    .regex(/^\d+$/, { message: 'رمز الدخول يتكوّن من أرقام فقط.' }),
});

const passwordSchema = z.object({
  password: z.string().min(1, { message: 'أدخل كلمة مرور التحقق بخطوتين.' }).max(200),
});

const reauthSchema = z.object({ phoneNumber: startSchema.shape.phoneNumber });

function accountIdOf(req: Request): string {
  // parseBody يحوّل أخطاء zod إلى 400 عربية بدل 500.
  return parseBody(uuidSchema, req.params.accountId);
}

function auditMeta(req: Request): { ip: string | null } {
  return { ip: clientIp(req) };
}

export function createTelegramRouter(runtime: TelegramRuntime): Router {
  const router = Router();
  router.use(requireAuth);

  const startLimiter = rateLimit({
    windowMs: 10 * 60_000,
    max: 5,
    message: 'عدد محاولات بدء الربط كبير. انتظر ثم حاول مجدداً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });
  const verifyLimiter = rateLimit({
    windowMs: 5 * 60_000,
    max: 15,
    message: 'عدد محاولات إدخال الرمز كبير. انتظر ثم حاول مجدداً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });
  const resendLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 5,
    message: 'عدد طلبات إعادة إرسال الرمز كبير. انتظر ثم حاول مجدداً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });
  const passwordLimiter = rateLimit({
    windowMs: 5 * 60_000,
    max: 10,
    message: 'عدد محاولات كلمة المرور كبير. انتظر ثم حاول مجدداً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });
  const actionLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    message: 'عدد الطلبات كبير. انتظر قليلاً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });

  /** حالة التكامل: تُستدعى قبل أي عملية ربط لتفادي اتخاذ إجراء على تكامل غير مهيأ. */
  const requireReady = (): void => {
    if (!runtime.ready) {
      throw new ApiError(
        503,
        'telegram_not_configured',
        'تكامل تيليجرام غير مهيأ على الخادم؛ تكوين بيانات التطبيق ومفتاح التشفير مطلوب من مسؤول النظام.',
      );
    }
  };

  router.get(
    '/status',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      void auth;
      res.json({
        ready: runtime.ready,
        library: { name: runtime.gateway.libraryName, version: runtime.gateway.libraryVersion },
        accounts: (await runtime.logins.listAccounts(currentAuth(req).user.id)).length,
      });
    }),
  );

  router.get(
    '/accounts',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ accounts: await runtime.logins.listAccounts(auth.user.id), ready: runtime.ready });
    }),
  );

  router.get(
    '/accounts/:accountId',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ account: await runtime.logins.getAccount(auth.user.id, accountIdOf(req)) });
    }),
  );

  router.post(
    '/accounts',
    startLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      requireReady();
      const body = parseBody(startSchema, req.body);
      const challenge = await runtime.logins.startLink({
        userId: auth.user.id,
        phoneNumber: body.phoneNumber,
        label: body.label,
      });
      const account = await runtime.logins.getAccount(auth.user.id, challenge.accountId);
      res.status(201).json({ account, challenge });
    }),
  );

  router.post(
    '/accounts/:accountId/reauth',
    startLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      requireReady();
      const body = parseBody(reauthSchema, req.body);
      const challenge = await runtime.logins.startLink({
        userId: auth.user.id,
        phoneNumber: body.phoneNumber,
        accountId: accountIdOf(req),
      });
      res.status(201).json({ challenge });
    }),
  );

  router.post(
    '/accounts/:accountId/code',
    resendLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      requireReady();
      const challenge = await runtime.logins.resendCode({
        userId: auth.user.id,
        accountId: accountIdOf(req),
      });
      res.json({ challenge });
    }),
  );

  router.post(
    '/accounts/:accountId/verify',
    verifyLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      requireReady();
      const body = parseBody(verifySchema, req.body);
      const result = await runtime.logins.verifyCode({
        userId: auth.user.id,
        accountId: accountIdOf(req),
        code: body.code,
      });
      if (result.status === 'password_required') {
        res.json({ status: 'password_required', challenge: result });
        return;
      }
      const account = await runtime.logins.getAccount(auth.user.id, accountIdOf(req));
      res.json({ status: 'linked', account });
    }),
  );

  router.post(
    '/accounts/:accountId/password',
    passwordLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      requireReady();
      const body = parseBody(passwordSchema, req.body);
      await runtime.logins.submitPassword({
        userId: auth.user.id,
        accountId: accountIdOf(req),
        password: body.password,
      });
      const account = await runtime.logins.getAccount(auth.user.id, accountIdOf(req));
      res.json({ status: 'linked', account });
    }),
  );

  router.post(
    '/accounts/:accountId/cancel',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      await runtime.logins.cancelLink({ userId: auth.user.id, accountId: accountIdOf(req) });
      res.status(204).end();
    }),
  );

  router.post(
    '/accounts/:accountId/connect',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      requireReady();
      const accountId = accountIdOf(req);
      const owned = await runtime.accounts.findOwned(accountId, auth.user.id);
      if (!owned) throw notFound('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.');
      if (owned.status === 'suspended' || owned.status === 'revoked') {
        throw new ApiError(409, 'account_not_connectable', 'لا يمكن توصيل هذا الحساب في حالته الحالية.');
      }
      await recordAudit({
        action: 'telegram.connect_requested',
        actorUserId: auth.user.id,
        targetType: 'telegram_account',
        targetId: accountId,
        outcome: 'success',
        ...auditMeta(req),
      });
      // مدير الاتصالات يمنع أي اتصال مكرر للحساب نفسه ويعيد الحالة القائمة إن كانت متصلة.
      await runtime.manager.connect(accountId, auth.user.id);
      res.json({ account: await runtime.logins.getAccount(auth.user.id, accountId) });
    }),
  );

  router.post(
    '/accounts/:accountId/disconnect',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const accountId = accountIdOf(req);
      const owned = await runtime.accounts.findOwned(accountId, auth.user.id);
      if (!owned) throw notFound('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.');
      await runtime.manager.disconnect(accountId, 'manual');
      await recordAudit({
        action: 'telegram.disconnect_requested',
        actorUserId: auth.user.id,
        targetType: 'telegram_account',
        targetId: accountId,
        outcome: 'success',
        ...auditMeta(req),
      });
      res.json({ account: await runtime.logins.getAccount(auth.user.id, accountId) });
    }),
  );

  router.delete(
    '/accounts/:accountId',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      await runtime.logins.unlinkAccount({ userId: auth.user.id, accountId: accountIdOf(req) });
      res.status(204).end();
    }),
  );

  return router;
}
