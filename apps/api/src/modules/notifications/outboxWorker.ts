/**
 * مستهلك صندوق البريد الصادر (P0 — تدقيق ما قبل التسليم).
 *
 * كان `notification_outbox` يُكتب فيه ولا يقرأه أحد: استعادة كلمة المرور، وأي إشعار بريدي،
 * تبقى `pending` إلى الأبد. هذا المستهلك يُغلق الحلقة:
 *
 *   1) يستحوذ صفاً واحداً بلُقية (لا إرسال مزدوج بين عمليات متعددة).
 *   2) يبني الرسالة من قالب مغلق (`mailTemplates`) — لا نص حر ولا محتوى رسائل.
 *   3) يُرسل عبر SMTP، ويختم `sent` أو يعيد الجدولة بتأخير متزايد، ثم `failed` بعد الحد.
 *   4) البريد المعطَّل (بلا SMTP) **لا يحرق الصفوف**: تبقى `pending` وتظهر للمدير.
 *
 * كما يُشغّل «مسح التنبيهات الدوري»: مزامنة تنبيهات المستخدمين الذين لديهم وجهات نشر
 * حتى يصل بريد التنبيه الحرِج **بلا انتظار فتح الواجهة**.
 */
import { logger } from '../../lib/logger.js';
import { buildMail } from './mailTemplates.js';
import type { OutboxStore } from './outboxRepository.js';
import type { SmtpClient } from './smtpClient.js';
import type { Env } from '../../config/env.js';

export interface OutboxWorkerDeps {
  store: OutboxStore;
  mailer: SmtpClient;
  env: Pick<
    Env,
    'SMTP_FROM' | 'APP_PUBLIC_URL' | 'TG_SESSION_ENC_KEY' | 'TG_SESSION_ENC_KEY_PREVIOUS' | 'TG_SESSION_ENC_KEY_VERSION' | 'OUTBOX_MAX_ATTEMPTS'
  >;
  /** معرّد العامل (للُقية). */
  owner?: string;
  intervalMs?: number;
  leaseMs?: number;
  now?: () => Date;
  /** مسح التنبيهات الدوري: يعيد عدد المستخدمين الذين زُومِنوا. */
  alertSweep?: () => Promise<number>;
  /** فاصل مسح التنبيهات (افتراضياً 60 ثانية). */
  alertSweepIntervalMs?: number;
}

export type OutboxTickResult = {
  sent: number;
  retried: number;
  failed: number;
  skipped: boolean;
  /** لماذا لم يُرسل شيء (للتشخيص): غير مهيأ، لا صفوف، خطأ. */
  reason?: 'not_configured' | 'empty' | 'error';
};

const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];

export class OutboxWorker {
  private readonly owner: string;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly alertSweepIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastSweep = 0;

  constructor(private readonly deps: OutboxWorkerDeps) {
    this.owner = deps.owner ?? `outbox-${process.pid}`;
    this.intervalMs = deps.intervalMs ?? 30_000;
    this.leaseMs = deps.leaseMs ?? 60_000;
    this.alertSweepIntervalMs = deps.alertSweepIntervalMs ?? 60_000;
  }

  start(): boolean {
    if (this.timer) return true;
    if (this.intervalMs <= 0) return false;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'دورة صندوق البريد فشلت');
      });
    }, this.intervalMs);
    this.timer.unref?.();
    // دورة أولى فورية بعد الإقلاع (لا انتظار 30 ثانية).
    void this.tick().catch(() => undefined);
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** دورة واحدة: مسح التنبيهات (إن حلّ موعده) ثم تسليم رسالة واحدة على الأكثر. */
  async tick(): Promise<OutboxTickResult> {
    if (this.ticking) return { sent: 0, retried: 0, failed: 0, skipped: true, reason: 'empty' };
    this.ticking = true;
    try {
      const now = this.deps.now ? this.deps.now() : new Date();
      if (this.deps.alertSweep && now.getTime() - this.lastSweep >= this.alertSweepIntervalMs) {
        this.lastSweep = now.getTime();
        await this.deps.alertSweep().catch((err: unknown) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'مسح التنبيهات الدوري فشل');
        });
      }
      return await this.deliverOne(now);
    } finally {
      this.ticking = false;
    }
  }

  /** يُسلّم صفاً واحداً. منفصل عن `tick` ليكون الاختبار حتمياً. */
  async deliverOne(now = this.deps.now ? this.deps.now() : new Date()): Promise<OutboxTickResult> {
    if (!this.deps.mailer.configured) {
      return { sent: 0, retried: 0, failed: 0, skipped: true, reason: 'not_configured' };
    }
    const row = await this.deps.store.claim(this.owner, this.leaseMs, this.deps.env.OUTBOX_MAX_ATTEMPTS);
    if (!row) return { sent: 0, retried: 0, failed: 0, skipped: true, reason: 'empty' };

    const mail = buildMail({
      template: row.template,
      payload: row.payload,
      subjectId: row.userId,
      env: this.deps.env,
      context: { appUrl: this.deps.env.APP_PUBLIC_URL ?? 'http://localhost:5173', now },
    });
    if (!mail) {
      await this.deps.store.markFailed({
        id: row.id,
        error: 'unknown_template',
        retryAt: null,
        final: true,
      });
      logger.warn({ template: row.template }, 'قالب بريد مجهول — الصف أُغلق فاشلاً');
      return { sent: 0, retried: 0, failed: 1, skipped: false };
    }

    const result = await this.deps.mailer.send({ to: row.recipient, subject: mail.subject, text: mail.text });
    if (result.ok) {
      await this.deps.store.markSent(row.id);
      logger.info({ template: row.template, attempts: row.attempts }, 'أُرسل بريد');
      return { sent: 1, retried: 0, failed: 0, skipped: false };
    }

    const final = row.attempts >= this.deps.env.OUTBOX_MAX_ATTEMPTS;
    const delay = BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)] ?? 3_600_000;
    await this.deps.store.markFailed({
      id: row.id,
      error: result.errorCode ?? 'send_failed',
      retryAt: final ? null : new Date(now.getTime() + delay),
      final,
    });
    logger.warn({ template: row.template, attempts: row.attempts, errorCode: result.errorCode, final }, 'تعذّر إرسال بريد');
    return { sent: 0, retried: final ? 0 : 1, failed: final ? 1 : 0, skipped: false };
  }
}
