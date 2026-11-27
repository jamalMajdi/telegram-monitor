/**
 * خدمة لوحة المستخدم (P4-أ): تجميع العدّادات + تنبيهات مشتقّة + ذاكرة قصيرة.
 *
 * قرارات معتمدة:
 * - Q16: استعلامات تجميعية حيّة + ذاكرة 10–15 ثانية لكل مستخدم (لا جداول لقطات في v1).
 * - Q30: ترقيم مؤشر/حدود صريحة، وكل قائمة بحد أقصى.
 * - D07: لا نصوص رسائل ولا قيم تواصل — أعداد وتواريخ وتنبيهات فقط.
 */
import type { ActivityRow, DashboardCounts, DashboardStore } from './dashboardRepository.js';

export interface DashboardAlert {
  key: 'needs_reauth' | 'uncertain_delivery' | 'awaiting_review' | 'no_source' | 'no_destination';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  href: string;
}

export interface DashboardSummary {
  counts: DashboardCounts;
  alerts: DashboardAlert[];
  generatedAt: string;
  cached: boolean;
}

const DEFAULT_TTL_MS = 15_000;
const MAX_ACTIVITY_LIMIT = 50;

export class DashboardService {
  private readonly cache = new Map<string, { at: number; value: DashboardSummary }>();

  constructor(
    private readonly deps: {
      store: Pick<DashboardStore, 'counts' | 'activity'>;
      ttlMs?: number;
      clock?: () => number;
    },
  ) {}

  private get ttl(): number {
    return this.deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  private get now(): number {
    return this.deps.clock ? this.deps.clock() : Date.now();
  }

  /** يُبطل ذاكرة مستخدم واحد (يُستدعى بعد أي كتابة تخصّه). */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  async summary(userId: string, options: { fresh?: boolean } = {}): Promise<DashboardSummary> {
    const hit = this.cache.get(userId);
    if (!options.fresh && hit && this.now - hit.at < this.ttl) {
      return { ...hit.value, cached: true };
    }
    const counts = await this.deps.store.counts(userId);
    const value: DashboardSummary = {
      counts,
      alerts: buildAlerts(counts),
      generatedAt: new Date(this.now).toISOString(),
      cached: false,
    };
    this.cache.set(userId, { at: this.now, value });
    return value;
  }

  /**
   * عدّادات خام بلا تنبيهات ولا ذاكرة قصيرة — تستهلكها خدمة التنبيهات (P4-و).
   * تُقرأ طازجةً عن قصد: التنبيه يجب أن يطابق الحالة الحقيقية لا لقطة عمرها 15 ثانية.
   */
  async counts(userId: string): Promise<DashboardCounts> {
    return this.deps.store.counts(userId);
  }

  async activity(userId: string, limit: number): Promise<ActivityRow[]> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), MAX_ACTIVITY_LIMIT));
    return this.deps.store.activity(userId, bounded);
  }
}

/**
 * التنبيهات مشتقّة من الأرقام لا مخترعة: كل تنبيه يقابل حالة قابلة للتحقق في نفس الاستعلام.
 * (Q26 يعتمد عتبات التشغيل؛ هذه تنبيهات «حالة مالك» لا عتبات نظام.)
 */
export function buildAlerts(counts: DashboardCounts): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];

  if (counts.telegram.needsReauth > 0) {
    alerts.push({
      key: 'needs_reauth',
      severity: 'critical',
      message: `${counts.telegram.needsReauth} حساب تيليجرام يحتاج إعادة تسجيل الدخول — المراقبة متوقفة عنه.`,
      href: '/telegram',
    });
  }
  if (counts.deliveries.uncertain > 0) {
    alerts.push({
      key: 'uncertain_delivery',
      severity: 'critical',
      message: `${counts.deliveries.uncertain} تسليم بنتيجة مجهولة ينتظر دليلاً بشرياً (لا إعادة تلقائية).`,
      href: '/telegram/publish',
    });
  }
  if (counts.deliveries.awaitingReview > 0) {
    alerts.push({
      key: 'awaiting_review',
      severity: 'warning',
      message: `${counts.deliveries.awaitingReview} تسليم بانتظار مراجعتك قبل الإرسال.`,
      href: '/telegram/publish',
    });
  }
  if (counts.sources.total === 0) {
    alerts.push({
      key: 'no_source',
      severity: 'info',
      message: 'لا يوجد مصدر مراقَب بعد — أضف قناة أو مجموعة لتبدأ المراقبة.',
      href: '/telegram/sources',
    });
  } else if (counts.destinations.active === 0) {
    alerts.push({
      key: 'no_destination',
      severity: 'info',
      message: 'لا توجد وجهة نشر فعّالة — أضف قناة نشر واربطها بمسار.',
      href: '/telegram/publish',
    });
  }
  return alerts;
}
