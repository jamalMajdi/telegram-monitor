/**
 * خدمة التنبيهات الداخلية (P4-و).
 *
 * المبدأ: التنبيه **مشتقّ** من حالة قابلة للتحقق، لا مخترع ولا مكتوب بيد بشر.
 * المصادر الثلاثة:
 *   1) عدّادات لوحة المستخدم (`DashboardService.counts`) — بيانات المستخدم وحده.
 *   2) صحّة العامل (`OpsService.readiness`) — حقيقة نظام، تُنسخ لكل مستخدم يملك نشراً.
 *   3) عتبات قابلة للضبط (`system_settings`) — Q26.
 *
 * قرارات صريحة:
 * - **لا نص حر**: كل تنبيه `alert_key` آلي من قاموس مغلق + أرقام. الواجهة تترجم المفتاح.
 * - **لا إغراق**: تنبيه نشط واحد لكل مفتاح؛ المزامنة throttled لكل مستخدم (افتراضي 20 ثانية)
 *   حتى لا يتحوّل فتح الصفحة إلى حمل كتابة على القاعدة.
 * - **التصعيد يُعيد الفتح**: اعتراف المستخدم بتنبيه تحذيري لا يُسقط تنبيهاً حرجاً لاحقاً.
 */
import { logger } from '../../lib/logger.js';
import type { DashboardCounts } from '../dashboard/dashboardRepository.js';
import type { AlertCounts, AlertDraft, AlertRow, NotificationsStore } from './notificationsRepository.js';

export type WorkerHealthState = 'ok' | 'stale' | 'missing';

export interface NotificationThresholds {
  /** عدد التسليمات المجهولة الذي يرفع التنبيه إلى حرج. */
  uncertainThreshold: number;
}

export interface NotificationSources {
  counts(userId: string): Promise<DashboardCounts>;
  workerHealth(): Promise<{ state: WorkerHealthState; lastSeenSeconds: number | null }>;
  /**
   * عدد الوجهات التي أصابها فشل نشر متكرر (P0 — تدقيق ما قبل التسليم).
   * لا يُمرَّر في الاختبارات الوحدوية ولا في النشر المعطَّل ⇒ لا تنبيه بلا مصدر حقيقة.
   */
  destinationFailures?: (userId: string) => Promise<number>;
}

export interface NotificationListResult {
  notifications: AlertRow[];
  nextCursor: string | null;
  limit: number;
}

/** عتبة «فشل متكرر» لوجهة واحدة (ثابتة ومعلنة في `destinationHealth.ts`). */
const DESTINATION_FAILURE_THRESHOLD = 3;

const DEFAULT_THROTTLE_MS = 20_000;
const DEFAULT_UNCERTAIN_THRESHOLD = 3;
const MAX_LIMIT = 100;

/**
 * بناء التنبيهات من الحقيقة — دالة نقية قابلة للاختبار بلا قاعدة بيانات.
 *
 * قاعدة «من يهمّه ماذا»:
 * - مشكلة العامل تخصّ من يملك نشراً (وجهة واحدة على الأقل)؛ من لا ينشر لا يُزعج.
 * - التسليمات المجهولة تخصّ صاحبها دائماً ولو كانت واحدة (القرار البشري مطلوب).
 * - `no_source`/`no_destination` إرشادية (info) لا إنذار.
 */
export function buildNotificationDrafts(input: {
  counts: DashboardCounts;
  worker: { state: WorkerHealthState; lastSeenSeconds: number | null };
  thresholds: NotificationThresholds;
  /** عدد الوجهات ذات الفشل المتكرر؛ غيابه يعني «لا مصدر» لا «صفر». */
  failingDestinations?: number;
}): AlertDraft[] {
  const { counts, worker, thresholds } = input;
  const drafts: AlertDraft[] = [];
  // ملاحظة D07: قيم الحمولة أرقام/بوليانات/null أو رمز مغلق من قاموس الكود نفسه
  // ('ok'/'stale'/'missing')؛ لا يُشتق أي حرف من بيانات المستخدم.

  if (worker.state !== 'ok' && counts.destinations.total > 0) {
    drafts.push({
      key: 'publish_worker_stale',
      severity: 'critical',
      observedCount: worker.lastSeenSeconds ?? 0,
      payload: { workerState: worker.state, lastSeenSeconds: worker.lastSeenSeconds },
    });
  }

  if (counts.deliveries.uncertain > 0) {
    drafts.push({
      key: 'uncertain_delivery',
      severity: counts.deliveries.uncertain >= thresholds.uncertainThreshold ? 'critical' : 'warning',
      observedCount: counts.deliveries.uncertain,
      payload: { uncertain: counts.deliveries.uncertain, threshold: thresholds.uncertainThreshold },
    });
  }

  if (counts.telegram.needsReauth > 0) {
    drafts.push({
      key: 'needs_reauth',
      severity: 'critical',
      observedCount: counts.telegram.needsReauth,
      payload: { accounts: counts.telegram.needsReauth },
    });
  }

  if ((input.failingDestinations ?? 0) > 0) {
    // وجهة تفشل ثلاث مرات متتالية تعني عطلاً حقيقياً عندها (طرد بوت/حذف قناة/شبكة)،
    // وليس مجرد فشل عابر: التنبيه تحذيري، ويصير حرجاً إذا تكرر في أكثر من وجهة.
    const failing = input.failingDestinations ?? 0;
    drafts.push({
      key: 'destination_failures',
      severity: failing >= 2 ? 'critical' : 'warning',
      observedCount: failing,
      payload: { destinations: failing, threshold: DESTINATION_FAILURE_THRESHOLD },
    });
  }

  if (counts.deliveries.awaitingReview > 0) {
    drafts.push({
      key: 'awaiting_review',
      severity: 'warning',
      observedCount: counts.deliveries.awaitingReview,
      payload: { awaitingReview: counts.deliveries.awaitingReview },
    });
  }

  if (counts.sources.total === 0) {
    drafts.push({ key: 'no_source', severity: 'info', observedCount: 0, payload: {} });
  } else if (counts.destinations.active === 0) {
    drafts.push({ key: 'no_destination', severity: 'info', observedCount: 0, payload: {} });
  }

  return drafts;
}

// الفاصل `|` لا `:` — لأن ISO يحتوي نقاطاً رأسية، وفصل ب`:` كان سيقطع التاريخ.
function encodeCursor(row: AlertRow): string {
  // `first_seen_at` ثابت: التنبيه يُحدَّث (عدّاد/خطورة) بلا أن يتحرك موضعه في الترقيم.
  return Buffer.from(`n1|${row.firstSeenAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): { firstSeenAt: Date; id: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('|');
  if (parts.length !== 3 || parts[0] !== 'n1') return null;
  const at = new Date(parts[1]!);
  const id = parts[2]!;
  if (Number.isNaN(at.getTime())) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
  return { firstSeenAt: at, id };
}

export class NotificationService {
  private readonly lastSync = new Map<string, number>();

  constructor(
    private readonly deps: {
      store: NotificationsStore;
      sources: NotificationSources;
      throttleMs?: number;
      clock?: () => number;
      /** تضمين التنبيهات العامة (صحّة العامل) — يُعطَّل في الاختبارات الوحدوية. */
      workerAlerts?: boolean;
      /**
       * جسر بريد التنبيهات (P0): يُستدعى عند نشوء/تصعيد تنبيه تحذيري أو حرج.
       * غيابه = بلا بريد (المركز الداخلي يعمل كما هو).
       */
      emailAlerts?: {
        enqueue(userId: string, alert: { id: string; key: string; severity: string; observedCount: number }): Promise<boolean>;
      };
    },
  ) {}

  private get now(): number {
    return this.deps.clock ? this.deps.clock() : Date.now();
  }

  private get throttleMs(): number {
    return this.deps.throttleMs ?? DEFAULT_THROTTLE_MS;
  }

  async thresholds(): Promise<NotificationThresholds> {
    const uncertainThreshold = await this.deps.store
      .systemCount('system.uncertain_alert_threshold', DEFAULT_UNCERTAIN_THRESHOLD)
      .catch(() => DEFAULT_UNCERTAIN_THRESHOLD);
    return { uncertainThreshold };
  }

  /**
   * يزامن تنبيهات المستخدم مع حالته الحقيقية.
   * فشل المزامنة **لا يُسقط القراءة**: الصندوق يبقى مقروءاً بما هو محفوظ (تُسجَّل تحذيراً فقط).
   */
  async sync(userId: string, options: { force?: boolean } = {}): Promise<{ synced: boolean }> {
    const last = this.lastSync.get(userId) ?? 0;
    if (!options.force && this.now - last < this.throttleMs) return { synced: false };
    try {
      const [counts, thresholds, worker] = await Promise.all([
        this.deps.sources.counts(userId),
        this.thresholds(),
        this.deps.workerAlerts === false
          ? Promise.resolve({ state: 'ok' as WorkerHealthState, lastSeenSeconds: null })
          : this.deps.sources.workerHealth().catch(() => ({ state: 'ok' as WorkerHealthState, lastSeenSeconds: null })),
      ]);
      const failingDestinations = this.deps.sources.destinationFailures
        ? await this.deps.sources
            .destinationFailures(userId)
            .catch(() => undefined)
        : undefined;
      const drafts = buildNotificationDrafts({
        counts,
        worker,
        thresholds,
        ...(failingDestinations === undefined ? {} : { failingDestinations }),
      });
      const result = await this.deps.store.sync(userId, drafts);
      this.lastSync.set(userId, this.now);
      if (result.created || result.escalated || result.resolved) {
        logger.info({ ...result }, 'مزامنة التنبيهات');
      }
      // بريد التنبيهات: تحذيري وحرج، غير معترَف به، وغير مُبلَّغ سابقاً.
      if (this.deps.emailAlerts) await this.emailUnnotified(userId);
      return { synced: true };
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'تعذّرت مزامنة التنبيهات');
      return { synced: false };
    }
  }

  /**
   * يُدرج بريداً للتنبيهات غير المُبلَّغة ثم يختمها.
   * الفشل هنا **لا يُسقط المزامنة**: التنبيه الداخلي وصل، والبريد يُعاد في الدورة التالية.
   */
  private async emailUnnotified(userId: string): Promise<void> {
    const bridge = this.deps.emailAlerts;
    if (!bridge) return;
    try {
      const alerts = await this.deps.store.listUnnotified(userId, ['critical', 'warning']);
      if (alerts.length === 0) return;
      const sent: string[] = [];
      for (const alert of alerts) {
        const ok = await bridge
          .enqueue(userId, {
            id: alert.id,
            key: alert.alertKey,
            severity: alert.severity,
            observedCount: alert.observedCount,
          })
          .catch(() => false);
        if (ok) sent.push(alert.id);
      }
      if (sent.length > 0) {
        await this.deps.store.markNotified(sent);
        logger.info({ alerts: sent.length }, 'أُدرج بريد تنبيهات');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'تعذّر إدراج بريد التنبيهات');
    }
  }

  async list(
    userId: string,
    options: { status?: 'open' | 'acknowledged' | 'all'; limit?: number; cursor?: string } = {},
  ): Promise<NotificationListResult> {
    await this.sync(userId);
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 25), MAX_LIMIT));
    let cursor: { firstSeenAt: Date; id: string } | undefined;
    if (options.cursor) {
      const parsed = decodeCursor(options.cursor);
      if (!parsed) {
        const err = new Error('invalid_cursor') as Error & { code?: string };
        err.code = 'invalid_cursor';
        throw err;
      }
      cursor = parsed;
    }
    const rows = await this.deps.store.list(userId, {
      status: options.status ?? 'open',
      limit: limit + 1,
      ...(cursor ? { cursor } : {}),
    });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]!) : null;
    return { notifications: page, nextCursor, limit };
  }

  counts(userId: string): Promise<AlertCounts> {
    return this.deps.store.counts(userId);
  }

  async acknowledge(userId: string, id: string): Promise<AlertRow | null> {
    const row = await this.deps.store.acknowledge(userId, id);
    this.lastSync.delete(userId);
    return row;
  }

  async acknowledgeAll(userId: string): Promise<number> {
    const count = await this.deps.store.acknowledgeAll(userId);
    this.lastSync.delete(userId);
    return count;
  }

  /** إبطال التخزين المؤقت للمزامنة بعد أي فعل يغيّر الحالة (يُستدعى من المسارات الأخرى). */
  invalidate(userId: string): void {
    this.lastSync.delete(userId);
  }
}
