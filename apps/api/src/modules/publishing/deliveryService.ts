/**
 * خدمة التسليمات (الدفعة 7-د): قرار المراجعة البشرية (D01) وتسوية النتيجة المجهولة (O04).
 *
 * - الموافقة تُثبّت نسخة الخطة (`approved_version = plan_version`)؛ أي إعادة تخطيط لاحقة تُبطلها
 *   فلا يُرسَل ما لم يوافق عليه الإنسان.
 * - الرفض يُلغي التسليم بلا إرسال ولا حذف أثر.
 * - النتيجة المجهولة **لا تُسوّى تلقائياً**: تُقبل شهادة بشرية واحدة (`message_id` أو `manual_check`),
 *   ولا تُقبل على تسليم غير مجهول (409) ولا من غير مالكه (404).
 */
import { recordAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import type { DeliveryDetail, DeliveryStore, RepublishRefusal } from './deliveryStore.js';

export interface DeliveryServiceDeps {
  store: Pick<DeliveryStore, 'review' | 'recordEvidence' | 'detail' | 'prepareRepublish'>;
  /** المخطِّط نفسه المستخدم في التوجيه: مصدر واحد لبناء الأجزاء (لا نسخة ثانية للخطة). */
  planner?: { plan(deliveryId: string, userId: string): Promise<{ ok: boolean; parts: number; reason?: string }> };
}

/** رسائل الرفض الصريحة لإعادة النشر (Q20): كل سبب له نصّه، بلا رسالة عامة مبهمة. */
const REPUBLISH_MESSAGES: Record<RepublishRefusal, { code: string; message: string }> = {
  not_found: { code: 'delivery_not_found', message: 'التسليم غير موجود.' },
  uncertain_forbidden: {
    code: 'republish_uncertain_forbidden',
    message:
      'لا يمكن إعادة نشر تسليم نتيجته مجهولة: قد تكون الرسالة وصلت فعلاً. سجّل دليلاً بشرياً (معرّف الرسالة أو تحقّق يدوي) أولاً.',
  },
  not_republishable: {
    code: 'delivery_not_republishable',
    message: 'إعادة النشر متاحة فقط للتسليمات الفاشلة أو الملغاة أو المحجوبة.',
  },
  limit_reached: {
    code: 'republish_limit_reached',
    message: 'بلغ هذا التسليم الحد الأقصى لإعادة النشر (3 مرات).',
  },
  content_expired: {
    code: 'republish_content_expired',
    message: 'انتهت مدة احتفاظ محتوى الرسالة، فلا يمكن بناء خطة جديدة. أعد التقاط الرسالة أو أنشئ مصدراً جديداً.',
  },
};

export interface EvidenceInput {
  method: 'message_id' | 'manual_check';
  decision: 'published' | 'not_published';
  telegramMessageId?: string | null;
  note?: string | null;
}

export class DeliveryService {
  constructor(private readonly deps: DeliveryServiceDeps) {}

  async detail(deliveryId: string, userId: string): Promise<DeliveryDetail> {
    const detail = await this.deps.store.detail(deliveryId, userId);
    if (!detail) throw notFound('التسليم غير موجود.');
    return detail;
  }

  async approve(input: { userId: string; deliveryId: string; ip?: string | null }): Promise<DeliveryDetail> {
    await this.detail(input.deliveryId, input.userId);
    const ok = await this.deps.store.review(input.deliveryId, input.userId, 'approve', {});
    if (!ok) {
      throw conflict('delivery_not_reviewable', 'لا يمكن اعتماد هذا التسليم: ليس بانتظار مراجعة.');
    }
    await recordAudit({
      actorUserId: input.userId,
      action: 'publishing.delivery_approved',
      targetType: 'delivery',
      targetId: input.deliveryId,
      ip: input.ip ?? null,
    });
    return this.detail(input.deliveryId, input.userId);
  }

  async reject(input: {
    userId: string;
    deliveryId: string;
    reason?: string | null;
    ip?: string | null;
  }): Promise<DeliveryDetail> {
    await this.detail(input.deliveryId, input.userId);
    const ok = await this.deps.store.review(input.deliveryId, input.userId, 'reject', {
      reason: input.reason ?? 'مرفوض من المراجعة البشرية',
    });
    if (!ok) {
      throw conflict('delivery_not_reviewable', 'لا يمكن رفض هذا التسليم: ليس بانتظار مراجعة.');
    }
    await recordAudit({
      actorUserId: input.userId,
      action: 'publishing.delivery_rejected',
      targetType: 'delivery',
      targetId: input.deliveryId,
      ip: input.ip ?? null,
      metadata: { hasReason: Boolean(input.reason) },
    });
    return this.detail(input.deliveryId, input.userId);
  }

  /**
   * إعادة النشر (P4-هـ، Q20): **إعادة تخطيط** لا إرسال ثانٍ مباشر.
   *
   * - مسموحة فقط لـ`failed`/`cancelled`/`blocked`، وسقفها 3.
   * - **ممنوعة منعاً باتاً على `uncertain`**: النتيجة المجهولة تُحسم بدليل بشري لا بخطة جديدة،
   *   وإلا صار في الوجهة منشوران لنفس الرسالة.
   * - الخطة الجديدة تمرّ بكل سياسات التخطيط (الطول، الحجب، انتهاء الاحتفاظ) فلا تُلتفّ القيود.
   * - أي رفض يُعاد برمزه الصريح (409) وبرسالة تشرح السبب والبديل.
   */
  async republish(input: {
    userId: string;
    deliveryId: string;
    ip?: string | null;
  }): Promise<DeliveryDetail> {
    const existing = await this.deps.store.detail(input.deliveryId, input.userId);
    if (!existing) throw notFound('التسليم غير موجود.');

    if (existing.status === 'uncertain') {
      const refusal = REPUBLISH_MESSAGES.uncertain_forbidden;
      throw conflict(refusal.code, refusal.message);
    }
    if (!existing.republish.allowed) {
      const refusal = REPUBLISH_MESSAGES[(existing.republish.reason as RepublishRefusal) ?? 'not_republishable'];
      throw conflict(refusal.code, refusal.message);
    }

    const prepared = await this.deps.store.prepareRepublish(input.deliveryId, input.userId);
    if (!prepared.ok) {
      // الحالة تغيّرت بين القراءة والتنفيذ: نُعيد سبب الرفض الفعلي لا رسالة عامة.
      const refusal = REPUBLISH_MESSAGES[prepared.reason];
      throw conflict(refusal.code, refusal.message);
    }

    if (this.deps.planner) {
      const planned = await this.deps.planner.plan(input.deliveryId, input.userId);
      if (!planned.ok) {
        await recordAudit({
          actorUserId: input.userId,
          action: 'publishing.delivery_republish_failed',
          targetType: 'delivery',
          targetId: input.deliveryId,
          outcome: 'failure',
          ip: input.ip ?? null,
          metadata: { republishCount: prepared.republishCount, reason: planned.reason ?? 'unknown' },
        });
        throw conflict(
          'republish_blocked',
          planned.reason === 'content_expired'
            ? REPUBLISH_MESSAGES.content_expired.message
            : 'تعذّرت إعادة التخطيط: النص يتجاوز سياسة الطول لهذا المسار، فلا إرسال.',
        );
      }
    }

    await recordAudit({
      actorUserId: input.userId,
      action: 'publishing.delivery_republished',
      targetType: 'delivery',
      targetId: input.deliveryId,
      ip: input.ip ?? null,
      metadata: { republishCount: prepared.republishCount, previousStatus: existing.status },
    });
    return this.detail(input.deliveryId, input.userId);
  }

  async evidence(input: {
    userId: string;
    deliveryId: string;
    data: EvidenceInput;
    ip?: string | null;
  }): Promise<DeliveryDetail> {
    const existing = await this.deps.store.detail(input.deliveryId, input.userId);
    if (!existing) throw notFound('التسليم غير موجود.');
    if (existing.status !== 'uncertain') {
      throw conflict('delivery_not_uncertain', 'الدليل يُطلب فقط لتسليم نتيجته مجهولة.');
    }
    if (input.data.method === 'message_id' && !input.data.telegramMessageId) {
      throw conflict('evidence_message_id_required', 'أدخل معرّف الرسالة المرئية في الوجهة.');
    }

    const ok = await this.deps.store.recordEvidence({
      deliveryId: input.deliveryId,
      userId: input.userId,
      method: input.data.method,
      decision: input.data.decision,
      telegramMessageId: input.data.telegramMessageId ?? null,
      note: input.data.note ?? null,
    });
    if (!ok) {
      throw conflict('delivery_not_uncertain', 'تغيّرت حالة التسليم قبل تسجيل الدليل. أعد التحميل.');
    }
    await recordAudit({
      actorUserId: input.userId,
      action: 'publishing.delivery_evidence',
      targetType: 'delivery',
      targetId: input.deliveryId,
      ip: input.ip ?? null,
      metadata: { method: input.data.method, decision: input.data.decision },
    });
    return this.detail(input.deliveryId, input.userId);
  }
}
