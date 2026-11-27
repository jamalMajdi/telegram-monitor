/**
 * واجهات مركز التنبيهات (P4-و).
 *
 * GET  /api/v1/notifications?status=&limit=&cursor=   → صندوق المستخدم فقط (ترقيم مؤشِّر)
 * GET  /api/v1/notifications/counts                   → أعداد جاهزة للشارة (badge)
 * POST /api/v1/notifications/:id/acknowledge          → اعتراف صريح
 * POST /api/v1/notifications/acknowledge-all          → اعتراف بكل النشط
 *
 * كلها تتطلب مصادقة، وREADME منعزلة بـ`user_id` من الجلسة لا من الطلب، والاعتراف مسجَّل في التدقيق.
 */
import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { asyncHandler, parseQuery } from '../../lib/http.js';
import { currentAuth, requireAuth } from '../../middleware/auth.js';
import type { AlertRow } from './notificationsRepository.js';
import type { NotificationService } from './notificationsService.js';

const listQuerySchema = z.object({
  status: z.enum(['open', 'acknowledged', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(200).optional(),
});

function present(row: AlertRow) {
  return {
    id: row.id,
    key: row.alertKey,
    severity: row.severity,
    observedCount: row.observedCount,
    occurrences: row.occurrences,
    payload: row.payload,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

export function createNotificationsRouter(service: NotificationService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/notifications',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const query = parseQuery(listQuerySchema, req.query);
      let result;
      try {
        result = await service.list(auth.user.id, {
          status: query.status,
          limit: query.limit,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'invalid_cursor') {
          res.status(400).json({ error: { code: 'invalid_cursor', message: 'مؤشِّر الترقيم غير صالح.' } });
          return;
        }
        throw err;
      }
      res.json({
        notifications: result.notifications.map(present),
        nextCursor: result.nextCursor,
        limit: result.limit,
      });
    }),
  );

  router.get(
    '/notifications/counts',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      await service.sync(auth.user.id);
      res.json({ counts: await service.counts(auth.user.id) });
    }),
  );

  router.post(
    '/notifications/acknowledge-all',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const acknowledged = await service.acknowledgeAll(auth.user.id);
      await recordAudit({
        actorUserId: auth.user.id,
        action: 'notifications.acknowledged_all',
        targetType: 'alert_notifications',
        outcome: 'success',
        ip: req.ip ?? null,
        metadata: { acknowledged },
      });
      res.json({ acknowledged });
    }),
  );

  router.post(
    '/notifications/:id/acknowledge',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const id = z.string().uuid().parse(req.params.id);
      const row = await service.acknowledge(auth.user.id, id);
      if (!row) throw notFound('التنبيه غير موجود أو حُلّ بالفعل.');
      await recordAudit({
        actorUserId: auth.user.id,
        action: 'notifications.acknowledged',
        targetType: 'alert_notification',
        targetId: row.id,
        outcome: 'success',
        ip: req.ip ?? null,
        metadata: { alertKey: row.alertKey, severity: row.severity },
      });
      res.json({ notification: present(row) });
    }),
  );

  return router;
}
