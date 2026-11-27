/**
 * حماية كلمات المرور: scrypt من node:crypto (بلا اعتماد خارجي وبلا خدمة مدفوعة).
 * المعاملات: N=32768، r=8، p=1، مفتاح 32 بايت، ملح عشوائي 16 بايت لكل كلمة.
 * تُحفظ التجزئة بصيغة scrypt$N$r$p$salt$hash لتسهيل الترقية مستقبلاً.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 32768;
const r = 8;
const p = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const MAX_PASSWORD_LENGTH = 200;
const MIN_PASSWORD_LENGTH = 10;

/** كلمات مرور شائعة يُرفض استخدامها (قائمة قصيرة مدمجة، قابلة للتوسعة). */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '1234567890', '12345678', '123456789',
  'qwertyuiop', 'qwerty123', 'iloveyou', 'admin123', 'welcome123', 'letmein123',
  'aaaaaaaaaa', '0000000000', '1111111111', 'telegram1', 'telegram123', 'changeme123',
]);

export type PasswordPolicyError =
  | 'too_short'
  | 'too_long'
  | 'common'
  | 'missing_letter_digit';

export function validatePasswordStrength(password: string): PasswordPolicyError | null {
  const value = password.normalize('NFKC');
  if (value.length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (value.length > MAX_PASSWORD_LENGTH) return 'too_long';
  if (COMMON_PASSWORDS.has(value.toLowerCase())) return 'common';
  // شرط أدنى للتنوّع: حرف ورقم معاً، دون اشتراط رموز خاصة.
  if (!/\p{L}/u.test(value) || !/\d/u.test(value)) return 'missing_letter_digit';
  return null;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LEN,
      { N, r, p, maxmem: 128 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const storedN = Number(nStr);
  const storedR = Number(rStr);
  const storedP = Number(pStr);
  if (storedN !== N || storedR !== r || storedP !== p) return false;
  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(hashB64!, 'base64');
  const actual = await derive(password, salt);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** تجزئة وهمية لموازنة زمن الاستجابة عند عدم وجود المستخدم (منع كشف وجود البريد). */
export async function burnPasswordCheck(password: string): Promise<void> {
  await derive(password.slice(0, MAX_PASSWORD_LENGTH), Buffer.from('tg-dummy-salt-16'));
}
