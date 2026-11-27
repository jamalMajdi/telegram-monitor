/**
 * تركيب تطبيق Express: أمان، تحليل الجسم، الجلسة، المسارات، معالجة موحّدة للأخطاء.
 * لا منطق أعمال هنا؛ المنطق في وحدات modules.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { allowedOrigins, env, isProduction } from './config/env.js';
import { checkDatabase } from './db/pool.js';
import { ApiError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { attachSession } from './middleware/auth.js';
import { requireCsrf } from './middleware/csrf.js';
import { adminRouter } from './modules/admin/routes.js';
import { authRouter } from './modules/auth/routes.js';
import { meRouter } from './modules/users/routes.js';
import { settingsRouter } from './modules/settings/routes.js';
import { createTelegramRouter } from './modules/telegram/routes.js';
import { createTelegramIngestRouter } from './modules/telegram/ingestRoutes.js';
import { createTelegramFilterRouter } from './modules/processing/filterRoutes.js';
import { createTelegramResultsRouter } from './modules/processing/resultsRoutes.js';
import { createTelegramSourcesRouter } from './modules/telegram/sourceRoutes.js';
import { createTelegramRuntime, type TelegramRuntime } from './modules/telegram/runtime.js';
import type { TelegramGateway } from './modules/telegram/gateway.js';
import { createPublishingRouter } from './modules/publishing/publishingRoutes.js';
import { PgDashboardStore } from './modules/dashboard/dashboardRepository.js';
import { DashboardService } from './modules/dashboard/dashboardService.js';
import { createDashboardRouter } from './modules/dashboard/dashboardRoutes.js';
import { createAdminOpsRouter, createPublicOpsRouter } from './modules/ops/opsRoutes.js';
import { PgLogsStore } from './modules/logs/logsRepository.js';
import { createAdminLogsRouter, createUserLogsRouter } from './modules/logs/logsRoutes.js';
import { createAdminRetentionRouter } from './modules/retention/retentionRoutes.js';
import { createJourneyRouter } from './modules/journey/journeyRoutes.js';
import { createNotificationsRouter } from './modules/notifications/notificationsRoutes.js';
import { NotificationService } from './modules/notifications/notificationsService.js';
import { PgNotificationsStore } from './modules/notifications/notificationsRepository.js';
import type { BotApiClient } from './modules/publishing/botApiClient.js';

export interface AppOptions {
  /** بوابة تيليجرام بديلة (اختبارات المحاكاة فقط)؛ الافتراضي: البوابة الحقيقية أو وضع غير مهيأ. */
  telegramGateway?: TelegramGateway;
  /** كائن تشغيل جاهز يُمرَّر عند الحاجة لاختبار مسارات تيليجرام دون إعادة بناء. */
  telegramRuntime?: TelegramRuntime;
  /** عميل Bot API بديل (اختبارات النشر فقط)؛ الافتراضي عميل HTTPS حقيقي بمهلة. */
  botApiClient?: BotApiClient;
  /** خدمة لوحة المستخدم (P4-أ) — تُحقن في الاختبارات للتحكم بالذاكرة القصيرة. */
  dashboard?: DashboardService;
  /** خدمة التنبيهات (P4-و) — تُحقن في الاختبارات للتحكم بالعتبات أو مزوّد الحقيقة. */
  notifications?: NotificationService;
}

/** تحليل ملف تعريف الجلسة (cookie) دون اعتماد مكتبة إضافية. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * يحدّد مجلد بناء الواجهة: من `WEB_DIST_DIR` صراحةً، وإلا يجرى اكتشاف المسار القياسي
 * `apps/web/dist` انطلاقاً من مكان تنفيذ الخدمة (src أو dist) — بلا مسارات مطلقة مكتوبة يدوياً.
 */
function resolveWebDistDir(): string | null {
  const explicit = env.WEB_DIST_DIR.trim();
  if (explicit) return existsSync(join(explicit, 'index.html')) ? resolve(explicit) : null;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', '..', 'web', 'dist'), // apps/api/src → apps/web/dist
    resolve(here, '..', '..', '..', '..', 'apps', 'web', 'dist'), // apps/api/dist
    resolve(process.cwd(), '..', 'web', 'dist'),
    resolve(process.cwd(), 'apps', 'web', 'dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', isProduction ? 1 : false);

  app.use(
    helmet({
      contentSecurityPolicy: false, // الواجهة تُخدم من أصل منفصل في التطوير ومن نفس الأصل في الإنتاج
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use((req: Request, res: Response, next: NextFunction) => {
    // منع استخدام ملف تعريف الجلسة من أصل غير مصرّح.
    // يُقبل: (أ) طلب من نفس الأصل (Origin.host == Host) — يغطي الواجهة على أي نطاق تشغيل،
    // و(ب) أصل مدرج صراحةً في APP_ORIGIN لعشرات النشر التي تفصل الواجهة عن الخدمة.
    const origin = req.get('origin');
    const host = req.get('host');
    let originHost: string | null = null;
    if (origin) {
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
    }
    const isSameOrigin = Boolean(origin && host && originHost === host);
    const isConfiguredOrigin = Boolean(origin && allowedOrigins.includes(origin));
    if (origin && !isSameOrigin && !isConfiguredOrigin) {
      res.status(403).json({ error: { code: 'origin_not_allowed', message: 'أصل الطلب غير مسموح.' } });
      return;
    }
    if (origin && isConfiguredOrigin && !isSameOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type,x-csrf-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '64kb' }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.cookies = parseCookies(req.headers.cookie);
    next();
  });

  const requestStarted = new WeakMap<Request, bigint>();
  app.use((req: Request, res: Response, next: NextFunction) => {
    requestStarted.set(req, process.hrtime.bigint());
    res.on('finish', () => {
      const started = requestStarted.get(req) ?? process.hrtime.bigint();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const payload: Record<string, unknown> = {
        method: req.method,
        path: req.route?.path ?? req.path,
        status: res.statusCode,
        ms: Math.round(ms),
      };
      // عند 401 نسجّل *حضور* قنوات المصادقة فقط (بلا أي قيمة) لتشخيص بيئات المعاينة.
      if (res.statusCode === 401 && req.authProbe) payload.authProbe = req.authProbe;
      logger.info(payload, 'طلب');
    });
    next();
  });

  app.get('/api/v1/health', async (_req, res) => {
    try {
      await checkDatabase();
      res.json({ status: 'ok', database: 'connected', environment: env.NODE_ENV });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'فحص الصحة فشل');
      res.status(503).json({ status: 'degraded', database: 'unavailable' });
    }
  });

  const dashboard = options.dashboard ?? new DashboardService({ store: new PgDashboardStore() });

  const telegramRuntime: TelegramRuntime =
    options.telegramRuntime ??
    createTelegramRuntime({
      ...(options.telegramGateway ? { gateway: options.telegramGateway } : {}),
      ...(options.botApiClient ? { botApi: options.botApiClient } : {}),
    });

  // فحص الحياة/الجهوزية عام (لـsystemd وnginx) وقبل المصادقة؛ لا تفاصيل داخلية فيه.
  app.use(createPublicOpsRouter(telegramRuntime.ops));

  app.use(attachSession);
  app.use('/api/v1/auth', requireCsrf, authRouter);
  app.use('/api/v1/me', requireCsrf, meRouter);
  app.use('/api/v1/me/settings', requireCsrf, settingsRouter);
  // مقاييس التشغيل للمدير (Q17) قبل مسارات الإدارة العامة.
  const logsStore = new PgLogsStore();
  app.use('/api/v1/admin', requireCsrf, createAdminOpsRouter(telegramRuntime.ops));
  // أخطاء النظام للمدير: تجميع بلا هوية مستخدم (P4-ج).
  app.use('/api/v1/admin', requireCsrf, createAdminLogsRouter(logsStore));
  // الاحتفاظ: قراءة التشغيلات وتشغيل دورة يدوياً (P4-د).
  app.use('/api/v1/admin', requireCsrf, createAdminRetentionRouter(telegramRuntime.retention));
  app.use('/api/v1/admin', requireCsrf, adminRouter);
  // سجلّات المستخدم: صفوفه فقط (P4-ج).
  app.use('/api/v1', requireCsrf, createUserLogsRouter(logsStore));
  // مركز التنبيهات (P4-و): مشتقّ من عدّادات اللوحة وصحّة العامل، ومعترَف به صريحاً.
  const notifications =
    options.notifications ??
    new NotificationService({
      store: new PgNotificationsStore(),
      sources: {
        counts: (userId) => dashboard.counts(userId),
        workerHealth: async () => {
          const readiness = await telegramRuntime.ops.readiness();
          return {
            state: readiness.publishWorker.state,
            lastSeenSeconds: readiness.publishWorker.lastSeenSeconds,
          };
        },
      },
    });
  app.use('/api/v1', requireCsrf, createNotificationsRouter(notifications));
  app.use('/api/v1', requireCsrf, createDashboardRouter(dashboard));
  app.use('/api/v1/telegram', requireCsrf, createTelegramRouter(telegramRuntime));
  app.use('/api/v1/telegram', requireCsrf, createTelegramSourcesRouter(telegramRuntime));
  app.use('/api/v1/telegram', requireCsrf, createTelegramIngestRouter(telegramRuntime));
  app.use(
    '/api/v1/telegram',
    requireCsrf,
    createTelegramFilterRouter({ filters: telegramRuntime.filters, store: telegramRuntime.ruleConfig }),
  );
  // الخط الزمني الموحّد (P4-هـ): مسار أوضح وأقرب للقراءة، قبل مسارات التفصيل العامة.
  app.use('/api/v1/telegram', requireCsrf, createJourneyRouter());
  app.use(
    '/api/v1/telegram',
    requireCsrf,
    createTelegramResultsRouter({ results: telegramRuntime.results, config: telegramRuntime.ruleConfig }),
  );
  app.use('/api/v1/telegram', requireCsrf, createPublishingRouter(telegramRuntime.publishing));

  // ── خدمة الواجهة من نفس المنفذ (نشر أحادي المنفذ / معاينة) ────────────────────
  // الفوائد: أصل واحد (لا CORS ولا رحلة CSRF بين أصلين)، ومعاينة تعمل بلا عملية ثانية.
  // لا تُظلّل مسارات الـAPI: المسارات أعلاه تُطابق أولاً، والاحتياطي يستثني `/api/` و`/healthz` و`/readyz`.
  const webDistDir = resolveWebDistDir();
  if (webDistDir) {
    app.use(express.static(webDistDir, { index: false, maxAge: '1h' }));
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api/') || req.path === '/healthz' || req.path === '/readyz') return next();
      // مسار بامتداد ملف (مثل /favicon.ico المفقود) ⇒ 404 حقيقي لا صفحة التطبيق.
      if (/\.[a-z0-9]+$/i.test(req.path)) return next();
      res.sendFile(join(webDistDir, 'index.html'));
    });
    logger.info({ webDistDir }, 'تخدم الواجهة من نفس خدمة الـAPI (منفذ واحد)');
  }

  app.use((_req, _res, next) => next(new ApiError(404, 'route_not_found', 'المسار غير موجود.')));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      if (err.status >= 500) logger.error({ code: err.code }, 'خطأ خادم');
      res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
      return;
    }
    // أخطاء غير متوقعة: تُسجّل كاملة، ويُعاد للعميل رد عام دون تفاصيل داخلية.
    logger.error(
      { err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err), path: req.path },
      'خطأ غير معالج',
    );
    if (res.headersSent) return;
    res.status(500).json({ error: { code: 'internal_error', message: 'حدث خطأ غير متوقع. حاول لاحقاً.' } });
  });

  return app;
}
