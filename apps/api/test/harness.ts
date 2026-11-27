/**
 * أداة اختبار: تشغيل نسخة PostgreSQL مؤقتة مستقلة، تطبيق الترحيلات،
 * ثم تشغيل خادم API على منفذ عشوائي. لا تمس قاعدة التطوير.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import EmbeddedPostgres from 'embedded-postgres';

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
  /** استعلام مباشر على قاعدة الاختبار للتحقق من الحالة المخزّنة. */
  sql: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

export class TestClient {
  cookie = '';
  csrf: string | null = null;

  constructor(private readonly baseUrl: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', origin: 'http://localhost:5173', ...extra };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    return headers;
  }

  private captureCookies(res: Response): void {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      const value = rest.join('=');
      if (!name) continue;
      if (value === '' || raw.includes('Expires=Thu, 01 Jan 1970')) {
        this.cookie = '';
      } else {
        this.cookie = `${name}=${value}`;
      }
    }
  }

  async request(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpResponse> {
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers: this.headers({
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      }),
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await fetch(`${this.baseUrl}${path}`, init);
    this.captureCookies(res);
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const parsed = body as { csrfToken?: string } | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.csrfToken === 'string') {
      this.csrf = parsed.csrfToken;
    }
    return { status: res.status, body, headers: res.headers };
  }

  get(path: string) {
    return this.request(path);
  }
  post(path: string, body?: unknown) {
    return this.request(path, { method: 'POST', body });
  }
  delete(path: string) {
    return this.request(path, { method: 'DELETE' });
  }

  patch(path: string, body?: unknown) {
    return this.request(path, { method: 'PATCH', body });
  }
  del(path: string, body?: unknown) {
    return this.request(path, { method: 'DELETE', body });
  }
  /** جلب رمز CSRF محدّث (كما تفعل الواجهة عند انتهاء الرمز). */
  async refreshCsrf(): Promise<void> {
    await this.get('/api/v1/auth/session');
  }
}

let sharedPostgres: EmbeddedPostgres | null = null;

export interface TestServerOptions {
  /** بوابة تيليجرام محاكاة تُمرَّر إلى التطبيق (بدل الاتصال الحقيقي). */
  telegramGateway?: import('../src/modules/telegram/gateway.js').TelegramGateway;
  /** عميل Bot API محاكاة للنشر (بدل الشبكة). */
  botApiClient?: import('../src/modules/publishing/botApiClient.js').BotApiClient;
  /** خدمة تنبيهات مُهيَّأة (P4-و): تسمح بتثبيت مصادر الحقيقة والعتبات في الاختبار. */
  notifications?: import('../src/modules/notifications/notificationsService.js').NotificationService;
  /**
   * مصنع خدمة التنبيهات. يُستدعى **بعد** ضبط DATABASE_URL، فبناء الخدمة في الاختبار
   * لا يسبق تهيئة الاتصال (وإلا التقطت `env` قاعدة التطوير لا قاعدة الاختبار).
   */
  notificationsFactory?: (deps: {
    store: import('../src/modules/notifications/notificationsRepository.js').NotificationsStore;
    Service: typeof import('../src/modules/notifications/notificationsService.js').NotificationService;
  }) => import('../src/modules/notifications/notificationsService.js').NotificationService;
  /** مستوى السجل (افتراضياً silent) وملف سجل اختياري لاختبار عدم تسريب الأسرار. */
  logLevel?: string;
  logFile?: string;
}

/**
 * منفذ حر يطلبه النظام نفسه.
 *
 * كان الاختيار سابقاً `55000 + random(500)` — وهو نفس النطاق الذي تعمل فيه قاعدة
 * التطوير المحلية (`55432`) وبقايا نسخ سابقة، فكانت نسخة الاختبار تتصادم أحياناً
 * وتفشل بـ`ECONNREFUSED` بلا أي علاقة بالكود (رأيناه في بوابة P0).
 * نطلب من النظام منفذاً حراً ثم نُغلقه فوراً ونستخدمه: نافذة التصادم أصبحت أجزاءً من الثانية.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no_free_port'))));
    });
  });
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), 'tg-test-'));
  const port = await freePort();
  const database = 'tg_test';
  const password = randomBytes(8).toString('hex');

  sharedPostgres = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password,
    port,
    persistent: false,
    // الصورة لا تتضمن locale en_US؛ نستخدم C.utf8 مع ترميز UTF-8 كامل.
    initdbFlags: ['--locale=C.utf8', '--lc-messages=C', '--encoding=UTF8'],
    onLog: () => {},
    onError: () => {},
  });
  await sharedPostgres.initialise();
  await sharedPostgres.start();
  await sharedPostgres.createDatabase(database);

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = options.logLevel ?? 'silent';
  if (options.logFile) process.env.LOG_FILE = options.logFile;
  else delete process.env.LOG_FILE;
  process.env.DATABASE_URL = `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
  process.env.APP_ORIGIN = 'http://localhost:5173';
  process.env.SESSION_IDLE_MINUTES = '30';
  process.env.SESSION_ABSOLUTE_HOURS = '2';
  process.env.LOGIN_MAX_FAILED_ATTEMPTS = '3';
  process.env.LOGIN_LOCK_MINUTES = '10';
  process.env.LOGIN_ATTEMPT_WINDOW_MINUTES = '15';
  process.env.PASSWORD_RESET_TTL_MINUTES = '30';
  process.env.DEV_EXPOSE_RESET_TOKEN = 'true';
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'owner@example.test';
  // مفتاح تشفير جلسات تيليجرام للاختبارات: عشوائي لكل تشغيل ولا يُحفظ.
  process.env.TG_SESSION_ENC_KEY = randomBytes(32).toString('base64');
  process.env.TG_SESSION_ENC_KEY_VERSION = '1';
  delete process.env.TG_SESSION_ENC_KEY_PREVIOUS;
  // مفتاح مستقل لتشفير رموز بوتات النشر (Q1): عشوائي لكل تشغيل ولا يُحفظ.
  process.env.TG_BOT_ENC_KEY = randomBytes(32).toString('base64');
  process.env.TG_BOT_ENC_KEY_VERSION = '1';
  delete process.env.TG_BOT_ENC_KEY_PREVIOUS;
  // حدود مرتفعة لتسجيل الدخول/التسجيل حتى لا تتداخل الاختبارات؛ حد الاستعادة يبقى 5 لاختباره.
  process.env.RATE_LIMIT_LOGIN_MAX = '1000';
  process.env.RATE_LIMIT_REGISTER_MAX = '1000';
  process.env.RATE_LIMIT_FORGOT_MAX = '5';
  // إعادة اتصال سريعة في الاختبارات (لا حلقات طويلة) مع حدود صريحة.
  process.env.TG_MAX_RECONNECT_ATTEMPTS = '3';
  process.env.TG_RECONNECT_BASE_DELAY_MS = '100';
  process.env.TG_LOGIN_RESEND_INTERVAL_SECONDS = '30';
  process.env.TG_LOGIN_TTL_MINUTES = '10';
  process.env.TG_LOGIN_MAX_CODE_ATTEMPTS = '5';
  process.env.TG_LOGIN_MAX_PASSWORD_ATTEMPTS = '3';
  process.env.TG_LOGIN_MAX_RESENDS = '3';

  const { migrate } = await import('../src/db/migrate.js');
  await migrate();

  let notifications = options.notifications;
  if (!notifications && options.notificationsFactory) {
    const [{ PgNotificationsStore }, { NotificationService }] = await Promise.all([
      import('../src/modules/notifications/notificationsRepository.js'),
      import('../src/modules/notifications/notificationsService.js'),
    ]);
    notifications = options.notificationsFactory({ store: new PgNotificationsStore(), Service: NotificationService });
  }

  const { createApp } = await import('../src/app.js');
  const app = createApp({
    ...(options.telegramGateway ? { telegramGateway: options.telegramGateway } : {}),
    ...(options.botApiClient ? { botApiClient: options.botApiClient } : {}),
    ...(notifications ? { notifications } : {}),
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const { query } = await import('../src/db/pool.js');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sql: async (text, params = []) => {
      const res = await query(text, params);
      return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount ?? 0 };
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const { closePool } = await import('../src/db/pool.js');
      await closePool();
      if (sharedPostgres) await sharedPostgres.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function client(baseUrl: string): TestClient {
  return new TestClient(baseUrl);
}
