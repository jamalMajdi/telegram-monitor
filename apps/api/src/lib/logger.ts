import pino from 'pino';
import { env } from '../config/env.js';

/**
 * سجل منظّم. الأسماء الممنوعة أدناه تُحجب دفاعياً في حال مرّت سهواً
 * (كلمات المرور، رموز الجلسات والاستعادة، رؤوس المصادقة).
 */
const redactPaths = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'tokenHash',
  '*.tokenHash',
  'csrfToken',
  '*.csrfToken',
];

/**
 * الوجهة: المخرج القياسي افتراضاً، أو ملف عند ضبط LOG_FILE (تشغيل خادمي أو اختبار تسريب السجلات).
 * الكتابة متزامنة عند استخدام ملف حتى تُقرأ السجلات فوراً بعد الطلب.
 */
const destination = env.LOG_FILE ? pino.destination({ dest: env.LOG_FILE, sync: true }) : undefined;

const loggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[محجوب]' },
  base: { service: 'tg-api' },
};

export const logger = destination ? pino(loggerOptions, destination) : pino(loggerOptions);
