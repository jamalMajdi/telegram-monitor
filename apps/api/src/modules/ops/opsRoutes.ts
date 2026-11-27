/**
 * واجهات التشغيل (P4-ب).
 *
 * - `/healthz`: حياة العملية — عامة، بلا تفاصيل (لـsystemd/nginx).
 * - `/readyz`: جهوزية التبعيات — عامة بملخص مختصر (DB + عامل + طابور) بلا أي تفاصيل داخلية.
 * - `/admin/metrics`: المقاييس التفصيلية — للمدير فقط (Q17).
 */
import { Router } from 'express';
import { asyncHandler } from '../../lib/http.js';
import { currentAuth, requireAuth, requireRole } from '../../middleware/auth.js';
import { logger } from '../../lib/logger.js';
import type { OpsService } from './opsService.js';

/** مسارات عامة تُركَّب قبل المصادقة (فحص حياة/جهوزية فقط). */
export function createPublicOpsRouter(ops: OpsService): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'tg-api', checkedAt: new Date().toISOString() });
  });

  router.get(
    '/readyz',
    asyncHandler(async (_req, res) => {
      const report = await ops.readiness();
      const body = {
        status: report.status,
        database: { ok: report.database.ok, latencyMs: report.database.latencyMs },
        publishWorker: report.publishWorker,
        queue: report.queue,
        checkedAt: report.checkedAt,
      };
      if (report.status !== 'ok') {
        logger.warn({ status: report.status }, 'فحص الجهوزية أعاد حالة منخفضة');
        res.status(503).json(body);
        return;
      }
      res.json(body);
    }),
  );

  return router;
}

/** مقاييس المدير: تُركَّب تحت /api/v1/admin بمصادقة ودور إداري. */
export function createAdminOpsRouter(ops: OpsService): Router {
  const router = Router();
  router.use(requireAuth, requireRole('admin'));

  router.get(
    '/metrics',
    asyncHandler(async (req, res) => {
      currentAuth(req);
      res.json({ metrics: await ops.metrics() });
    }),
  );

  return router;
}
