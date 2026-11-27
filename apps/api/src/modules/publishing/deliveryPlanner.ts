/**
 * مخطِّط التسليم (الدفعة 7-ج): يحوّل «رسالة معالَجة + قالب» إلى أجزاء نصية جاهزة للإرسال.
 *
 * - التخطيط يحدث **قبل** أي إرسال، وتُخزَّن الأجزاء بنصوصها المنسَّقة والمحجوبة،
 *   ليُثبَّت قرار المراجعة عليها (`plan_version`) ويمنع التكرار (فهرس فريد لكل جزء).
 * - لا يُخطَّط تسليم بعد انتهاء احتفاظ المحتوى: يُغلق بسبب صريح `content_expired` (O06/D09).
 * - فشل التخطيط (طويل/فارغ/فشل حجب) يُغلق التسليم `blocked` بسببه، ولا يُرسل شيء.
 */
import { createHash } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { contactsLine } from '../processing/templateRenderer.js';
import { detectContacts, maskContact } from '../processing/extraction/contactDetector.js';
import { DEFAULT_ATTRIBUTION_CONFIG, renderAttribution, type AttributionMode } from './attribution.js';
import { planPost, type FooterLine, type PostField, type PlanFailureReason } from './publisher.js';
import type { PublishStore } from './publishRepository.js';

export interface PlanningResult {
  ok: boolean;
  parts: number;
  reason?: 'not_found' | 'content_expired' | PlanFailureReason;
  /**
   * كيف بُني المحتوى:
   * - `template`: القالب أنتج حقولاً حقيقية.
   * - `raw_text`: الاستخراج لم يُنتج أي حقل ⇒ عُرض **النص الأصلي** بدل نشر هيكل فارغ.
   * - `no_template`: لا قالب ⇒ النص الأصلي كما هو.
   */
  source?: 'template' | 'raw_text' | 'no_template';
  /** النمط الفعّال لهوية المصدر/المرسل في هذا المنشور (off ⇒ لم تُضف أسطر هوية). */
  attribution?: AttributionMode;
}

/**
 * يحجب أي جهة تواصل داخل الاسم/العنوان (قد يكون اسم المرسل رقماً أو يوزر تواصل).
 * مقيَّد بفشل آمن: أي استثناء ⇒ يُعاد النص كما هو لأن الحجب النهائي على المحتوى يبقى قائماً،
 * ولن تُبنى أسطر الهوية إلا من قيم مرشَّحة (username بنمط صارم ومعرّف رقمي).
 */
function maskNameValue(value: string): string {
  try {
    const detected = detectContacts({ text: value, caption: '' });
    if (detected.length === 0) return value;
    let output = value;
    for (const contact of [...detected].sort((a, b) => b.spanStart - a.spanStart)) {
      if (contact.source !== 'text') continue;
      const raw = output.slice(contact.spanStart, contact.spanEnd);
      if (!raw) continue;
      output = `${output.slice(0, contact.spanStart)}${maskContact(contact.kind, contact.normalized, contact.raw)}${output.slice(contact.spanEnd)}`;
    }
    return output;
  } catch {
    return value;
  }
}

/**
 * الحقول التي تقبل النص الحرّ كاملاً — يُستخدم أولها لاحتضان النص الأصلي عند فشل الاستخراج.
 * (السبب: منشور بعنوان «التفاصيل» ونص الرسالة أصدق من منشور فارغ أو من رفض بلا بديل.)
 */
const FREE_TEXT_FIELD_KEYS = ['details', 'specs', 'description', 'requirements', 'request_type'];

/** يوحّد المسافات ويقصّ الأطراف — النص الأصلي يُعرض كما ورد بلا تحريف معنوي. */
function plainText(value: string | null | undefined): string {
  return (value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

export class DeliveryPlanner {
  constructor(
    private readonly deps: {
      store: Pick<
        PublishStore,
        | 'loadPlanContext'
        | 'loadExtractionFields'
        | 'loadContactViews'
        | 'loadTemplate'
        | 'savePlan'
        | 'clearPlan'
        | 'setDeliveryStatus'
      >;
      /** سقف طول الجزء (4096 افتراضاً). قابل للخفض في الاختبارات فقط. */
      textLimit?: number;
    },
  ) {}

  /** يبني خطة الأجزاء ويثبّتها. لا يرفع استثناءً للفشل المتوقع (يُسجَّل على التسليم). */
  async plan(deliveryId: string, userId: string): Promise<PlanningResult> {
    const context = await this.deps.store.loadPlanContext(deliveryId, userId);
    if (!context) return { ok: false, parts: 0, reason: 'not_found' };

    const expired = context.retentionExpiresAt === null || context.retentionExpiresAt.getTime() <= Date.now();
    if (expired || (context.messageText === null && context.caption === null)) {
      await this.deps.store.clearPlan(deliveryId, userId);
      await this.deps.store.setDeliveryStatus(deliveryId, userId, 'blocked', 'content_expired');
      return { ok: false, parts: 0, reason: 'content_expired' };
    }

    const source = await this.assembleSource(context.templateId, userId, context.identityId, context);
    // هوية المصدر والمرسل: تُبنى من بيانات التقاط MTProto، وتُخفى كلياً لو أوقفها المستخدم أو تجاوزها المسار.
    const attributionContext = context.attribution ?? {
      routeMode: null,
      config: DEFAULT_ATTRIBUTION_CONFIG,
      source: { title: null, username: null, peerId: null },
      sender: { id: null, username: null, displayName: null, postAuthor: null },
    };
    const attribution = renderAttribution(attributionContext, { maskName: maskNameValue });
    const footer: FooterLine[] = attribution.lines;
    if (source.fallback === 'raw_text') {
      // لا نشر صامت لهيكل فارغ: نُبلّغ بوضوح أن هذا المنشور مبني على النص الأصلي.
      logger.warn(
        { deliveryId, templateId: context.templateId, reason: 'template_produced_no_fields' },
        'لم يُنتج القالب أي حقل — عُرض النص الأصلي بدل نشر قالب فارغ',
      );
    }
    const result = planPost({
      source,
      maxParts: context.maxParts,
      policy: context.lengthPolicy,
      footer,
      ...(this.deps.textLimit ? { limit: this.deps.textLimit } : {}),
    });

    if (!result.ok) {
      // لا أجزاء قديمة تبقى معلّقة بعد إغلاق التسليم: القرار «لا إرسال» يشمل ما خُطِّط سابقاً.
      await this.deps.store.clearPlan(deliveryId, userId);
      await this.deps.store.setDeliveryStatus(deliveryId, userId, 'blocked', result.reason);
      logger.warn(
        { deliveryId, reason: result.reason },
        'تعذّر تخطيط أجزاء النشر — أُغلق التسليم بسببه بلا إرسال',
      );
      return { ok: false, parts: 0, reason: result.reason };
    }

    await this.deps.store.savePlan({
      deliveryId,
      userId,
      charsTotal: result.charsTotal,
      maskingRewrites: result.maskingRewrites,
      parts: result.parts.map((part) => ({
        index: part.index,
        html: part.html,
        visibleLength: part.visibleLength,
        textHash: createHash('sha256').update(part.html, 'utf8').digest('hex'),
      })),
    });
    return { ok: true, parts: result.parts.length, source: source.fallback, attribution: attribution.mode };
  }

  /**
   * تجميع حقول المنشور:
   * - قالب محدَّد ⇒ حقوله بترتيبها وتسمياتها، مع سطر التواصل من القيم المحجوبة وحدها.
   * - بلا قالب ⇒ النص الأصلي كما ورد (نفس سياسة «نص الرسالة المطابقة فقط»)، بلا تسمية.
   */
  private async assembleSource(
    templateId: string | null,
    userId: string,
    identityId: string,
    context: { messageText: string | null; caption: string | null; classificationName: string | null },
  ): Promise<{ title: string | null; fields: PostField[]; fallback: 'template' | 'raw_text' | 'no_template' }> {
    const [fields, contacts] = await Promise.all([
      this.deps.store.loadExtractionFields(identityId),
      this.deps.store.loadContactViews(identityId),
    ]);
    const contactLine = contactsLine(contacts.map((contact) => ({
      kind: contact.kind,
      masked: contact.masked,
      confidence: 1,
    })));

    const template = templateId ? await this.deps.store.loadTemplate(userId, templateId) : null;
    const rawText = plainText(context.messageText ?? context.caption);
    if (!template) {
      return { title: context.classificationName, fields: [{ label: '', value: rawText }], fallback: 'no_template' };
    }

    const best = new Map<string, { value: string; confidence: number }>();
    for (const field of fields) {
      const current = best.get(field.fieldKey);
      if (!current || field.confidence > current.confidence) {
        best.set(field.fieldKey, { value: field.value, confidence: field.confidence });
      }
    }

    const ordered: PostField[] = [];
    const contactFields: PostField[] = [];
    for (const field of template.fields) {
      if (!field.enabled) continue;
      if (field.fieldKey === 'contact') {
        if (contactLine) contactFields.push({ label: field.label, value: contactLine });
        continue;
      }
      const value = best.get(field.fieldKey)?.value;
      if (!value || !value.trim()) continue;
      ordered.push({ label: field.label, value });
    }

    // ── حارس المحتوى الحقيقي (إصلاح خلل 2026-11-25) ─────────────────────────────
    // إن لم يُنتج الاستخراج أي حقل محتوى، فالقالب سينتج عنواناً وفاصلاً فقط. لا ننشر ذلك أبداً:
    //   1) نعرض النص الأصلي في حقل النص الحرّ للقالب (أو بلا تسمية إن لم يوجد).
    //   2) إن كان النص الأصلي نفسه غائباً (انتهاء احتفاظ/رسالة وسائط بلا نص) ⇒ لا حقول ⇒
    //      يُغلق التسليم `empty` ولا يُرسل شيء.
    if (ordered.length === 0) {
      if (!rawText) {
        return { title: null, fields: [], fallback: 'raw_text' };
      }
      // أولوية صريحة: «التفاصيل» أنسب حاضن للنص الحر، ثم المواصفات/الوصف، وأخيراً أي حقل نصي حرّ.
      const freeTextField = FREE_TEXT_FIELD_KEYS.map((key) =>
        template.fields.find((field) => field.enabled && field.fieldKey === key),
      ).find((field): field is NonNullable<typeof field> => Boolean(field));
      const fallbackFields: PostField[] = [
        { label: freeTextField?.label ?? '', value: rawText },
        ...contactFields,
      ];
      return { title: template.name, fields: fallbackFields, fallback: 'raw_text' };
    }

    return { title: template.name, fields: [...ordered, ...contactFields], fallback: 'template' };
  }
}
