/**
 * عامل الإرسال (الدفعة 7-د): يرسل أجزاء التسليمات الجاهزة عبر Bot API، بلا تكرار وبلا صمت.
 *
 * قواعد ملزمة (D10/O04/Q12/§10.6):
 * - **المحاولة تُحفظ قبل طلب HTTP**: صف `delivery_attempts` يُفتح أولاً، ثم يُرسَل، ثم يُغلق.
 * - **المجهول لا يُعاد تلقائياً**: أخطاء الشبكة أو المهلة أو الخادم (5xx) أو الغموض ⇒ `uncertain` وتنتظر دليلاً بشرياً
 *   (خادم تيليجرام قد يحفظ الرسالة ثم يسقط قبل الرد 200 — الأمان يمنع الإعادة التلقائية).
 * - **القابل للإعادة ضيّق بقصد**: 429 وحده (مع `retry_after`)، وكل ما عداه إما نهائي أو مجهول.
 * - **لُقية مزدوجة** (تسليم + جزء): لا يرسل عاملان الجزء نفسه؛ واللُقية المنتهية تُستعاد بلا إرسال مكرر.
 * - **فاصل ١.٢ ثانية لكل محادثة**، واحترام `retry_after` من 429 حرفياً.
 * - **سقف Q12**: 5 محاولات للجزء و6 ساعات من إنشاء التسليم، ثم فشل صريح.
 * - **فحص أخير قبل الإرسال**: النص المرئي (بعد تحليل الكيانات) ≤ 4096، وإلا لا إرسال إطلاقاً.
 */
import { logger } from '../../lib/logger.js';
import { recordErrorEvent } from '../../lib/errorLog.js';
import { BotApiError, type BotApiClient } from './botApiClient.js';
import { htmlVisibleLength } from './publisher.js';
import type { AttemptPatch, ClaimedPart, DeliveryStore } from './deliveryStore.js';

export type SendOutcomeKind = 'ok' | 'retry' | 'failed' | 'uncertain' | 'skipped';

export interface SendFailure {
  outcome: 'retryable' | 'permanent' | 'uncertain';
  errorCode: string;
  retryAfterSeconds: number | null;
  httpStatus: number | null;
  telegramErrorCode: number | null;
  detail: string | null;
}

/** تصنيف حتمي لأخطاء الإرسال (O04 + Q12). */
export function classifySendFailure(error: unknown): SendFailure {
  const fail = (
    outcome: SendFailure['outcome'],
    errorCode: string,
    extra: Partial<SendFailure> = {},
  ): SendFailure => ({
    outcome,
    errorCode,
    retryAfterSeconds: extra.retryAfterSeconds ?? null,
    httpStatus: extra.httpStatus ?? null,
    telegramErrorCode: extra.telegramErrorCode ?? null,
    detail: extra.detail ?? null,
  });

  if (!(error instanceof BotApiError)) {
    // خطأ غير متوقع حول الطلب: النتيجة مجهولة ولا تُعاد تلقائياً.
    return fail('uncertain', 'unexpected_error', { detail: (error as Error)?.message ?? null });
  }
  const base = { httpStatus: error.httpStatus, telegramErrorCode: null, detail: error.message };
  switch (error.code) {
    case 'flood_wait':
      return fail('retryable', 'flood_wait', {
        ...base,
        retryAfterSeconds: error.retryAfterSeconds ?? 60,
      });
    case 'server':
      // 5xx: قد يكون الطلب نُفِّذ فعلاً قبل سقوط الخادم ⇒ مجهول، بلا إعادة تلقائية (O04).
      return fail('uncertain', 'server_unknown', base);
    case 'timeout':
      // قد يكون الطلب وصل: لا إعادة تلقائية (O04).
      return fail('uncertain', 'timeout_unknown', base);
    case 'network':
      return fail('uncertain', 'network_unknown', base);
    case 'unauthorized':
      return fail('permanent', 'bot_unauthorized', base);
    case 'forbidden':
      return fail('permanent', 'bot_forbidden', base);
    case 'missing_rights':
      return fail('permanent', 'missing_rights', base);
    case 'bot_blocked':
      return fail('permanent', 'bot_blocked', base);
    case 'chat_not_found':
      return fail('permanent', 'chat_not_found', base);
    case 'too_long':
      return fail('permanent', 'too_long', base);
    case 'bad_request':
      return fail('permanent', 'bad_request', base);
    default:
      return fail('uncertain', 'unknown_outcome', base);
  }
}

export interface RetryPolicy {
  maxAttempts: number;
  windowMs: number;
  backoffMs: number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  windowMs: 6 * 60 * 60 * 1000,
  backoffMs: [30_000, 120_000, 600_000, 1_800_000],
};

/** قرار الإعادة بعد فشل قابل للإعادة. */
export function planRetry(input: {
  attemptNo: number;
  createdAt: Date;
  now: Date;
  failure: SendFailure;
  policy?: RetryPolicy;
}): { retry: true; nextAttemptAt: Date } | { retry: false; errorCode: string } {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  if (input.attemptNo >= policy.maxAttempts) return { retry: false, errorCode: 'retry_exhausted' };
  const elapsed = input.now.getTime() - input.createdAt.getTime();
  if (elapsed >= policy.windowMs) return { retry: false, errorCode: 'retry_window_exceeded' };

  const backoff = policy.backoffMs[Math.min(input.attemptNo - 1, policy.backoffMs.length - 1)] ?? 30_000;
  // 429: يُحترم retry_after حرفياً، ويُؤخذ الأبعد بينه وبين التباعد التصاعدي.
  const delayMs = Math.max(backoff, (input.failure.retryAfterSeconds ?? 0) * 1000);
  const deadline = input.createdAt.getTime() + policy.windowMs;
  const next = Math.min(input.now.getTime() + delayMs, deadline);
  return { retry: true, nextAttemptAt: new Date(next) };
}

/** فاصل إرسال لكل محادثة (تيليجرام: ≤ رسالة/ثانية لكل دردشة). */
export class ChatSpacer {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly intervalMs = 1200,
    private readonly clock: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  ) {}

  async wait(chatId: string): Promise<number> {
    const last = this.last.get(chatId);
    const now = this.clock();
    const waitMs = last === undefined ? 0 : Math.max(0, this.intervalMs - (now - last));
    if (waitMs > 0) await this.sleep(waitMs);
    this.last.set(chatId, this.clock());
    return waitMs;
  }
}

export interface DeliveryWorkerDeps {
  store: Pick<
    DeliveryStore,
    | 'claimPart'
    | 'recoverExpiredLeases'
    | 'blockUnroutableDestinations'
    | 'openAttempt'
    | 'closeAttempt'
    | 'markPartSent'
    | 'markPartStopped'
    | 'scheduleRetry'
    | 'releaseLeases'
    | 'finalizeDelivery'
  >;
  botApi: Pick<BotApiClient, 'sendMessage'>;
  bots: { requireActiveBot(userId: string): Promise<{ token: string }> };
  owner?: string;
  concurrency?: number;
  leaseMs?: number;
  retryPolicy?: RetryPolicy;
  spacer?: ChatSpacer;
  maxVisibleLength?: number;
  clock?: () => Date;
  /** حصر الاستحواذ بمستخدم واحد (عزل الاختبارات أو تشغيل مقيّد مستقبلاً). */
  userId?: string;
  /** نبض الحياة (P4-ب): يُسجَّل في كل دورة، وفشله لا يُسقط الإرسال. */
  heartbeat?: (meta: Record<string, unknown>) => Promise<void>;
}

export interface WorkerTickResult {
  attempted: number;
  ok: number;
  retried: number;
  failed: number;
  uncertain: number;
}

export class DeliveryWorker {
  private readonly owner: string;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly spacer: ChatSpacer;
  private readonly clock: () => Date;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: DeliveryWorkerDeps) {
    this.owner = deps.owner ?? `worker-${process.pid}`;
    this.concurrency = Math.max(1, Math.min(deps.concurrency ?? 3, 3)); // Q10: ≤3
    this.leaseMs = deps.leaseMs ?? 90_000;
    this.spacer = deps.spacer ?? new ChatSpacer();
    this.clock = deps.clock ?? (() => new Date());
  }

  /** دورة واحدة: استعادة لُقى منتهية، إغلاق الموجّه غير الصالح، ثم إرسال حتى حدود التزامن. */
  async tick(): Promise<WorkerTickResult> {
    if (this.ticking) return { attempted: 0, ok: 0, retried: 0, failed: 0, uncertain: 0 };
    this.ticking = true;
    const result: WorkerTickResult = { attempted: 0, ok: 0, retried: 0, failed: 0, uncertain: 0 };
    try {
      if (this.deps.heartbeat) {
        await this.deps.heartbeat({ owner: this.owner, concurrency: this.concurrency }).catch(() => undefined);
      }
      await this.deps.store.recoverExpiredLeases();
      await this.deps.store.blockUnroutableDestinations();

      const slots = Array.from({ length: this.concurrency }, () => this.runSlot());
      for (const outcome of await Promise.all(slots)) {
        if (outcome === 'skipped') continue;
        result.attempted += 1;
        if (outcome === 'ok') result.ok += 1;
        else if (outcome === 'retry') result.retried += 1;
        else if (outcome === 'uncertain') result.uncertain += 1;
        else result.failed += 1;
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }

  private async runSlot(): Promise<SendOutcomeKind> {
    let part: ClaimedPart | null;
    try {
      part = await this.deps.store.claimPart(
        this.owner,
        this.leaseMs,
        this.deps.userId ? { userId: this.deps.userId } : {},
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'تعذّر استحواذ جزء للإرسال');
      // خطأ تشغيلي عام (بلا مالك محدد): يُسجَّل بلا نص استثناء خام.
      await recordErrorEvent({
        scope: 'publishing',
        kind: 'claim_failed',
        code: 'DB_CLAIM_FAILED',
        severity: 'error',
      });
      return 'skipped';
    }
    if (!part) return 'skipped';
    return this.sendPart(part);
  }

  async sendPart(part: ClaimedPart): Promise<SendOutcomeKind> {
    // 1) فحص أخير للنص: القياس بعد تحليل الكيانات، وأي تجاوز ⇒ لا إرسال.
    const visible = htmlVisibleLength(part.text);
    const limit = this.deps.maxVisibleLength ?? 4096;
    if (visible > limit || visible === 0) {
      await this.deps.store.markPartStopped({
        deliveryId: part.deliveryId,
        partId: part.partId,
        status: 'failed',
        errorCode: 'length_violation',
      });
      await this.deps.store.finalizeDelivery(part.deliveryId);
      logger.error({ deliveryId: part.deliveryId, partIndex: part.partIndex, visible }, 'جزء غير صالح للإرسال');
      return 'failed';
    }

    // 2) الرمز قبل أي محاولة: فشله لا يستهلك محاولة إرسال ولا يمسّ النص.
    let token: string;
    try {
      token = (await this.deps.bots.requireActiveBot(part.userId)).token;
    } catch (err) {
      await this.deps.store.markPartStopped({
        deliveryId: part.deliveryId,
        partId: part.partId,
        status: 'failed',
        errorCode: 'bot_unavailable',
      });
      await this.deps.store.finalizeDelivery(part.deliveryId);
      logger.warn({ deliveryId: part.deliveryId }, `تعذّر تجهيز رمز البوت: ${(err as Error).message}`);
      return 'failed';
    }

    // 3) فاصل المحادثة ثم حفظ المحاولة **قبل** الطلب.
    await this.spacer.wait(part.chatId);
    const attemptId = await this.deps.store.openAttempt({
      deliveryId: part.deliveryId,
      partId: part.partId,
      attemptNo: part.attemptNo,
    });
    if (!attemptId) {
      // المحاولة موجودة سلفاً: عامل آخر سبقنا؛ لا إرسال مزدوج.
      await this.deps.store.releaseLeases({ deliveryId: part.deliveryId, partId: part.partId });
      return 'skipped';
    }

    const startedAt = Date.now();
    try {
      const sent = await this.deps.botApi.sendMessage(token, { chatId: part.chatId, text: part.text });
      await this.deps.store.closeAttempt(attemptId, {
        outcome: 'ok',
        httpStatus: 200,
        durationMs: Date.now() - startedAt,
      });
      await this.deps.store.markPartSent({
        deliveryId: part.deliveryId,
        partId: part.partId,
        telegramMessageId: sent.messageId,
      });
      await this.deps.store.finalizeDelivery(part.deliveryId);
      logger.info(
        { deliveryId: part.deliveryId, partIndex: part.partIndex, attemptNo: part.attemptNo },
        'تم إرسال جزء منشور',
      );
      return 'ok';
    } catch (err) {
      return this.handleFailure(part, attemptId, err, Date.now() - startedAt);
    }
  }

  private async handleFailure(
    part: ClaimedPart,
    attemptId: string,
    error: unknown,
    durationMs: number,
  ): Promise<SendOutcomeKind> {
    const failure = classifySendFailure(error);
    const patch: AttemptPatch = {
      outcome: failure.outcome,
      httpStatus: failure.httpStatus,
      telegramErrorCode: failure.telegramErrorCode,
      errorCode: failure.errorCode,
      errorDetail: failure.detail,
      retryAfterSeconds: failure.retryAfterSeconds,
      durationMs,
    };
    await this.deps.store.closeAttempt(attemptId, patch);

    // P4-ج: كل فشل إرسال حدثٌ في سجل الأخطاء — بالمستخدم والنطاق والرمز، وبلا محتوى.
    await recordErrorEvent({
      scope: 'publishing',
      kind: failure.outcome === 'retryable' ? 'send_retryable' : 'send_failed',
      code: failure.errorCode,
      severity: failure.outcome === 'uncertain' ? 'critical' : failure.outcome === 'permanent' ? 'error' : 'warn',
      userId: part.userId,
      detail: failure.httpStatus === null ? null : `http.${failure.httpStatus}`,
    });

    if (failure.outcome === 'retryable') {
      const decision = planRetry({
        attemptNo: part.attemptNo,
        createdAt: part.createdAt,
        now: this.clock(),
        failure,
        ...(this.deps.retryPolicy ? { policy: this.deps.retryPolicy } : {}),
      });
      if (decision.retry) {
        await this.deps.store.scheduleRetry({
          deliveryId: part.deliveryId,
          partId: part.partId,
          nextAttemptAt: decision.nextAttemptAt,
          errorCode: failure.errorCode,
        });
        logger.warn(
          {
            deliveryId: part.deliveryId,
            partIndex: part.partIndex,
            attemptNo: part.attemptNo,
            errorCode: failure.errorCode,
            nextAttemptAt: decision.nextAttemptAt.toISOString(),
          },
          'فشل قابل للإعادة — أُعيد جدولة الجزء',
        );
        return 'retry';
      }
      await this.deps.store.markPartStopped({
        deliveryId: part.deliveryId,
        partId: part.partId,
        status: 'failed',
        errorCode: decision.errorCode,
      });
      await this.deps.store.finalizeDelivery(part.deliveryId);
      return 'failed';
    }

    if (failure.outcome === 'permanent') {
      await this.deps.store.markPartStopped({
        deliveryId: part.deliveryId,
        partId: part.partId,
        status: 'failed',
        errorCode: failure.errorCode,
      });
      await this.deps.store.finalizeDelivery(part.deliveryId);
      logger.warn(
        { deliveryId: part.deliveryId, partIndex: part.partIndex, errorCode: failure.errorCode },
        'فشل نهائي في إرسال جزء',
      );
      return 'failed';
    }

    // O04: نتيجة مجهولة ⇒ لا إعادة تلقائية، ودليل بشري مطلوب.
    await this.deps.store.markPartStopped({
      deliveryId: part.deliveryId,
      partId: part.partId,
      status: 'uncertain',
      errorCode: failure.errorCode,
    });
    await this.deps.store.finalizeDelivery(part.deliveryId);
    logger.warn(
      { deliveryId: part.deliveryId, partIndex: part.partIndex, errorCode: failure.errorCode },
      'نتيجة إرسال مجهولة — تحتاج دليلاً بشرياً ولا تُعاد تلقائياً',
    );
    return 'uncertain';
  }

  start(intervalMs = 3000): void {
    if (this.running) return;
    this.running = true;
    const loop = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'دورة عامل النشر فشلت');
      }
      if (this.running) this.timer = setTimeout(() => void loop(), intervalMs);
    };
    this.timer = setTimeout(() => void loop(), 0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
