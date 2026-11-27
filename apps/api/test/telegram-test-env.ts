/**
 * تهيئة بيئة اختبارات تيليجرام: قيم افتراضية آمنة تُحمَّل قبل بقية الوحدات.
 * لا تتصل بأي خدمة خارجية ولا تحتوي أي بيانات اعتماد حقيقية.
 */
import { randomBytes } from 'node:crypto';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/test_placeholder';
}
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.LOG_LEVEL = 'silent';
if (!process.env.TG_SESSION_ENC_KEY) {
  process.env.TG_SESSION_ENC_KEY = randomBytes(32).toString('base64');
}
if (!process.env.TG_BOT_ENC_KEY) {
  process.env.TG_BOT_ENC_KEY = randomBytes(32).toString('base64');
}
process.env.TG_BOT_ENC_KEY_VERSION = process.env.TG_BOT_ENC_KEY_VERSION ?? '1';
delete process.env.TG_BOT_ENC_KEY_PREVIOUS;
// لا يُهيّأ مفتاح سابق افتراضياً: يُترك لاختبار تدوير المفاتيح وحده.
delete process.env.TG_SESSION_ENC_KEY_PREVIOUS;
