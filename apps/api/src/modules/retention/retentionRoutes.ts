/**
 * واجهات الاحتفاظ للمدير (P4-د): تشغيل دورة الآن وقراءة سجل التشغيلات.
 *
 * لا تُعرَّض أي سياسة للتعديل من هنا؛ المدد تُقرأ من `system_settings` (المصدر الوحيد للحقيقة)،
 * وكل تشغيل يدوي مدقَّق بسببٍ إلزامي.
 */
import { Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../../lib/audit.js';
import { asyncHandler, clientIp, parseBody, parseQuery, userAgent } from '../../lib/http.js';
import { currentAuth, requireAuth, requireRole } from '../../middleware/auth.js';
import type { RetentionService } from './retentionService.js';

const runSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export function createAdminRetentionRouter(retention: RetentionService): Router {
  const router = Router();
  router.use(requireAuth, requireRole('admin'));

  router.get(
    '/retention/runs',
    asyncHandler(async (req, res) => {
      currentAuth(req);
      const query = parseQuery(listSchema, req.query);
      res.json({ runs: await retention.listRuns(query.limit ?? 25) });
    }),
  );

  router.post(
    '/retention/run',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(runSchema, req.body);
      const result = await retention.runCycle('admin');
      await recordAudit({
        action: 'admin.retention_run',
        actorUserId: auth.user.id,
        actorRole: auth.user.role,
        targetType: 'retention',
        targetId: null,
        ip: clientIp(req),
        userAgent: userAgent(req),
        metadata: {
          reason: body.reason,
          policies: result.runs.map((run) => run.policy),
          totalDeleted: result.totalDeleted,
        },
      });
      res.json({ result });
    }),
  );

  return router;
}
