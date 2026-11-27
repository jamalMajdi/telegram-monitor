/**
 * مسارات إدارة مصادر المراقبة (تحت /api/v1/telegram).
 * كل المسارات تتطلب مستخدم مصادقاً عليه، وتُحمى من CSRF في طبقة التطبيق،
 * ولا تُرجع أي محتوى رسائل أو وسائط أو بيانات جلسة.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody, parseQuery } from '../../lib/http.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { currentAuth, requireAuth } from '../../middleware/auth.js';
import type { TelegramRuntime } from './runtime.js';

const uuidSchema = z.string().uuid({ message: 'المعرّف غير صالح.' });

// معرّف Telegram موجب وداخل نطاق BIGINT الموقّع (19 رقماً كحد أقصى)، ويُبقى نصاً في كل المسار.
const BIGINT_MAX = 9223372036854775807n;
const peerIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, { message: 'معرّف المصدر يجب أن يكون رقماً موجباً.' })
  // الحماية بـtest قبل BigInt: refine قد يُنفَّذ حتى بعد فشل regex على قيمة غير رقمية.
  .refine((value) => (isDigitString(value) ? BigInt(value) <= BIGINT_MAX : true), {
    message: 'معرّف المصدر أكبر من الحد المسموح.',
  });

/** فحص نصي بسيط بلا تحويل إلى Number. */
function isDigitString(value: string): boolean {
  return /^\d+$/.test(value);
}

const addSchema = z
  .object({
    accountId: uuidSchema,
    identifier: z.string().trim().min(3).max(200).optional(),
    peerId: peerIdSchema.optional(),
  })
  .refine((value) => Boolean(value.identifier) !== Boolean(value.peerId), {
    message: 'أرسل إمّا identifier أو peerId (واحداً فقط).',
  });

const settingsSchema = z.object({ includeOwnMessages: z.boolean() });

const availableSchema = z.object({
  accountId: uuidSchema,
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function sourceIdOf(req: Request): string {
  return parseBody(uuidSchema, req.params.sourceId);
}

export function createTelegramSourcesRouter(runtime: TelegramRuntime): Router {
  const router = Router();
  router.use(requireAuth);

  const actionLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    message: 'عدد الطلبات كبير. انتظر قليلاً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });
  const listLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    message: 'عدد طلبات جلب القنوات المتاحة كبير. انتظر قليلاً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });

  router.get(
    '/sources',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ sources: await runtime.sourceService.list(auth.user.id), ready: runtime.ready });
    }),
  );

  router.get(
    '/sources/:sourceId',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ source: await runtime.sourceService.get(auth.user.id, sourceIdOf(req)) });
    }),
  );

  router.get(
    '/accounts/:accountId/sources/available',
    listLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const accountId = parseBody(uuidSchema, req.params.accountId);
      const queryParams = parseQuery(availableSchema, { accountId, limit: req.query.limit });
      const sources = await runtime.sourceService.listAvailable({
        userId: auth.user.id,
        accountId,
        ...(queryParams.limit ? { limit: queryParams.limit } : {}),
      });
      res.json({ sources });
    }),
  );

  router.post(
    '/sources',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(addSchema, req.body);
      const source = body.identifier
        ? await runtime.sourceService.addByIdentifier({
            userId: auth.user.id,
            accountId: body.accountId,
            identifier: body.identifier,
          })
        : await runtime.sourceService.addFromAvailable({
            userId: auth.user.id,
            accountId: body.accountId,
            peerId: body.peerId!,
          });
      res.status(201).json({ source });
    }),
  );

  router.patch(
    '/sources/:sourceId',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(settingsSchema, req.body);
      const source = await runtime.sourceService.setIncludeOwnMessages({
        userId: auth.user.id,
        sourceId: sourceIdOf(req),
        value: body.includeOwnMessages,
      });
      res.json({ source });
    }),
  );

  router.post(
    '/sources/:sourceId/pause',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ source: await runtime.sourceService.pause({ userId: auth.user.id, sourceId: sourceIdOf(req) }) });
    }),
  );

  router.post(
    '/sources/:sourceId/resume',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ source: await runtime.sourceService.resume({ userId: auth.user.id, sourceId: sourceIdOf(req) }) });
    }),
  );

  router.post(
    '/sources/:sourceId/refresh',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ source: await runtime.sourceService.refresh({ userId: auth.user.id, sourceId: sourceIdOf(req) }) });
    }),
  );

  router.delete(
    '/sources/:sourceId',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      // remove() يتحقق من الملكية ويُطلق notFound للمصادر غير المملوكة.
      await runtime.sourceService.remove({ userId: auth.user.id, sourceId: sourceIdOf(req) });
      res.status(204).end();
    }),
  );

  return router;
}
