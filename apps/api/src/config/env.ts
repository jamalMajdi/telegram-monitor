/**
 * تهيئة البيئة: تُقرأ مرة واحدة وتُتحقق بمخطط صارم.
 * لا تُطبع أي قيمة سرية في السجلات؛ الرسائل تسمّي المتغيّر فقط.
 */
import 'dotenv/config';
import { z } from 'zod';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** يعامل القيم الفارغة في .env كأنها غير محددة (بدل '' التي تُفشل التحقق). */
const optionalWhenEmpty = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  APP_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  /**
   * مجلد بناء الواجهة (`apps/web/dist`) لخدمتها من نفس الخدمة على منفذ واحد.
   * فارغ ⇒ يجرى اكتشاف تلقائي للمسار القياسي إن وُجد؛ غيابه يعني «واجهة منفصلة على منفذ آخر».
   */
  WEB_DIST_DIR: z.string().default(''),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL مطلوب'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(5000),

  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(10080).default(480),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(8760).default(720),
  SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]{3,40}$/).default('tg_sid'),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  /**
   * سياسة SameSite لملف تعريف الجلسة.
   * `lax` هي الافتراضية وأكثر أماناً (النشر الطبيعي: الواجهة والـAPI على أصل واحد).
   * `none` تُستخدم فقط عند تحميل الواجهة داخل إطار (iframe) من أصل مختلف — مثل بيئة
   * المعاينة — لأن المتصفح يعامل الأصل الشفاف للإطار كموقع خارجي فيحجب `lax`.
   * عند `none` يُلزم النظام `COOKIE_SECURE=true` (شرط المتصفحات لملف `SameSite=None`).
   */
  SESSION_COOKIE_SAMESITE: z.enum(['lax', 'none']).default('lax'),
  /**
   * مسار مصادقة بديل بترويسة `Authorization: Bearer` لبيئات المعاينة التي تحجب
   * ملفات تعريف الارتباط (إطار بمصدر شفاف). ممنوع في الإنتاج: يُصدر رمز الجلسة
   * في جسم الاستجابة بدل ملف httpOnly.
   */
  AUTH_BEARER_FALLBACK: z.enum(['true', 'false']).default('false'),

  RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().min(1).max(10000).default(10),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).max(10000).default(20),
  RATE_LIMIT_FORGOT_MAX: z.coerce.number().int().min(1).max(10000).default(5),
  RATE_LIMIT_RESET_MAX: z.coerce.number().int().min(1).max(10000).default(10),
  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(8),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  LOGIN_ATTEMPT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  DEV_EXPOSE_RESET_TOKEN: booleanish.default('false'),
  BOOTSTRAP_ADMIN_EMAIL: optionalWhenEmpty(z.string().email()),

  // ── تيليجرام (MTProto) — المرحلة الثانية ────────────────
  // بيانات التطبيق من my.telegram.org؛ تُترك فارغة حتى توفير اعتماد مصرّح به.
  TG_API_ID: optionalWhenEmpty(z.coerce.number().int().positive().max(2147483647)),
  TG_API_HASH: optionalWhenEmpty(z.string().regex(/^[0-9a-fA-F]{32}$/)),
  // مفتاح تشفير جلسات MTProto (AES-256-GCM) بترميز base64 لـ32 بايت. إلزامي لأي اتصال حقيقي.
  TG_SESSION_ENC_KEY: optionalWhenEmpty(z.string()),
  // مفتاح سابق مقبول للفك فقط، لدعم تدوير المفاتيح دون إفشال الجلسات القائمة.
  TG_SESSION_ENC_KEY_PREVIOUS: optionalWhenEmpty(z.string()),
  TG_SESSION_ENC_KEY_VERSION: z.coerce.number().int().min(1).max(65535).default(1),
  TG_CONNECTION_RETRIES: z.coerce.number().int().min(0).max(20).default(3),
  TG_MAX_RECONNECT_ATTEMPTS: z.coerce.number().int().min(0).max(20).default(5),
  TG_RECONNECT_BASE_DELAY_MS: z.coerce.number().int().min(100).max(60000).default(1000),
  TG_FLOOD_SLEEP_THRESHOLD: z.coerce.number().int().min(0).max(3600).default(0),
  TG_CATCH_UP: booleanish.default('true'),
  TG_TEST_SERVERS: booleanish.default('false'),
  TG_REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(20),
  /** صلاحية محاولة الربط (رمز أو كلمة تحقق بخطوتين) بالدقائق. */
  TG_LOGIN_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  /** أقصى عدد محاولات لرمز دخول خاطئ داخل المحاولة الواحدة. */
  TG_LOGIN_MAX_CODE_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  /** أقصى عدد محاولات لكلمة مرور تحقق بخطوتين خاطئة. */
  TG_LOGIN_MAX_PASSWORD_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /** أقصى عدد مرات إعادة إرسال الرمز داخل المحاولة الواحدة. */
  TG_LOGIN_MAX_RESENDS: z.coerce.number().int().min(0).max(10).default(3),
  /** أقل فاصل بين طلبات إعادة الإرسال بالثواني. */
  TG_LOGIN_RESEND_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  /** إعادة توصيل الحسابات النشطة عند بدء الخادم (D03/O01). */
  TG_RESTORE_ON_START: booleanish.default('true'),
  /** حد مصادر المراقبة لكل حساب تيليجرام (D11: ملف إطلاق 25، قابل للرفع بعد القياس). */
  TG_MAX_SOURCES_PER_ACCOUNT: z.coerce.number().int().min(1).max(500).default(25),
  /** الخطوة الرابعة: تمكين/تعطيل محرّك الالتقاط (لا يمسّ الاتصال ولا المصادر). */
  TG_INGEST_ENABLED: booleanish.default('true'),
  /** مدة الاحتفاظ بهويات الرسائل (منع التكرار) بالأيام — قرار معتمد: 30 يوماً قابلة للضبط. */
  TG_INGEST_IDENTITY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** عدد محاولات حفظ هوية الرسالة قبل إعلان الفشل وتثبيت نقطة الاستئناف. */
  TG_INGEST_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /** فاصل تنظيف الهويات المنتهية بالدقائق. */
  TG_INGEST_PURGE_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(10080).default(360),
  /** الخطوة 5-ب: تمكين/تعطيل خط المعالجة (الفلترة وحفظ المحتوى المطابق). */
  TG_PROCESSING_ENABLED: booleanish.default('true'),
  /** الخطوة 5-ج: تمكين/تعطيل الاستخراج (يبقى المحتوى والمطابقات محفوظين عند التعطيل). */
  TG_EXTRACTION_ENABLED: booleanish.default('true'),
  /** فاصل حذف المحتوى والنتائج المنتهية بالدقائق (سياسة مستقلة عن احتفاظ الهوية). */
  TG_CONTENT_PURGE_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(10080).default(60),

  // ── النشر (المرحلة الثالثة — الدفعة 7-أ/7-ب) ─────────────
  // مفتاح تشفير رموز بوتات النشر (AES-256-GCM) بترميز base64 لـ32 بايت، مستقل عن مفتاح الجلسات (Q1).
  TG_BOT_ENC_KEY: optionalWhenEmpty(z.string()),
  // مفتاح سابق مقبول للفك فقط عند تدوير المفتاح.
  TG_BOT_ENC_KEY_PREVIOUS: optionalWhenEmpty(z.string()),
  TG_BOT_ENC_KEY_VERSION: z.coerce.number().int().min(1).max(65535).default(1),
  /** أصل Bot API (يُستبدل في الاختبارات بعميل مزيّف؛ لا يُستخدم لإرسال حقيقي هنا). */
  TG_BOT_API_BASE_URL: z.string().min(1).default('https://api.telegram.org'),
  /** مهلة طلب Bot API بالمللي ثانية. */
  TG_BOT_API_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(10000),
  /** تمكين محرك التوجيه (إنشاء التسليمات عند المعالجة). التعطيل يوقف إنشاء التسليمات فقط. */
  TG_ROUTING_ENABLED: booleanish.default('true'),
  /** سقف عدد وجهات النشر لكل مستخدم. */
  TG_MAX_DESTINATIONS_PER_USER: z.coerce.number().int().min(1).max(200).default(20),
  /** تمكين عامل الإرسال داخل العملية (7-د). التعطيل يوقف الإرسال فقط. */
  TG_PUBLISH_WORKER_ENABLED: booleanish.default('true'),
  /** دورية دورة العامل بالمللي ثانية. */
  TG_PUBLISH_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).max(60000).default(3000),
  /** عتبة اعتبار عامل النشر «متوقفاً» بالثواني (Q26). */
  TG_OPS_WORKER_STALE_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
  /** دورية مشغّل الاحتفاظ الوحيد داخل العملية بالدقائق (P4-د، Q23). */
  TG_RETENTION_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  /** مدة استحواذ الجزء/التسليم بالثواني قبل أن يصبح قابلاً للاستعادة. */
  TG_PUBLISH_LEASE_SECONDS: z.coerce.number().int().min(30).max(600).default(90),
  /** سقف عدد مسارات النشر لكل مستخدم. */
  TG_MAX_ROUTES_PER_USER: z.coerce.number().int().min(1).max(500).default(50),

  // ── البريد الصادر (P0 — تدقيق ما قبل التسليم) ─────────────
  /**
   * إعدادات SMTP لاستعادة كلمة المرور وتنبيهات الفشل الحرجة.
   * الفارغ = البريد **معطَّل بصراحة** (تُحفظ الرسائل في `notification_outbox` بحالة pending
   * ولا يُفقد شيء)، لا خطأ إقلاع ولا صمت: الحالة ظاهرة في لوحة المدير.
   */
  SMTP_HOST: optionalWhenEmpty(z.string()),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** true = TLS من البداية (منفذ 465)، false = STARTTLS إن أعلنه الخادم (587). */
  SMTP_SECURE: booleanish.default('false'),
  /** اسم المستخدم وكلمة المرور؛ تركهما فارغين يعني خادماً بلا مصادقة (نادر، للاختبار فقط). */
  SMTP_USER: optionalWhenEmpty(z.string()),
  SMTP_PASS: optionalWhenEmpty(z.string()),
  /** عنوان المُرسِل (يجب أن يقبله الخادم). */
  SMTP_FROM: optionalWhenEmpty(z.string()),
  SMTP_FROM_NAME: z.string().max(80).default('منصة الرصد والنشر'),
  /** مهلة أي أمر SMTP بالمللي ثانية. */
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  /**
   * مسار ملف شهادة CA (PEM) لخادم SMTP بشهادة داخلية/ذاتية.
   * اختياري: غيابه = التحقق من شهادات الجذر العامة (السلوك الافتراضي).
   * لا يوجد مفتاح لتعطيل التحقق — عن قصد.
   */
  SMTP_CA_PATH: optionalWhenEmpty(z.string()),
  /** دورية مستهلك صندوق البريد بالثواني (0 = معطَّل). */
  OUTBOX_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  /** محاولات تسليم البريد قبل إعلان الفشل النهائي. */
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  /** أصل التطبيق في الروابط المرسلة بالبريد (رابط استعادة كلمة المرور). */
  APP_PUBLIC_URL: optionalWhenEmpty(z.string()),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** مسار ملف اختياري للسجلات (الافتراضي: المخرج القياسي). */
  LOG_FILE: optionalWhenEmpty(z.string()),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`تهيئة البيئة غير صالحة — ${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.DEV_EXPOSE_RESET_TOKEN) {
    throw new Error('DEV_EXPOSE_RESET_TOKEN يجب أن يكون false في الإنتاج');
  }
  if ((env.TG_API_ID === undefined) !== (env.TG_API_HASH === undefined)) {
    throw new Error('يجب توفير TG_API_ID وTG_API_HASH معاً أو تركهما فارغين.');
  }
  for (const [name, value] of [
    ['TG_SESSION_ENC_KEY', env.TG_SESSION_ENC_KEY],
    ['TG_SESSION_ENC_KEY_PREVIOUS', env.TG_SESSION_ENC_KEY_PREVIOUS],
    ['TG_BOT_ENC_KEY', env.TG_BOT_ENC_KEY],
    ['TG_BOT_ENC_KEY_PREVIOUS', env.TG_BOT_ENC_KEY_PREVIOUS],
  ] as const) {
    if (!value) continue;
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32) {
      throw new Error(`${name} يجب أن يكون 32 بايت بترميز base64 (AES-256).`);
    }
  }
  if (env.NODE_ENV === 'production' && env.COOKIE_SECURE === 'false') {
    throw new Error('COOKIE_SECURE=false غير مسموح في الإنتاج');
  }
  if (env.NODE_ENV === 'production' && env.AUTH_BEARER_FALLBACK === 'true') {
    throw new Error('AUTH_BEARER_FALLBACK غير مسموح في الإنتاج (يُصدر رمز الجلسة في الجسم).');
  }
  if (env.SESSION_COOKIE_SAMESITE === 'none' && env.COOKIE_SECURE === 'false') {
    throw new Error('SESSION_COOKIE_SAMESITE=none يتطلب COOKIE_SECURE=true أو auto على HTTPS');
  }
  // البريد: نصف تهيئة أسوأ من عدمها — يُرفض عند الإقلاع بخطأ واضح.
  if (env.SMTP_HOST && !env.SMTP_FROM) {
    throw new Error('SMTP_HOST مُعرَّف بلا SMTP_FROM: عيّن عنوان المُرسِل أو أفرغ SMTP_HOST لتعطيل البريد.');
  }
  if (!env.SMTP_HOST && env.SMTP_FROM) {
    throw new Error('SMTP_FROM مُعرَّف بلا SMTP_HOST: عيّن الخادم أو أفرغ العنوان.');
  }
  if (env.SMTP_USER && !env.SMTP_PASS) {
    throw new Error('SMTP_USER بلا SMTP_PASS.');
  }
  return env;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** أصول الواجهة المسموح لها بإرسال ملف تعريف الجلسة. */
export const allowedOrigins = env.APP_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

export const cookieSecure =
  env.COOKIE_SECURE === 'auto' ? isProduction : env.COOKIE_SECURE === 'true';

/** `SameSite=None` لا يُقبل من المتصفحات إلا مع `Secure` ⇒ يُفرض هنا قطعياً. */
export const sessionCookieSameSite: 'lax' | 'none' = env.SESSION_COOKIE_SAMESITE;
export const sessionCookieSecure = sessionCookieSameSite === 'none' ? true : cookieSecure;

/** مسار المصادقة البديل بالترويسة (بيئات المعاينة فقط). */
export const authBearerFallback = env.AUTH_BEARER_FALLBACK === 'true';
