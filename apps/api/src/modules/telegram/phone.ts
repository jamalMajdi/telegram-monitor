/**
 * تطبيع رقم الهاتف وبصمته.
 * القاعدة (§3.3): لا يُحفظ الرقم الكامل في قاعدة البيانات؛ يُحفظ آخر رقمان للعرض وبصمة
 * تُستخدم لمنع تكرار الربط فقط. البصمة HMAC-SHA256 بمفتاح مشتق من مفتاح تشفير الجلسات،
 * فلا يمكن استرجاع الرقم منها ولا مقارنتها بين تنصيبات مختلفة.
 */
import { createHmac } from 'node:crypto';
import { env } from '../../config/env.js';

export class InvalidPhoneNumberError extends Error {
  constructor(message = 'رقم الهاتف غير صالح؛ استخدم الصيغة الدولية مثل +9677xxxxxxxx.') {
    super(message);
    this.name = 'InvalidPhoneNumberError';
  }
}

/** يزيل المسافات والشرطات ويقبل الصيغة الدولية فقط. */
export function normalizePhoneNumber(input: string): string {
  const cleaned = input.replace(/[\s\-().]/g, '');
  if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) throw new InvalidPhoneNumberError();
  return cleaned;
}

/** آخر رقمان للعرض البصري فقط. */
export function phoneLastDigits(normalized: string): string {
  return normalized.slice(-2);
}

/** بصمة ثابتة للرقم المطبَّع (لا تكشف الرقم). */
export function hashPhoneNumber(normalized: string, source = env): string {
  const key = source.TG_SESSION_ENC_KEY;
  if (!key) throw new Error('مفتاح تشفير جلسات تيليجرام غير مهيأ لحساب بصمة الرقم.');
  const pepper = createHmac('sha256', Buffer.from(key, 'base64')).update('tg-phone-hash:v1').digest();
  return createHmac('sha256', pepper).update(normalized, 'utf8').digest('hex');
}
