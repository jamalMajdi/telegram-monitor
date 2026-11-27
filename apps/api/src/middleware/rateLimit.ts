/**
 * تحديد معدل في الذاكرة لحماية مسارات المصادقة من التخمين.
 * ملاحظة معمارية: الحد مفرد لكل عملية خادم؛ عند التوسع الأفقي يُستبدل بمخزن مشترك
 * (PostgreSQL أو وسيط) دون تغيير العقود — موثّق في docs/limitations-phase-1.md.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { tooManyRequests } from '../lib/errors.js';
import { clientIp } from '../lib/http.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message: string;
  /** مفتاح إضافي (كالبريد) لمنع التخمين الموجّه ضد حساب واحد. */
  keyFrom?: (req: Request) => string | null;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const ip = clientIp(req) ?? 'unknown';
    const extra = options.keyFrom?.(req);
    const key = `${req.path}|${ip}|${extra ?? ''}`;
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }
    existing.count += 1;
    if (existing.count > options.max) {
      const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return next(tooManyRequests(options.message, retryAfter));
    }
    next();
  };
}

/** تنظيف دوري لمنع تضخم الذاكرة (يُستدعى من الاختبارات أيضاً). */
export function resetRateLimitBuckets(): void {
  buckets.clear();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();
