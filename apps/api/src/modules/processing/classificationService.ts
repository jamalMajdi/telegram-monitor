/**
 * خدمة التصنيف الحتمي (الخطوة 6-أ، §8).
 *
 * - تصنيف قائم على القواعد فقط (نفس محرّك الفلترة) بلا ذكاء اصطناعي مدفوع.
 * - كسر التعادل معلَن وحتمي: الأولوية ← الاسم ← المعرّف (ترتيب `evaluateCompiled` نفسه).
 * - عند مطابقة أكثر من تصنيف: يُختار الأعلى أولوية، ويُعلَّم الجميع بالغموض وتُخفَّض الثقة.
 * - تصنيف «غير مصنف» لا قواعد له فلا يطابق أبداً؛ يُستخدم كثابت عرض فقط (لا اختراع تصنيف).
 */
import type { ConditionHit } from './ruleEngine.js';
import { evaluateCompiled } from './ruleEngine.js';
import { buildEvaluationInput } from './filterService.js';
import type { FilterService } from './filterService.js';
import type { ConfigSnapshot } from './ruleConfigRepository.js';

export const FALLBACK_CLASSIFICATION_NAME = 'غير مصنف';

export interface ClassificationResult {
  classificationId: string | null;
  classificationName: string;
  confidence: number;
  ambiguous: boolean;
  /** مطابقات أخرى بنفس الرسالة (مرتَّبة) — تُعرض في المراجعة. */
  alternatives: { classificationId: string; classificationName: string; priority: number }[];
  evidence: ConditionHit[];
  version: string;
  /** هل التصنيف جاء من قاعدة فعلية أم أنه ثابت «غير مصنف»؟ */
  matched: boolean;
}

/** ثقة حتمية مشتقّة من عدد الشروط المحققة ووجود منافسين. */
export function classificationConfidence(input: {
  satisfiedConditions: number;
  competitors: number;
}): number {
  let confidence = 0.6 + 0.1 * Math.min(2, Math.max(0, input.satisfiedConditions));
  if (input.competitors > 0) confidence -= 0.1;
  return Number(Math.max(0.35, Math.min(0.9, confidence)).toFixed(2));
}

export class ClassificationService {
  constructor(
    private readonly deps: {
      snapshot: (userId: string) => Promise<ConfigSnapshot>;
    },
  ) {}

  /** يبني الخدمة من خدمة الفلترة (تشاركها لقطة الإعدادات المخبّأة). */
  static fromFilters(filters: Pick<FilterService, 'snapshot'>): ClassificationService {
    return new ClassificationService({ snapshot: (userId) => filters.snapshot(userId) });
  }

  async classify(input: {
    userId: string;
    sourceId: string;
    text: string;
    caption: string;
  }): Promise<ClassificationResult> {
    const snapshot = await this.deps.snapshot(input.userId);
    const fallback = snapshot.classifications.find(
      (rule) => rule.input.name === FALLBACK_CLASSIFICATION_NAME,
    );

    if (snapshot.classifications.length === 0) {
      return {
        classificationId: fallback?.input.id ?? null,
        classificationName: FALLBACK_CLASSIFICATION_NAME,
        confidence: 0.3,
        ambiguous: false,
        alternatives: [],
        evidence: [],
        version: snapshot.version,
        matched: false,
      };
    }

    const variants = buildEvaluationInput(input.text, input.caption, snapshot.hasLooseTerms);
    const result = evaluateCompiled(snapshot.classifications, input.sourceId, variants);

    if (result.matches.length === 0) {
      return {
        classificationId: fallback?.input.id ?? null,
        classificationName: FALLBACK_CLASSIFICATION_NAME,
        confidence: 0.3,
        ambiguous: false,
        alternatives: [],
        evidence: [],
        version: snapshot.version,
        matched: false,
      };
    }

    // الترتيب حتمي مسبقاً: الأولوية ← الاسم ← المعرّف.
    const [picked, ...rest] = result.matches;
    const satisfied = picked!.hits.filter((hit) => hit.satisfied && !hit.negate).length;

    return {
      classificationId: picked!.ruleId,
      classificationName: picked!.ruleName,
      confidence: classificationConfidence({ satisfiedConditions: satisfied, competitors: rest.length }),
      ambiguous: rest.length > 0,
      alternatives: rest.map((match) => ({
        classificationId: match.ruleId,
        classificationName: match.ruleName,
        priority: match.priority,
      })),
      evidence: picked!.hits,
      version: snapshot.version,
      matched: true,
    };
  }
}
