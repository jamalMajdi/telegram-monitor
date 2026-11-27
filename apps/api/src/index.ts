/** نقطة تشغيل خادم API. */
import { createApp } from './app.js';
import { createTelegramRuntime } from './modules/telegram/runtime.js';
import { env } from './config/env.js';
import { closePool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { createNotificationDelivery } from './modules/notifications/delivery.js';
import { NotificationService } from './modules/notifications/notificationsService.js';
import { PgNotificationsStore } from './modules/notifications/notificationsRepository.js';
import { PgDestinationHealth } from './modules/publishing/destinationHealth.js';
import { DashboardService } from './modules/dashboard/dashboardService.js';
import { PgDashboardStore } from './modules/dashboard/dashboardRepository.js';

// كائن تشغيل واحد لتكامل تيليجرام: يمنع عملاء أو اتصالات مكررة للحساب نفسه.
const telegramRuntime = createTelegramRuntime();

/**
 * توصيل الإشعارات (P0 — تدقيق ما قبل التسليم).
 *
 * يُركَّب هنا لا في `createApp` لأن دورة الحياة (بدء/إيقاف العامل) تخصّ نقطة التشغيل،
 * و`createApp` يبقى قابلاً للاختبار بحقن خدمة تنبيهات جاهزة.
 */
const destinationHealth = new PgDestinationHealth();
const dashboard = new DashboardService({ store: new PgDashboardStore() });
const delivery = createNotificationDelivery({
  alertSweep: async () => {
    const { PgUserDirectory } = await import('./modules/notifications/userDirectory.js');
    const users = await new PgUserDirectory().listUsersWithDestinations();
    for (const userId of users) await notifications.sync(userId, { force: true });
    return users.length;
  },
});
const notifications = new NotificationService({
  store: new PgNotificationsStore(),
  sources: {
    counts: (userId) => dashboard.counts(userId),
    workerHealth: async () => {
      const readiness = await telegramRuntime.ops.readiness();
      return { state: readiness.publishWorker.state, lastSeenSeconds: readiness.publishWorker.lastSeenSeconds };
    },
    destinationFailures: (userId) => destinationHealth.countFailing(userId, 3),
  },
  emailAlerts: delivery.alertBridge,
});

const app = createApp({ telegramRuntime, notifications });
const server = app.listen(env.API_PORT, env.API_HOST, () => {
  logger.info({ port: env.API_PORT, host: env.API_HOST, env: env.NODE_ENV }, 'خادم API يعمل');
  logger.info(
    { ready: telegramRuntime.ready, library: telegramRuntime.gateway.libraryName },
    telegramRuntime.ready ? 'تكامل تيليجرام مهيأ' : 'تكامل تيليجرام غير مهيأ (لن تُقبل عمليات ربط)',
  );
  // الاحتفاظ (P4-د، Q23): **مشغّل واحد** يضم كل السياسات (المحتوى، الهويات، التسليمات،
  // الأخطاء، التدقيق) بدل مؤقتات متفرقة؛ كل تشغيل يُسجَّل في retention_runs.
  telegramRuntime.retention.start();
  // تنظيف عملاء المصادقة المهجورين (تدقيق 2026-11-26): من يبدأ الربط ويغلق الصفحة
  // كان يترك اتصال MTProto حيّاً في الذاكرة إلى الأبد.
  telegramRuntime.logins.startSweeper();
  // مستهلك صندوق البريد (P0): استعادة كلمة المرور وبريد التنبيهات الحرجة.
  // التعطيل بالإعداد (OUTBOX_INTERVAL_SECONDS=0) متاح، وغياب SMTP يعني «لا إرسال» بلا حرق صفوف.
  if (delivery.worker.start()) {
    logger.info(
      { mailConfigured: delivery.mailer.configured, intervalSeconds: env.OUTBOX_INTERVAL_SECONDS },
      delivery.mailer.configured ? 'مستهلك صندوق البريد بدأ' : 'مستهلك صندوق البريد بدأ بلا SMTP (لا إرسال)',
    );
  }
  // عامل إرسال المنشورات (7-د): داخل العملية، بتزامن ≤3 وفواصل لكل محادثة.
  if (!telegramRuntime.publishing.startWorker()) {
    logger.info(
      { ready: telegramRuntime.publishing.ready },
      'عامل النشر لم يبدأ (معطَّل أو مفتاح تشفير رموز البوتات غير مهيأ)',
    );
  }
  // استعادة الاتصالات المحفوظة بعد إعادة التشغيل (D03) — بحدود ولا حلقات غير محدودة.
  if (env.TG_RESTORE_ON_START && telegramRuntime.ready) {
    void telegramRuntime
      .restoreActiveAccounts()
      .then((result) => logger.info(result, 'نتيجة استعادة اتصالات تيليجرام'))
      .catch((err: unknown) =>
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'فشل استعادة اتصالات تيليجرام'),
      );
  }
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'إيقاف الخادم');
  server.close(async () => {
    telegramRuntime.publishing.stopWorker();
    telegramRuntime.retention.stop();
    telegramRuntime.logins.stopSweeper();
    delivery.worker.stop();
    telegramRuntime.ingest.stopBackgroundTasks();
    await telegramRuntime.logins.shutdown().catch(() => undefined);
    await telegramRuntime.manager.disconnectAll('shutdown').catch(() => undefined);
    await closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'وعد مرفوض غير معالج');
});
