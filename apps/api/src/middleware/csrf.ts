/**
 * حماية CSRF بطريقة الرمز المزدوج الموثّق في الخادم:
 * يُخزَّن تجزئة رمز مستقل لكل جلسة، ويُرسل الرمز للعميل في استجابة الجلسة فقط،
 * ويُطلب في ترويسة X-CSRF-Token لكل طلب مغيّر للحالة.
 */
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors.js';
import { hashToken, safeEqual } from '../lib/tokens.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  const auth = req.auth;
  if (!auth) return next();
  // جلسة بترويسة Bearer: الترويسة غير قابلة للإرسال التلقائي من موقع آخر ⇒ CSRF غير منطبق.
  if (auth.viaBearer) return next();
  const header = req.get('x-csrf-token');
  if (!header || !safeEqual(hashToken(header), auth.csrfTokenHash)) {
    return next(new ApiError(403, 'csrf_failed', 'رمز الحماية من CSRF مفقود أو غير صالح. أعد تحميل الصفحة.'));
  }
  next();
}
