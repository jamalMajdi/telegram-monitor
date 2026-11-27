/**
 * محرك التوجيه (الدفعة 7-ب): من «رسالة معالَجة» إلى «تسليمات» بلا إرسال.
 *
 * قواعد معتمدة:
 * - **الوجهة هي وحدة التنفيذ (D05):** أي عدد من المسارات/الفلاتر المؤهلة لوجهة واحدة ⇒ تسليم واحد.
 * - **القالب (O02):** قالب المسار يتقدّم على القالب المحدَّد في المعالجة (مصدر/فلتر/تصنيف/افتراضي).
 * - **المراجعة (D01 + Q4):** طلب أي مسار مؤهل للمراجعة يُلزم الوجهة كلها، والرسالة الموسومة
 *   `needs_review` تُلزم المراجعة حتى لو كان المسار تلقائياً.
 * - **الذرّية:** إنشاء التسليمات وتحديث حالة النشر على الهوية في معاملة واحدة،
 *   مع `on conflict do nothing` على (الهوية، الوجهة) كخط دفاع أخير ضد إعادة المعالجة.
 * - لا نص منشور هنا: خطة الأجزاء والتنسيق في الدفعة 7-ج.
 */
import { withTransaction } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import type { PublishStore, RoutingCandidateRow } from './publishRepository.js';

export interface RoutingOutcome {
  destinations: number;
  deliveries: number;
  reviewRequested: number;
  publishState: 'not_routed' | 'routed' | 'awaiting_review';
}

interface PlannedDelivery {
  destinationId: string;
  routeId: string;
  templateId: string | null;
  reviewRequired: boolean;
  reviewReason: 'route' | 'message' | null;
}

export interface RoutingServiceDeps {
  store: Pick<
    PublishStore,
    | 'identityRoutingContext'
    | 'effectiveClassificationId'
    | 'listRoutingCandidates'
    | 'createDelivery'
    | 'setIdentityPublishState'
  >;
  /** مفتاح تشغيل من البيئة (TG_ROUTING_ENABLED). التعطيل يوقف إنشاء التسليمات فقط. */
  enabled: boolean;
  /** مخطِّط الأجزاء (7-ج): يبني نص المنشور ويُثبّته. غيابه يعني تسليماً بلا أجزاء. */
  planner?: { plan(deliveryId: string, userId: string): Promise<{ ok: boolean; parts: number; reason?: string }> };
}

export class RoutingService {
  constructor(private readonly deps: RoutingServiceDeps) {}

  get enabled(): boolean {
    return this.deps.enabled;
  }

  /**
   * يوجّه رسالة معالَجة إلى وجهاتها. لا يرفع الخطأ أبداً: التوجيه لا يُسقط المعالجة،
   * وفشله يُعاد في النتيجة للتشخيص (نمط Q4 نفسه المستخدم في المعالجة).
   */
  async routeMessage(input: {
    userId: string;
    identityId: string;
    sourceId: string;
    matchedFilterIds: string[];
  }): Promise<RoutingOutcome> {
    const empty: RoutingOutcome = { destinations: 0, deliveries: 0, reviewRequested: 0, publishState: 'not_routed' };
    if (!this.deps.enabled) return empty;

    const context = await this.deps.store.identityRoutingContext(input.identityId, input.userId);
    if (!context) return empty;

    const classificationId = await this.deps.store.effectiveClassificationId(input.identityId);
    const candidates = await this.deps.store.listRoutingCandidates({
      userId: input.userId,
      sourceId: input.sourceId,
      filterIds: input.matchedFilterIds,
      classificationId,
    });
    if (candidates.length === 0) return empty;

    const plan = planDeliveries(candidates, {
      resolvedTemplateId: context.resolvedTemplateId,
      messageNeedsReview: context.reviewState === 'needs_review',
    });

    const createdIds: string[] = [];
    const outcome = await withTransaction(async (client) => {
      let created = 0;
      let reviewRequested = 0;
      for (const item of plan) {
        const inserted = await this.deps.store.createDelivery({
          userId: input.userId,
          identityId: input.identityId,
          destinationId: item.destinationId,
          routeId: item.routeId,
          templateId: item.templateId,
          reviewRequired: item.reviewRequired,
          reviewReason: item.reviewReason,
          client,
        });
        if (inserted) {
          created += 1;
          createdIds.push(inserted);
          if (item.reviewRequired) reviewRequested += 1;
        }
      }
      // حالة النشر على الهوية مشتقة من الخطة لا من عدد الصفوف المُدرجة (إعادة المعالجة لا تغيّر الحالة).
      const anyReview = plan.some((item) => item.reviewRequired);
      const publishState = anyReview ? 'awaiting_review' : 'routed';
      await this.deps.store.setIdentityPublishState(input.identityId, publishState, client);
      return { created, reviewRequested, publishState } as const;
    });

    // التخطيط بعد تثبيت التسليمات: فشله يُغلق التسليم بسببه ولا يُسقط التوجيه.
    if (this.deps.planner) {
      for (const deliveryId of createdIds) {
        try {
          await this.deps.planner.plan(deliveryId, input.userId);
        } catch (err) {
          logger.error(
            { deliveryId, err: (err as Error).message },
            'فشل تخطيط أجزاء التسليم — يبقى التسليم قابلاً لإعادة التخطيط',
          );
        }
      }
    }

    if (outcome.created > 0) {
      logger.info(
        { identityId: input.identityId, destinations: plan.length, created: outcome.created },
        'أُنشئت تسليمات نشر',
      );
    }
    return {
      destinations: plan.length,
      deliveries: outcome.created,
      reviewRequested: outcome.reviewRequested,
      publishState: outcome.publishState,
    };
  }
}

/**
 * تخطيط التسليمات: تجميع المرشّحين حسب الوجهة، واختيار قرار واحد لكل وجهة.
 * المرشّحون مرتَّبون في الاستعلام بحسب `created_at`، فأول مرشّح للوجهة هو صاحب القالب
 * (كسر تعادل حتمي: الأقدم أولاً).
 */
export function planDeliveries(
  candidates: RoutingCandidateRow[],
  context: { resolvedTemplateId: string | null; messageNeedsReview: boolean },
): PlannedDelivery[] {
  const byDestination = new Map<string, PlannedDelivery>();
  for (const candidate of candidates) {
    const existing = byDestination.get(candidate.destinationId);
    const routeWantsReview = candidate.publishMode === 'review';
    if (!existing) {
      const reviewRequired = routeWantsReview || context.messageNeedsReview;
      byDestination.set(candidate.destinationId, {
        destinationId: candidate.destinationId,
        routeId: candidate.routeId,
        templateId: candidate.templateId ?? context.resolvedTemplateId,
        reviewRequired,
        reviewReason: reviewRequired ? (context.messageNeedsReview ? 'message' : 'route') : null,
      });
      continue;
    }
    // مسار آخر إلى الوجهة نفسها: لا يغيّر القالب، لكن طلبه للمراجعة يُلزم الوجهة كلها.
    if (routeWantsReview && !existing.reviewRequired) {
      existing.reviewRequired = true;
      existing.reviewReason = 'route';
    }
  }
  return [...byDestination.values()];
}
