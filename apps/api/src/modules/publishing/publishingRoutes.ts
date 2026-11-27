/**
 * واجهات النشر (الدفعة 7-أ/7-ب) تحت /api/v1/telegram/publish.
 *
 * - كل المسارات تتطلب مستخدماً مصادقاً، وتعمل داخل مساحة مالكها فقط.
 * - لا يعود أي رمز بوت أو مغلّف مشفّر في أي استجابة (حتى في الأخطاء).
 * - رفض الحلقة يُعاد كرمز واحد محايد `routing_cycle_detected` بلا تفاصيل مسارات الغير.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp, parseBody, parseQuery } from '../../lib/http.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { currentAuth, requireAuth } from '../../middleware/auth.js';
import type { PublishingRuntime } from './runtime.js';

const uuidSchema = z.string().uuid({ message: 'المعرّف غير صالح.' });

const botConnectSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  token: z.string().trim().min(20).max(120),
});

const destinationAddSchema = z.object({
  identifier: z.string().trim().min(2).max(200),
});

const routeScopeSchema = z.object({
  kind: z.enum(['source', 'filter', 'classification']),
  targetId: uuidSchema,
});

const routeInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  destinationId: uuidSchema,
  scopes: z.array(routeScopeSchema).min(1).max(50),
  templateId: uuidSchema.nullish(),
  publishMode: z.enum(['auto', 'review']).optional(),
  lengthPolicy: z.enum(['split', 'reject']).optional(),
  maxParts: z.coerce.number().int().min(1).max(50).optional(),
  /** تجاوز هوية المصدر/المرسل لهذا المسار؛ null = يتبع إعداد المستخدم العام. */
  attributionMode: z.enum(['off', 'source', 'sender', 'both']).nullish(),
});

const deliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const rejectSchema = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
});

const evidenceSchema = z.object({
  method: z.enum(['message_id', 'manual_check']),
  decision: z.enum(['published', 'not_published']),
  telegramMessageId: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/, { message: 'معرّف الرسالة غير صالح.' })
    .optional(),
  note: z.string().trim().max(200).optional(),
});

function idParam(req: Request, name: string): string {
  return parseBody(uuidSchema, (req.params as Record<string, string>)[name]);
}

export function createPublishingRouter(runtime: PublishingRuntime): Router {
  const router = Router();
  router.use(requireAuth);

  const actionLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    message: 'عدد طلبات النشر كبير. انتظر قليلاً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    message: 'عدد تعديلات إعدادات النشر كبير. انتظر قليلاً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });

  // ── الحالة العامة ────────────────────────────────────────────────────────
  router.get(
    '/publish/status',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json(await runtime.status(auth.user.id));
    }),
  );

  // ── البوت ────────────────────────────────────────────────────────────────
  router.get(
    '/publish/bot',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ bot: await runtime.bots.view(auth.user.id), ready: runtime.ready, reason: runtime.reason });
    }),
  );

  router.post(
    '/publish/bot',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(botConnectSchema, req.body);
      const bot = await runtime.bots.connect({
        userId: auth.user.id,
        token: body.token,
        ...(body.label !== undefined ? { label: body.label } : {}),
        ip: clientIp(req),
      });
      res.status(201).json({ bot });
    }),
  );

  router.post(
    '/publish/bot/verify',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ bot: await runtime.bots.verify({ userId: auth.user.id, ip: clientIp(req) }) });
    }),
  );

  router.delete(
    '/publish/bot',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      await runtime.bots.disable({ userId: auth.user.id, ip: clientIp(req) });
      res.status(204).end();
    }),
  );

  // ── الوجهات ──────────────────────────────────────────────────────────────
  router.get(
    '/publish/destinations',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ destinations: await runtime.destinations.list(auth.user.id) });
    }),
  );

  router.post(
    '/publish/destinations',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(destinationAddSchema, req.body);
      const destination = await runtime.destinations.add({
        userId: auth.user.id,
        identifier: body.identifier,
        ip: clientIp(req),
      });
      res.status(201).json({ destination });
    }),
  );

  router.post(
    '/publish/destinations/:destinationId/verify',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const destination = await runtime.destinations.verify({
        userId: auth.user.id,
        destinationId: idParam(req, 'destinationId'),
        ip: clientIp(req),
      });
      res.json({ destination });
    }),
  );

  router.post(
    '/publish/destinations/:destinationId/pause',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const destination = await runtime.destinations.pause({
        userId: auth.user.id,
        destinationId: idParam(req, 'destinationId'),
        ip: clientIp(req),
      });
      res.json({ destination });
    }),
  );

  router.post(
    '/publish/destinations/:destinationId/resume',
    actionLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const destination = await runtime.destinations.resume({
        userId: auth.user.id,
        destinationId: idParam(req, 'destinationId'),
        ip: clientIp(req),
      });
      res.json({ destination });
    }),
  );

  router.delete(
    '/publish/destinations/:destinationId',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      await runtime.destinations.remove({
        userId: auth.user.id,
        destinationId: idParam(req, 'destinationId'),
        ip: clientIp(req),
      });
      res.status(204).end();
    }),
  );

  // ── المسارات ─────────────────────────────────────────────────────────────
  router.get(
    '/publish/routes',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ routes: await runtime.routes.list(auth.user.id) });
    }),
  );

  router.post(
    '/publish/routes',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(routeInputSchema, req.body);
      const route = await runtime.routes.create({
        userId: auth.user.id,
        route: {
          name: body.name,
          destinationId: body.destinationId,
          scopes: body.scopes,
          templateId: body.templateId ?? null,
          ...(body.publishMode ? { publishMode: body.publishMode } : {}),
          ...(body.lengthPolicy ? { lengthPolicy: body.lengthPolicy } : {}),
          ...(body.maxParts ? { maxParts: body.maxParts } : {}),
          attributionMode: body.attributionMode ?? null,
        },
        ip: clientIp(req),
      });
      res.status(201).json({ route });
    }),
  );

  router.get(
    '/publish/routes/:routeId',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ route: await runtime.routes.get(auth.user.id, idParam(req, 'routeId')) });
    }),
  );

  router.patch(
    '/publish/routes/:routeId',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(routeInputSchema, req.body);
      const route = await runtime.routes.update({
        userId: auth.user.id,
        routeId: idParam(req, 'routeId'),
        route: {
          name: body.name,
          destinationId: body.destinationId,
          scopes: body.scopes,
          templateId: body.templateId ?? null,
          ...(body.publishMode ? { publishMode: body.publishMode } : {}),
          ...(body.lengthPolicy ? { lengthPolicy: body.lengthPolicy } : {}),
          ...(body.maxParts ? { maxParts: body.maxParts } : {}),
          attributionMode: body.attributionMode ?? null,
        },
        ip: clientIp(req),
      });
      res.json({ route });
    }),
  );

  router.post(
    '/publish/routes/:routeId/activate',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const route = await runtime.routes.activate({
        userId: auth.user.id,
        routeId: idParam(req, 'routeId'),
        ip: clientIp(req),
      });
      res.json({ route });
    }),
  );

  router.post(
    '/publish/routes/:routeId/deactivate',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const route = await runtime.routes.deactivate({
        userId: auth.user.id,
        routeId: idParam(req, 'routeId'),
        ip: clientIp(req),
      });
      res.json({ route });
    }),
  );

  router.delete(
    '/publish/routes/:routeId',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      await runtime.routes.remove({
        userId: auth.user.id,
        routeId: idParam(req, 'routeId'),
        ip: clientIp(req),
      });
      res.status(204).end();
    }),
  );

  // ── سجل النشر (قراءة فقط في هذه الدفعة) ──────────────────────────────────
  router.get(
    '/publish/deliveries',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const query = parseQuery(deliveriesQuerySchema, req.query);
      res.json({ deliveries: await runtime.listDeliveries(auth.user.id, query.limit ?? 30) });
    }),
  );

  // ── تفصيل التسليم والمراجعة البشرية وتسوية المجهول (7-د) ─────────────────
  router.get(
    '/publish/deliveries/:deliveryId',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ delivery: await runtime.deliveries.detail(idParam(req, 'deliveryId'), auth.user.id) });
    }),
  );

  router.post(
    '/publish/deliveries/:deliveryId/approve',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const delivery = await runtime.deliveries.approve({
        userId: auth.user.id,
        deliveryId: idParam(req, 'deliveryId'),
        ip: clientIp(req),
      });
      res.json({ delivery });
    }),
  );

  router.post(
    '/publish/deliveries/:deliveryId/reject',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(rejectSchema, req.body ?? {});
      const delivery = await runtime.deliveries.reject({
        userId: auth.user.id,
        deliveryId: idParam(req, 'deliveryId'),
        reason: body.reason ?? null,
        ip: clientIp(req),
      });
      res.json({ delivery });
    }),
  );

  // O04: دليل بشري على نتيجة مجهولة — لا إعادة إرسال تلقائية في أي حال.
  /**
   * إعادة النشر (P4-هـ، Q20): إعادة تخطيط لخطة جديدة. ممنوعة على `uncertain`، وسقفها 3.
   * الرفض يحمل رمزاً صريحاً (409) يشرح السبب والبديل.
   */
  router.post(
    '/publish/deliveries/:deliveryId/republish',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const delivery = await runtime.deliveries.republish({
        userId: auth.user.id,
        deliveryId: idParam(req, 'deliveryId'),
        ip: clientIp(req),
      });
      res.json({ delivery });
    }),
  );

  router.post(
    '/publish/deliveries/:deliveryId/evidence',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(evidenceSchema, req.body ?? {});
      const delivery = await runtime.deliveries.evidence({
        userId: auth.user.id,
        deliveryId: idParam(req, 'deliveryId'),
        data: {
          method: body.method,
          decision: body.decision,
          telegramMessageId: body.telegramMessageId ?? null,
          note: body.note ?? null,
        },
        ip: clientIp(req),
      });
      res.json({ delivery });
    }),
  );

  return router;
}
