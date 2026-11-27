import type { NextFunction, Request, Response } from 'express';
import { ApiError, forbidden, unauthorized } from '../lib/errors.js';
import { readPreviewToken, readSessionToken, resolveSession, type AuthenticatedUser } from '../modules/auth/sessionService.js';
import { authBearerFallback } from '../config/env.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: {
      user: AuthenticatedUser;
      sessionId: string;
      csrfTokenHash: string;
      /** الجلسة وصلت بترويسة Bearer لا بملف تعريف ⇒ لا معنى لـCSRF (الترويسة لا تُرسل تلقائياً). */
      viaBearer: boolean;
    };
    /** تشخيص المصادقة: أي قنوات وصلت فعلاً مع الطلب (حضور فقط، بلا قيم). */
    authProbe?: {
      cookie: boolean;
      authorization: boolean;
      sessionHeader: boolean;
      channel: 'cookie' | 'header' | 'authorization' | null;
    };
  }
}

/** يحل جلسة المتصفح من ملف تعريف httpOnly؛ لا تُقبل هوية من جسم الطلب أو ترويسة عميل. */
export async function attachSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const cookieToken = readSessionToken(req);
    const preview = authBearerFallback ? readPreviewToken(req) : null;
    req.authProbe = {
      cookie: cookieToken !== null,
      authorization: Boolean(req.get('authorization')),
      sessionHeader: Boolean(req.get('x-session-token')),
      channel: preview ? preview.channel : cookieToken ? 'cookie' : null,
    };
    const token = preview?.token ?? cookieToken;
    if (!token) return next();
    const resolved = await resolveSession(token);
    if (resolved) {
      req.auth = {
        user: resolved.user,
        sessionId: resolved.session.id,
        csrfTokenHash: resolved.csrfTokenHash,
        viaBearer: preview !== null,
      };
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) return next(unauthorized());
  next();
}

export function requireRole(role: 'admin'): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (req.auth.user.role !== role) {
      return next(forbidden('هذه الصفحة متاحة لمدير النظام فقط.'));
    }
    next();
  };
}

/** يُستخدم داخل المعالجات لضمان وجود الجلسة في أنواع TypeScript. */
export function currentAuth(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new ApiError(401, 'unauthorized', 'يجب تسجيل الدخول للمتابعة.');
  return req.auth;
}
