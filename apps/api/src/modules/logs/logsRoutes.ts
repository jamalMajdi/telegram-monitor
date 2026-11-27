/**
 * واجهات السجلات والأخطاء (P4-ج).
 *
 * GET /api/v1/logs            → سجلّات المالك فقط (بلا أي صف لغيره)
 * GET /api/v1/admin/errors    → تجميع أخطاء النظام للمدير: أعداد وأنواع، بلا هوية مستخدم وبلا تفاصيل
 *
 * لا استجابة هنا تحمل نص رسالة أو رقم تواصل أو رمزاً — والمخطط نفسه يمنع وجودها في الجدول.
 */
import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { asyncHandler, parseQuery } from '../../lib/http.js';
import { currentAuth, requireAuth, requireRole } from '../../middleware/auth.js';
import { decodeCursor, LogsService } from './logsService.js';
import type { LogsStore } from './logsRepository.js';

const SCOPES = ['telegram', 'processing', 'publishing', 'auth', 'system'] as const;
const SEVERITIES = ['warn', 'error', 'critical'] as const;

const listSchema = z.object({
  scope: z.enum(SCOPES).optional(),
  kind: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{2,40}$/)
    .optional(),
  severity: z.enum(SEVERITIES).optional(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_]{1,40}$/)
    .optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const adminSchema = z.object({
  scope: z.enum(SCOPES).optional(),
  windowHours: z.coerce.number().int().min(1).max(720).default(24),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function createUserLogsRouter(store: LogsStore): Router {
  const router = Router();
  const service = new LogsService(store);
  router.use(requireAuth);

  router.get(
    '/logs',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const parsed = parseQuery(listSchema, req.query);
      if (parsed.cursor && decodeCursor(parsed.cursor) === null) {
        throw badRequest('invalid_cursor', 'مؤشِّر الصفحة غير صالح.');
      }
      const page = await service.listForUser(auth.user.id, {
        ...(parsed.scope ? { scope: parsed.scope } : {}),
        ...(parsed.kind ? { kind: parsed.kind } : {}),
        ...(parsed.severity ? { severity: parsed.severity } : {}),
        ...(parsed.code ? { code: parsed.code } : {}),
        ...(parsed.from ? { from: new Date(parsed.from) } : {}),
        ...(parsed.to ? { to: new Date(parsed.to) } : {}),
        ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
        limit: parsed.limit ?? 25,
      });
      res.json(page);
    }),
  );

  return router;
}

/** يُركَّب تحت `/api/v1/admin` بمصادقة ودور إداري (نفس نمط `/admin/metrics`). */
export function createAdminLogsRouter(store: LogsStore): Router {
  const router = Router();
  const service = new LogsService(store);
  router.use(requireAuth, requireRole('admin'));

  router.get(
    '/errors',
    asyncHandler(async (req, res) => {
      currentAuth(req);
      const parsed = parseQuery(adminSchema, req.query);
      res.json({
        errors: await service.adminView({
          windowHours: parsed.windowHours ?? 24,
          ...(parsed.scope ? { scope: parsed.scope } : {}),
          limit: parsed.limit ?? 20,
        }),
      });
    }),
  );

  return router;
}
