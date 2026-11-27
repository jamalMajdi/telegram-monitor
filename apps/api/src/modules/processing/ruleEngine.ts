/**
 * محرّك القواعد (الخطوة 5-أ) — نقي تماماً: بلا قاعدة بيانات وبلا شبكة.
 *
 * يمثّل قراراً واحداً: هل رسالة مطابقة لمجموعة قواعد؟ وماذا كانت الأدلة؟
 * الدلالة (معتمدة في تصميم الخطوة 5 و6، §3.2):
 *   - الشروط تُقيَّم بـAND بينها.
 *   - الشرط غير المستبعِد: `all` = وجود كل مصطلح، `any` = عدد المطابقات ≥ minMatches.
 *   - الشرط المستبعِد (negate): يجب أن يكون عدد المطابقات صفراً.
 *   - مجموعة بلا شروط لا تُطابق شيئاً (حماية من «تمرير الكل» بالخطأ).
 *
 * الأدلة تُعاد بأسماء المصطلحات (من إعدادات المستخدم) لا بنص الرسالة، فلا يتسرّب محتوى إلى السجلات.
 * التصريف (compile) يبني تعابير المطابقة مرة واحدة لكل إصدار إعدادات، والتقييم لكل رسالة رخيص.
 */
import { normalizeArabic, type NormalizeOptions } from './normalization.js';

export type TermMatchMode = 'word' | 'phrase' | 'contains';
export type ConditionMode = 'all' | 'any';
export type RuleAppliesTo = 'any' | 'text' | 'caption';

export interface RuleTerm {
  /** المصطلح كما كتبه المستخدم (للأدلة والعرض). */
  display: string;
  /** النسخة المطبَّعة المستخدمة في المطابقة. */
  normalized: string;
  mode: TermMatchMode;
  /** تطبيع أوسع (طي ة/ه) لهذا المصطلح فقط ⇒ يُطابق النسخة المطبَّعة بسطاً. */
  loose?: boolean;
}

/** نسختا النص المطبَّعتان: محافظة، وواسعة (للمصطلحات التي طلبت `loose`). */
export interface TextVariants {
  strict: string;
  loose: string;
}

export interface RuleConditionInput {
  id: string;
  mode: ConditionMode;
  negate: boolean;
  minMatches: number;
  terms: RuleTerm[];
}

export interface RuleInput {
  id: string;
  name: string;
  kind: 'filter' | 'classification';
  priority: number;
  appliesTo: RuleAppliesTo;
  /** null = كل المصادر؛ غير ذلك = هويات المصادر المربوطة فقط. */
  sourceIds: string[] | null;
  conditions: RuleConditionInput[];
  version: number;
}

export interface ConditionHit {
  conditionId: string;
  mode: ConditionMode;
  negate: boolean;
  satisfied: boolean;
  count: number;
  /** عيّنة من المصطلحات المطابقة (حدّ أقصى لتفادي تضخّم الأدلة). */
  matchedTerms: string[];
  /** true عندما لا يحمل الشرط أي مصطلح صالح (لا يمكن أن يتحقّق). */
  empty: boolean;
}

export interface RuleEvaluation {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  hits: ConditionHit[];
}

const MAX_EVIDENCE_TERMS = 20;
const WORD_CHAR = '[\\p{L}\\p{N}]';

/**
 * السوابق العربية الملتصقة (و/ف/ب/ك/ل + ال وتركيباتها). الكلمة العربية تُكتب ملتصقة:
 * «ومصمم» و«المطلوب» يجب أن تطابق «مصمم» و«مطلوب»، وإلا فشلت الفلاتر في أغلب النصوص الحقيقية.
 * الأطول أولاً حتى تُجرَّب «وال» قبل «و».
 */
const ARABIC_PROCLITICS = ['وال', 'فال', 'بال', 'كال', 'ولل', 'لل', 'ال', 'و', 'ف', 'ب', 'ك', 'ل'];
const PROCLITIC_PATTERN = ARABIC_PROCLITICS.join('|');

interface CompiledTerm {
  display: string;
  loose: boolean;
  test: (variants: TextVariants) => boolean;
}

interface CompiledCondition {
  id: string;
  mode: ConditionMode;
  negate: boolean;
  minMatches: number;
  terms: CompiledTerm[];
}

/** مجموعة قواعد مصرَّفة: التقييم لا يبني تعابير ولا يطبّع شيئاً. */
export interface CompiledRule {
  input: RuleInput;
  conditions: CompiledCondition[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileTerm(term: RuleTerm): CompiledTerm | null {
  const normalized = term.normalized.trim();
  if (!normalized) return null;
  const body = escapeRegex(normalized).replace(/\s+/g, '\\s+');
  const loose = Boolean(term.loose);
  const pick = (variants: TextVariants) => (loose ? variants.loose : variants.strict);
  if (term.mode === 'contains') {
    return { display: term.display, loose, test: (variants) => pick(variants).includes(normalized) };
  }
  // الكلمة والعبارة: بداية كلمة (مع سماح بسابقة ملتصقة) ونهاية كلمة Unicode،
  // حتى تُطابق «مطلوب» في «والمطلوب» ولا تُطابقها داخل «مطلوبات».
  const firstWord = normalized.split(/\s+/)[0] ?? normalized;
  const prefix = firstWord.length >= 3 ? `(?:${PROCLITIC_PATTERN})?` : '';
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${prefix}${body}(?!${WORD_CHAR})`, 'u');
  return { display: term.display, loose, test: (variants) => re.test(pick(variants)) };
}

/** يطبّع مصطلحاً ويكوّن شكله القابل للتقييم. */
export function normalizeTerm(display: string, mode: TermMatchMode = 'word', options: NormalizeOptions = {}, loose = false): RuleTerm {
  return {
    display,
    normalized: normalizeArabic(display, loose ? { ...options, foldTaMarbuta: true } : options),
    mode,
    loose,
  };
}

export function compileRule(rule: RuleInput): CompiledRule {
  const conditions: CompiledCondition[] = rule.conditions.map((condition) => ({
    id: condition.id,
    mode: condition.mode,
    negate: condition.negate,
    minMatches: Math.max(1, condition.minMatches),
    terms: condition.terms
      .map((term) => compileTerm(term))
      .filter((term): term is CompiledTerm => term !== null),
  }));
  return { input: rule, conditions };
}

export function compileRules(rules: RuleInput[]): CompiledRule[] {
  return rules.map((rule) => compileRule(rule));
}

/** يقيّم مجموعة واحدة مصرَّفة. */
export function evaluateCompiledRule(rule: CompiledRule, variants: TextVariants): RuleEvaluation {
  const hits: ConditionHit[] = [];
  let matched = rule.conditions.length > 0;

  for (const condition of rule.conditions) {
    if (condition.terms.length === 0) {
      // شرط بلا مصطلحات لا يمكن أن يتحقّق؛ وجوده يمنع المطابقة بدل تمريرها.
      hits.push({
        conditionId: condition.id,
        mode: condition.mode,
        negate: condition.negate,
        satisfied: false,
        count: 0,
        matchedTerms: [],
        empty: true,
      });
      matched = false;
      continue;
    }

    const matchedTerms = condition.terms.filter((term) => term.test(variants)).map((term) => term.display);
    const count = matchedTerms.length;
    const satisfiedRaw =
      condition.mode === 'all' ? count === condition.terms.length : count >= condition.minMatches;
    const satisfied = condition.negate ? count === 0 : satisfiedRaw;

    hits.push({
      conditionId: condition.id,
      mode: condition.mode,
      negate: condition.negate,
      satisfied,
      count,
      matchedTerms: matchedTerms.slice(0, MAX_EVIDENCE_TERMS),
      empty: false,
    });
    if (!satisfied) matched = false;
  }

  return { ruleId: rule.input.id, ruleName: rule.input.name, matched, hits };
}

/** تقييم مباشر لمجموعة غير مصرَّفة (يُستخدم في الاختبارات وفي اختبار الفلتر من اللوحة). */
export function evaluateRule(rule: RuleInput, variants: TextVariants): RuleEvaluation {
  return evaluateCompiledRule(compileRule(rule), variants);
}

/** هل تنطبق المجموعة على هذا المصدر؟ (scope + bindings) */
export function ruleAppliesToSource(rule: RuleInput, sourceId: string): boolean {
  if (rule.sourceIds === null) return true;
  return rule.sourceIds.includes(sourceId);
}

export interface EvaluationInput {
  /** النص المطبَّع الكامل (text + caption) — يُستخدم عندما applies_to = any. */
  combined: TextVariants;
  text: TextVariants;
  caption: TextVariants;
}

export interface RuleMatch {
  ruleId: string;
  ruleName: string;
  priority: number;
  version: number;
  hits: ConditionHit[];
}

export interface EvaluationResult {
  /** عدد المجموعات التي جرى تقييمها فعلاً (تنطبق على المصدر). */
  evaluated: number;
  matches: RuleMatch[];
}

export function variantsFor(rule: CompiledRule, input: EvaluationInput): TextVariants {
  const appliesTo = rule.input.appliesTo;
  return appliesTo === 'text' ? input.text : appliesTo === 'caption' ? input.caption : input.combined;
}

/**
 * يقيّم كل المجموعات على رسالة واحدة ويعيد المطابقات مرتبة (priority ثم الاسم ثم المعرّف)
 * — ترتيب كسر التعادل معلَن وحتمي كما يطلب O02.
 */
export function evaluateCompiled(
  rules: CompiledRule[],
  sourceId: string | null,
  input: EvaluationInput,
): EvaluationResult {
  const matches: RuleMatch[] = [];
  let evaluated = 0;

  for (const rule of rules) {
    if (sourceId !== null && !ruleAppliesToSource(rule.input, sourceId)) continue;
    evaluated += 1;
    const evaluation = evaluateCompiledRule(rule, variantsFor(rule, input));
    if (!evaluation.matched) continue;
    matches.push({
      ruleId: rule.input.id,
      ruleName: rule.input.name,
      priority: rule.input.priority,
      version: rule.input.version,
      hits: evaluation.hits.filter((hit) => !hit.empty),
    });
  }

  matches.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.ruleName !== b.ruleName) return a.ruleName.localeCompare(b.ruleName, 'ar');
    return a.ruleId.localeCompare(b.ruleId);
  });

  return { evaluated, matches };
}

export function evaluateSnapshot(
  rules: RuleInput[],
  sourceId: string | null,
  input: EvaluationInput,
): EvaluationResult {
  return evaluateCompiled(compileRules(rules), sourceId, input);
}
