/**
 * مسارات حالة الالتقاط (الخطوة الرابعة) — قراءة فقط، بلا أي محتوى رسائل.
 * كل استجابة مقيّدة بمالك الحساب، ولا تُسرّب أسماء محادثات غير مراقبة.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { currentAuth, requireAuth } from '../../middleware/auth.js';
import type { TelegramRuntime } from './runtime.js';

const uuidSchema = z.string().uuid({ message: 'المعرّف غير صالح.' });

export function createTelegramIngestRouter(runtime: TelegramRuntime): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/ingest/status',
    asyncHandler(async (req: Request, res) => {
      const auth = currentAuth(req);
      res.json(await runtime.ingest.status(auth.user.id));
    }),
  );

  router.get(
    '/sources/:sourceId/ingest',
    asyncHandler(async (req: Request, res) => {
      const auth = currentAuth(req);
      const sourceId = parseBody(uuidSchema, req.params.sourceId);
      const stats = await runtime.ingest.sourceStats({ userId: auth.user.id, sourceId });
      if (!stats) throw notFound('المصدر غير موجود أو لا تملك صلاحية الوصول إليه.');
      res.json({ source: stats });
    }),
  );

  return router;
}
