/**
 * مسار الخط الزمني الموحّد للرسالة (P4-هـ).
 *
 * GET /api/v1/telegram/results/:identityId/journey — مالك الرسالة فقط.
 * الاستجابة تجمع الحالات الثلاث بصراحة (`states`) مع خط زمني واحد، بلا أي محتوى تواصل خام.
 */
import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../lib/http.js';
import { currentAuth, requireAuth } from '../../middleware/auth.js';
import { JourneyRepository } from './journeyRepository.js';

export function createJourneyRouter(repository: JourneyRepository = new JourneyRepository()): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/results/:identityId/journey',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const identityId = z.string().uuid().parse(req.params.identityId);
      const journey = await repository.load(auth.user.id, identityId);
      if (!journey) throw notFound('الرسالة غير موجودة أو لا تملك صلاحية الوصول إليها.');
      res.json({ journey });
    }),
  );

  return router;
}
