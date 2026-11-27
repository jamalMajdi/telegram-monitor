/**
 * تركيب توصيل الإشعارات (P0 — تدقيق ما قبل التسليم).
 *
 * يجمع القطع في مكان واحد حتى لا تتفرّق في `index.ts` و`app.ts`:
 *   صندوق الصادر ← مستهلكه ← عميل SMTP ← دليل المستخدمين ← جسر بريد التنبيهات.
 *
 * قواعد ثابتة:
 * - **البريد معطَّل بصراحة** إن لم يُعرَّف SMTP: لا محاولات ولا حرق صفوف، والحالة ظاهرة للمدير.
 * - **لا يمنع الإقلاع**: غياب البريد لا يمنع تشغيل المنصة (التنبيهات الداخلية تعمل).
 * - **لا أسرار في السجلات**: كلمة مرور SMTP والرموز لا تُسجَّل.
 */
import { env } from '../../config/env.js';
import { readFileSync } from 'node:fs';
import { logger } from '../../lib/logger.js';
import { PgOutboxStore, type OutboxStore } from './outboxRepository.js';
import { SmtpMailer, DisabledMailer, type SmtpClient } from './smtpClient.js';
import { OutboxWorker } from './outboxWorker.js';
import { PgUserDirectory, type UserDirectory } from './userDirectory.js';

export interface AlertEmailInput {
  id: string;
  key: string;
  severity: string;
  observedCount: number;
}

export interface NotificationDelivery {
  store: OutboxStore;
  mailer: SmtpClient;
  worker: OutboxWorker;
  /** جسر يُمرَّر إلى `NotificationService` لإدراج بريد التنبيهات. */
  alertBridge: {
    enqueue(userId: string, alert: AlertEmailInput): Promise<boolean>;
  };
}

/** يقرأ شهادة CA المخصّصة إن حُدِّدت. خطأ القراءة لا يُسقط الإقلاع: يُسجَّل وتُترك الشهادات العامة. */
function readCa(): string | undefined {
  if (!env.SMTP_CA_PATH) return undefined;
  try {
    return readFileSync(env.SMTP_CA_PATH, 'utf8');
  } catch (err) {
    logger.warn(
      { path: env.SMTP_CA_PATH, err: err instanceof Error ? err.message : String(err) },
      'تعذّرت قراءة SMTP_CA_PATH — سيُستخدم مخزن الشهادات العام',
    );
    return undefined;
  }
}

export function createMailer(): SmtpClient {
  if (!env.SMTP_HOST || !env.SMTP_FROM) {
    logger.info('البريد الصادر معطَّل (SMTP غير مهيأ) — الرسائل تبقى في صندوق الصادر بحالة pending');
    return new DisabledMailer();
  }
  const ca = readCa();
  return new SmtpMailer(
    {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.SMTP_FROM,
      fromName: env.SMTP_FROM_NAME,
      timeoutMs: env.SMTP_TIMEOUT_MS,
      ...(ca ? { ca } : {}),
    },
    logger,
  );
}

export function createNotificationDelivery(
  options: {
    store?: OutboxStore;
    mailer?: SmtpClient;
    directory?: UserDirectory;
    alertSweep?: () => Promise<number>;
  } = {},
): NotificationDelivery {
  const store = options.store ?? new PgOutboxStore();
  const mailer = options.mailer ?? createMailer();
  const directory = options.directory ?? new PgUserDirectory();
  const worker = new OutboxWorker({
    store,
    mailer,
    env: {
      SMTP_FROM: env.SMTP_FROM,
      APP_PUBLIC_URL: env.APP_PUBLIC_URL,
      TG_SESSION_ENC_KEY: env.TG_SESSION_ENC_KEY,
      TG_SESSION_ENC_KEY_PREVIOUS: env.TG_SESSION_ENC_KEY_PREVIOUS,
      TG_SESSION_ENC_KEY_VERSION: env.TG_SESSION_ENC_KEY_VERSION,
      OUTBOX_MAX_ATTEMPTS: env.OUTBOX_MAX_ATTEMPTS,
    },
    intervalMs: env.OUTBOX_INTERVAL_SECONDS * 1000,
    ...(options.alertSweep ? { alertSweep: options.alertSweep } : {}),
  });

  return {
    store,
    mailer,
    worker,
    alertBridge: {
      /**
       * يُدرج بريداً لتنبيه واحد. مفتاح منع التكرار `alert:<id>` يضمن ألا يُرسل
       * التنبيه نفسه مرتين مهما تكرر المسح، بلا حاجة لمزامنة إضافية.
       */
      async enqueue(userId: string, alert: AlertEmailInput): Promise<boolean> {
        const email = await directory.emailOf(userId);
        if (!email) return false;
        return store.enqueue({
          userId,
          recipient: email,
          template: 'alerts.raised',
          payload: { alertKey: alert.key, severity: alert.severity, count: alert.observedCount },
          dedupeKey: `alert:${alert.id}`,
        });
      },
    },
  };
}
