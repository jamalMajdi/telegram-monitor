/**
 * خدمة النتائج والمراجعة (الخطوة 6).
 *
 * - تُكمل المعالجة: تصنيف حتمي ← تحديد القالب (O02) ← تخزين النتيجة.
 * - تُهيّئ للواجهة: قائمة مراجعة، تفاصيل رسالة، تعديل يدوي للتصنيف، وتعليم «تمت المراجعة».
 * - الحجب مفروض هنا: النص الأصلي يُعاد **مقنَّعاً** في مواضع التواصل، والقيم المحجوبة وحدها تُمرَّر للقالب.
 */
import { logger } from '../../lib/logger.js';
import type { ConfigSnapshot } from './ruleConfigRepository.js';
import type { RuleConfigStore } from './ruleConfigRepository.js';
import { ClassificationService, type ClassificationResult } from './classificationService.js';
import { resolveTemplate, type TemplateSelection } from './templateResolver.js';
import { renderTemplate, type RenderedPost } from './templateRenderer.js';
import type {
  ResultDetailRow,
  ResultListFilter,
  ResultsStore,
  ResultSummaryRow,
  ReviewState,
} from './resultsRepository.js';

/**
 * مؤشِّر صفحة النتائج: (وقت الاستلام، معرّف الهوية) مُرمَّزاً.
 *
 * الشكل `r1:<iso>:<uuid>` داخل base64url — يمنع العميل من تخمين مفاتيح غير موجودة،
 * وأي مؤشِّر لا يطابق الشكل يُرفض صراحةً (400) بدل إرجاع صفحة عشوائية.
 */
export function encodeResultsCursor(receivedAt: string, identityId: string): string {
  return Buffer.from(`r1:${receivedAt}:${identityId}`, 'utf8').toString('base64url');
}

export function decodeResultsCursor(cursor: string): { receivedAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^r1:(\d{4}-\d{2}-\d{2}T[0-9:.]+Z):([0-9a-f-]{36})$/.exec(raw);
    if (!match) return null;
    return { receivedAt: match[1]!, id: match[2]! };
  } catch {
    return null;
  }
}

export interface ResultProcessingSummary {
  classification: ClassificationResult;
  selection: TemplateSelection;
  needsReview: boolean;
}

export interface ReviewHint {
  code: 'ambiguous_classification' | 'low_confidence' | 'uncertain_fields' | 'uncertain_contacts';
  label: string;
  /** القيمة المقيسة (ثقة أو عدد) عند وجودها. */
  value?: number;
}

export interface ResultDetailResponse {
  message: ResultDetailRow & { classification: EffectiveClassification };
  /** أسباب وقف الرسالة للمراجعة، بلغة مفهومة — تُشتق من نفس الشروط التي حكمت القرار. */
  reviewHints: ReviewHint[];
  originalText: string | null;
  caption: string | null;
  fields: { key: string; value: string; confidence: number; ambiguous: boolean; source: string; span: [number, number]; cue: string }[];
  contacts: { kind: string; masked: string; confidence: number; ambiguous: boolean; source: string; span: [number, number] }[];
  filters: { id: string; name: string; priority: number }[];
  rendered: RenderedPost;
}

export interface EffectiveClassification {
  id: string | null;
  name: string | null;
  confidence: number | null;
  ambiguous: boolean;
  origin: 'automatic' | 'manual' | null;
  automatic: { id: string | null; name: string | null; confidence: number | null } | null;
  manual: { id: string | null; name: string | null } | null;
}

/** يستبدل كل موضع تواصل بقيمته المحجوبة داخل النص الأصلي (O03). */
export function maskContactSpans(
  text: string,
  contacts: { spanStart: number; spanEnd: number; masked: string; source: 'text' | 'caption' }[],
  source: 'text' | 'caption',
): string {
  const relevant = contacts
    .filter((contact) => contact.source === source)
    .sort((a, b) => b.spanStart - a.spanStart);
  let masked = text;
  for (const contact of relevant) {
    masked = `${masked.slice(0, contact.spanStart)}${contact.masked}${masked.slice(contact.spanEnd)}`;
  }
  return masked;
}


/**
 * أسباب وقف الرسالة للمراجعة — تُشتق من **نفس** الشروط التي حكمت القرار
 * (`extractionNeedsReview || ambiguous || confidence < 0.6`)، فلا تُخترع أسباب ولا تُخفى أسباب.
 * القرار النهائي يبقى للخادم؛ هذه مجرد ترجمة مقروءة له.
 */
export function buildReviewHints(input: {
  summary: { manualClassificationId: string | null; classificationAmbiguous: boolean; classificationConfidence: number | null };
  effective: EffectiveClassification;
  fields: { ambiguous: boolean; confidence: number }[];
  contacts: { ambiguous: boolean; confidence: number }[];
}): ReviewHint[] {
  const hints: ReviewHint[] = [];
  // تصنيف يدوي = حُسم الأمر، فلا تُعرض أسباب آلية.
  if (input.summary.manualClassificationId) return hints;

  if (input.effective.ambiguous) {
    hints.push({
      code: 'ambiguous_classification',
      label: 'أكثر من تصنيف طابق الرسالة — يحتاج تأكيدك',
    });
  }
  const confidence = input.summary.classificationConfidence;
  if (confidence !== null && confidence < 0.6) {
    hints.push({ code: 'low_confidence', label: 'ثقة التصنيف منخفضة', value: confidence });
  }
  const weakField = input.fields.find((field) => field.ambiguous || field.confidence < 0.6);
  if (weakField) {
    hints.push({
      code: 'uncertain_fields',
      label: 'حقل مستخرج غير مؤكد',
      value: weakField.confidence,
    });
  }
  const weakContact = input.contacts.find((contact) => contact.ambiguous || contact.confidence < 0.6);
  if (weakContact) {
    hints.push({
      code: 'uncertain_contacts',
      label: 'رقم تواصل غير مؤكد',
      value: weakContact.confidence,
    });
  }
  return hints;
}

export class ResultsService {
  constructor(
    private readonly deps: {
      results: ResultsStore;
      config: Pick<RuleConfigStore, 'listClassifications' | 'loadSnapshot'>;
    },
  ) {}

  /** المرحلة الأخيرة من المعالجة: التصنيف ثم اختيار القالب (O02). */
  async classifyAndSelectTemplate(input: {
    userId: string;
    identityId: string;
    sourceId: string;
    text: string;
    caption: string;
    matchedFilterIds: string[];
    extractionNeedsReview: boolean;
  }): Promise<ResultProcessingSummary> {
    const snapshot = await this.deps.config.loadSnapshot(input.userId);
    const classification = await new ClassificationService({
      snapshot: async () => snapshot,
    }).classify({
      userId: input.userId,
      sourceId: input.sourceId,
      text: input.text,
      caption: input.caption,
    });

    const selection = resolveTemplate({
      snapshot,
      sourceId: input.sourceId,
      matchedFilterIds: input.matchedFilterIds,
      classificationId: classification.classificationId,
      // مسار النشر مؤجَّل للمرحلة الثالثة — لا يُمرَّر أي قالب مسار الآن.
      routeTemplateId: null,
    });

    const needsReview =
      input.extractionNeedsReview || classification.ambiguous || classification.confidence < 0.6;

    await this.deps.results.saveClassificationAndTemplate({
      identityId: input.identityId,
      sourceId: input.sourceId,
      classification: {
        id: classification.classificationId,
        name: classification.classificationName,
        confidence: classification.confidence,
        ambiguous: classification.ambiguous,
        evidence: classification.evidence,
        version: classification.version,
      },
      selection: {
        templateId: selection.templateId,
        templateName: selection.templateName,
        resolvedBy: selection.resolvedBy,
        details: selection.details,
      },
      needsReview,
    });

    logger.debug(
      {
        identityId: input.identityId,
        classification: classification.classificationName,
        templateResolvedBy: selection.resolvedBy,
        needsReview,
      },
      'تم تصنيف الرسالة واختيار قالبها',
    );

    return { classification, selection, needsReview };
  }

  /**
   * صفحة نتائج: المؤشِّر مبني على آخر صف في الصفحة، ومُشفَّر حتى لا يُفترض في العميل أي ترتيب.
   * `total` يُعاد فقط في وضع `offset` القديم.
   */
  async list(input: { userId: string; filter: ResultListFilter }): Promise<{
    rows: ResultSummaryRow[];
    total: number | null;
    nextCursor: string | null;
  }> {
    const page = await this.deps.results.list(input);
    const last = page.rows[page.rows.length - 1];
    return {
      rows: page.rows,
      total: page.total,
      nextCursor: page.hasMore && last ? encodeResultsCursor(last.receivedAt, last.identityId) : null,
    };
  }

  async detail(input: { userId: string; identityId: string }): Promise<ResultDetailResponse | null> {
    const detail = await this.deps.results.detail(input);
    if (!detail) return null;

    const snapshot = await this.snapshotFor(input.userId);
    const template = snapshot.templates.find((candidate) => candidate.id === detail.summary.templateId) ?? null;

    const rendered = renderTemplate({
      template,
      extracted: detail.fields.map((field) => ({
        fieldKey: field.fieldKey,
        value: field.value,
        confidence: field.confidence,
        ambiguous: field.ambiguous,
      })),
      contacts: detail.contacts.map((contact) => ({
        kind: contact.kind,
        masked: contact.masked,
        confidence: contact.confidence,
      })),
    });

    const effective: EffectiveClassification = {
      id: detail.summary.classificationId,
      name: detail.summary.classificationName,
      confidence:
        detail.summary.classificationOrigin === 'manual' ? 1 : detail.summary.classificationConfidence,
      // يُعرض الغموض الحقيقي: هو أحد أسباب وقف الرسالة للمراجعة، وإخفاؤه يُبقي المدير بلا تفسير.
      ambiguous: detail.summary.manualClassificationId ? false : detail.summary.classificationAmbiguous,
      origin: detail.summary.classificationOrigin,
      automatic: detail.summary.autoClassificationId
        ? {
            id: detail.summary.autoClassificationId,
            name: detail.summary.autoClassificationName,
            confidence: detail.summary.autoClassificationConfidence,
          }
        : null,
      manual: detail.summary.manualClassificationId
        ? { id: detail.summary.manualClassificationId, name: detail.summary.manualClassificationName }
        : null,
    };

    return {
      message: { ...detail.summary, classification: effective },
      reviewHints: buildReviewHints({
        summary: detail.summary,
        effective,
        fields: detail.fields,
        contacts: detail.contacts,
      }),
      // النص الأصلي يُعاد مقنَّعاً: لا رقم خام يخرج من الواجهة (O03).
      originalText: detail.text === null ? null : maskContactSpans(detail.text, detail.contacts, 'text'),
      caption: detail.caption === null ? null : maskContactSpans(detail.caption, detail.contacts, 'caption'),
      fields: detail.fields.map((field) => ({
        key: field.fieldKey,
        value: field.value,
        confidence: field.confidence,
        ambiguous: field.ambiguous,
        source: field.source,
        span: [field.spanStart, field.spanEnd],
        cue: field.cue,
      })),
      contacts: detail.contacts.map((contact) => ({
        kind: contact.kind,
        masked: contact.masked,
        confidence: contact.confidence,
        ambiguous: contact.ambiguous,
        source: contact.source,
        span: [contact.spanStart, contact.spanEnd],
      })),
      filters: detail.matches.map((match) => ({
        id: match.filterId,
        name: match.filterName,
        priority: match.priority,
      })),
      rendered,
    };
  }

  async setReview(input: {
    userId: string;
    identityId: string;
    reviewState: ReviewState;
  }): Promise<boolean> {
    return this.deps.results.setReviewState(input);
  }

  /** التعديل اليدوي للتصنيف — يغلب في العرض فوراً (O02). */
  async setManualClassification(input: {
    userId: string;
    identityId: string;
    classificationId: string | null;
  }): Promise<{ ok: boolean; reason?: 'not_found' | 'invalid_classification' }> {
    if (input.classificationId) {
      const classifications = await this.deps.config.listClassifications(input.userId);
      const target = classifications.find((item) => item.id === input.classificationId);
      if (!target) return { ok: false, reason: 'invalid_classification' };
      const saved = await this.deps.results.setManualClassification({
        userId: input.userId,
        identityId: input.identityId,
        classification: { id: target.id, name: target.name },
      });
      if (!saved) return { ok: false, reason: 'not_found' };
    } else {
      const saved = await this.deps.results.setManualClassification({
        userId: input.userId,
        identityId: input.identityId,
        classification: null,
      });
      if (!saved) return { ok: false, reason: 'not_found' };
    }

    // التعديل اليدوي يعني أن الرسالة روجعت فعلاً.
    await this.deps.results.setReviewState({
      userId: input.userId,
      identityId: input.identityId,
      reviewState: 'reviewed',
    });
    return { ok: true };
  }

  private async snapshotFor(userId: string): Promise<ConfigSnapshot> {
    return this.deps.config.loadSnapshot(userId);
  }
}
