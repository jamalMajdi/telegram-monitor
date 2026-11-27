import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { ApiError, badRequest } from './errors.js';

/** غلاف للمعالجات غير المتزامنة لتمرير الأخطاء إلى معالج الأخطاء الموحّد. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res, next).catch(next);
  };

/** تحقق من جسم الطلب بمخطط zod وإرجاع قيمة منظّفة. */
export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      throw badRequest(
        'validation_error',
        'بيانات الطلب غير صالحة.',
        err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      );
    }
    throw err;
  }
}

export function parseQuery<T>(schema: ZodSchema<T>, query: unknown): T {
  return parseBody(schema, query);
}

/** استخراج عنوان IP الحقيقي خلف وكيل واحد فقط عند تفعيل الثقة الصريحة. */
export function clientIp(req: Request): string | null {
  const value = req.ip ?? req.socket.remoteAddress ?? null;
  if (!value) return null;
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

export function userAgent(req: Request): string | null {
  const value = req.get('user-agent');
  return value ? value.slice(0, 400) : null;
}

export function sendError(res: Response, err: unknown): void {
  if (err instanceof ApiError) {
    const extra: Record<string, unknown> = {};
    const retryAfter = (err as ApiError & { retryAfterSeconds?: number }).retryAfterSeconds;
    if (retryAfter) {
      extra.retryAfterSeconds = retryAfter;
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
    }
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), ...extra },
    });
    return;
  }
  throw err;
}
