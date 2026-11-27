/**
 * واجهات لوحة المستخدم (P4-أ): قراءة فقط، محصورة بمالكها، بلا أي محتوى رسائل.
 *
 * GET /api/v1/dashboard/summary?fresh=1  → عدّادات + تنبيهات
 * GET /api/v1/dashboard/activity?limit=   → آخر العمليات (تدقيق مقنَّع)
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseQuery } from '../../lib/http.js';
import { currentAuth, requireAuth } from '../../middleware/auth.js';
import type { DashboardService } from './dashboardService.js';

const summaryQuerySchema = z.object({
  fresh: z.enum(['0', '1', 'true', 'false']).optional(),
});

const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export function createDashboardRouter(dashboard: DashboardService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/dashboard/summary',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const query = parseQuery(summaryQuerySchema, req.query);
      const fresh = query.fresh === '1' || query.fresh === 'true';
      res.json({ summary: await dashboard.summary(auth.user.id, { fresh }) });
    }),
  );

  router.get(
    '/dashboard/activity',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const query = parseQuery(activityQuerySchema, req.query);
      res.json({ activity: await dashboard.activity(auth.user.id, query.limit ?? 10) });
    }),
  );

  return router;
}
