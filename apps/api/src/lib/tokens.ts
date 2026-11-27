/** رموز عشوائية عالية العشوائية وبصمات تخزين آمنة. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** بصمة SHA-256 بنمط سداسي عشري: ما يُخزَّن في قاعدة البيانات بدل الرمز الخام. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
