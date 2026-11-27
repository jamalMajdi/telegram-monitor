/**
 * خدمة الفلترة (الخطوة 5-أ): تُجيب سؤالاً واحداً لكل رسالة — «هل طابقت أي فلتر؟ وبأي أدلة؟».
 *
 * - القرار حتمي بحسب إصدار الإعدادات (`processing_version`) الذي يُعاد مع كل قرار ويُخزَّن مع النتيجة.
 * - لقطة الإعدادات مصرَّفة (تعابير جاهزة) ومخبّأة في الذاكرة لكل مستخدم، وتُحدَّث عند تغيّر الإصدار.
 * - لا تُخزَّن نصوص الرسائل هنا؛ الدالة تُرجع قيماً فقط.
 */
import { normalizeArabic } from './normalization.js';
import {
  evaluateCompiled,
  evaluateRule,
  normalizeTerm,
  type ConditionHit,
  type RuleInput,
  type RuleMatch,
  type TextVariants,
} from './ruleEngine.js';
import type { ConfigSnapshot, FilterInput, RuleConfigStore } from './ruleConfigRepository.js';

export type FilterReason = 'matched' | 'no_active_filter' | 'no_filter_match';

export interface FilterDecision {
  matched: boolean;
  reason: FilterReason;
  /** المطابقات مرتبة بـpriority ثم الاسم ثم المعرّف (حتمية O02). */
  matches: RuleMatch[];
  /** عدد الفلاتر التي كانت تنطبق على المصدر وجرى تقييمها. */
  evaluatedRules: number;
  /** إصدار إعدادات المعالجة الذي حُسب به القرار. */
  processingVersion: string;
}

export interface FilterTestResult {
  matched: boolean;
  evaluated: number;
  matches: { ruleId: string; ruleName: string; hits: ConditionHit[] }[];
  /** معاينة النسخة المطبَّعة من النص التجريبي (نص المستخدم نفسه، لا يُخزَّن). */
  normalizedPreview: string;
}

/** يبني نسختَي النص (المحافظة/الواسعة) لكل نوع محتوى تقيّمه القواعد. */
export function buildEvaluationInput(
  text: string,
  caption: string,
  withLoose: boolean,
): { combined: TextVariants; text: TextVariants; caption: TextVariants } {
  const make = (value: string): TextVariants => {
    const strict = normalizeArabic(value);
    return withLoose ? { strict, loose: normalizeArabic(value, { foldTaMarbuta: true }) } : { strict, loose: strict };
  };
  const combinedRaw = !text ? caption : !caption || caption === text ? text : `${text} ${caption}`;
  return { combined: make(combinedRaw), text: make(text), caption: make(caption) };
}

export class FilterService {
  private readonly snapshots = new Map<string, ConfigSnapshot>();
  private readonly ready = new Set<string>();

  constructor(
    private readonly store: RuleConfigStore,
    private readonly maxPreviewChars = 400,
  ) {}

  /** يضمن وجود البذور وإصدار الإعدادات لهذا المستخدم (مرة واحدة لكل عملية). */
  async ensureReady(userId: string): Promise<void> {
    if (this.ready.has(userId)) return;
    await this.store.ensureReady(userId);
    this.ready.add(userId);
  }

  /** لقطة الإعدادات الحالية (من الذاكرة ما دام الإصدار لم يتغيّر). */
  async snapshot(userId: string): Promise<ConfigSnapshot> {
    await this.ensureReady(userId);
    const cached = this.snapshots.get(userId);
    if (cached) {
      const current = await this.store.currentVersion(userId);
      if (current === cached.version) return cached;
    }
    const snapshot = await this.store.loadSnapshot(userId);
    this.snapshots.set(userId, snapshot);
    return snapshot;
  }

  /** يُبطل النسخة المخبّأة بعد تعديل إعدادات (نفس العملية). */
  invalidate(userId: string): void {
    this.snapshots.delete(userId);
  }

  async decide(input: { userId: string; sourceId: string; text: string; caption: string }): Promise<FilterDecision> {
    const snapshot = await this.snapshot(input.userId);
    if (snapshot.rules.length === 0) {
      return {
        matched: false,
        reason: 'no_active_filter',
        matches: [],
        evaluatedRules: 0,
        processingVersion: snapshot.version,
      };
    }
    const variants = buildEvaluationInput(input.text, input.caption, snapshot.hasLooseTerms);
    const result = evaluateCompiled(snapshot.rules, input.sourceId, variants);
    if (result.matches.length === 0) {
      return {
        matched: false,
        reason: result.evaluated === 0 ? 'no_active_filter' : 'no_filter_match',
        matches: [],
        evaluatedRules: result.evaluated,
        processingVersion: snapshot.version,
      };
    }
    return {
      matched: true,
      reason: 'matched',
      matches: result.matches,
      evaluatedRules: result.evaluated,
      processingVersion: snapshot.version,
    };
  }

  /** اختبار فلتر محفوظ على نص تجريبي بلا أي حفظ (§12.4). */
  async testSavedFilter(input: {
    userId: string;
    filterId: string;
    text: string;
    caption: string;
  }): Promise<FilterTestResult | null> {
    const snapshot = await this.snapshot(input.userId);
    // البحث في الفلاتر **والتصنيفات**: نفس محرّك التقييم يخدم النوعين، والمستخدم يختبر أياً منهما.
    const rule =
      snapshot.rules.find((candidate) => candidate.input.id === input.filterId) ??
      snapshot.classifications.find((candidate) => candidate.input.id === input.filterId);
    if (!rule) return null;
    const variants = buildEvaluationInput(input.text, input.caption, snapshot.hasLooseTerms);
    const evaluation = evaluateCompiled([rule], null, variants);
    return {
      matched: evaluation.matches.length > 0,
      evaluated: 1,
      matches: evaluation.matches.map((match) => ({
        ruleId: match.ruleId,
        ruleName: match.ruleName,
        hits: match.hits,
      })),
      normalizedPreview: variants.combined.strict.slice(0, this.maxPreviewChars),
    };
  }

  /** اختبار تعريف فلتر غير محفوظ (مسوّدة) على نص تجريبي. */
  testDraftFilter(input: { definition: FilterInput; text: string; caption: string }): FilterTestResult {
    const conditions = input.definition.conditions.map((condition, index) => ({
      id: `draft-condition-${index + 1}`,
      mode: condition.mode,
      negate: Boolean(condition.negate),
      minMatches: condition.minMatches ?? 1,
      terms: (condition.terms ?? []).map((term) => normalizeTerm(term, condition.matchMode ?? 'word')),
    }));
    const rule: RuleInput = {
      id: 'draft',
      name: input.definition.name || 'مسوّدة',
      kind: 'filter',
      priority: input.definition.priority ?? 100,
      appliesTo: input.definition.appliesTo ?? 'any',
      sourceIds: null,
      conditions,
      version: 0,
    };
    const variants = buildEvaluationInput(input.text, input.caption, false);
    const text =
      rule.appliesTo === 'text' ? variants.text : rule.appliesTo === 'caption' ? variants.caption : variants.combined;
    // تقييم مباشر لمجموعة واحدة بلا قاعدة بيانات.
    const evaluation = evaluateRule(rule, text);
    return {
      matched: evaluation.matched,
      evaluated: 1,
      matches: evaluation.matched ? [{ ruleId: 'draft', ruleName: rule.name, hits: evaluation.hits }] : [],
      normalizedPreview: text.strict.slice(0, this.maxPreviewChars),
    };
  }
}
