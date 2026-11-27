/**
 * اختبارات وحدة لمحرّك القواعد (الخطوة 5-أ): دلالة ALL/ANY/الاستبعاد/العبارة/حدود الكلمات،
 * والتقييم الحتمي مع كسر التعادل. لا قاعدة بيانات ولا شبكة.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileRules,
  evaluateCompiled,
  evaluateRule,
  evaluateSnapshot,
  normalizeTerm,
  type RuleConditionInput,
  type RuleInput,
  type TextVariants,
} from '../src/modules/processing/ruleEngine.js';
import { normalizeArabic } from '../src/modules/processing/normalization.js';

const variants = (raw: string): TextVariants => ({
  strict: normalizeArabic(raw),
  loose: normalizeArabic(raw, { foldTaMarbuta: true }),
});

function rule(overrides: Partial<RuleInput> & { conditions: RuleConditionInput[] }): RuleInput {
  return {
    id: overrides.id ?? 'r1',
    name: overrides.name ?? 'فلتر اختبار',
    kind: 'filter',
    priority: overrides.priority ?? 100,
    appliesTo: overrides.appliesTo ?? 'any',
    sourceIds: overrides.sourceIds ?? null,
    conditions: overrides.conditions,
    version: overrides.version ?? 1,
  };
}

const condition = (terms: string[], extra: Partial<RuleConditionInput> = {}): RuleConditionInput => ({
  id: extra.id ?? `c-${terms.join('-')}`,
  mode: extra.mode ?? 'any',
  negate: extra.negate ?? false,
  minMatches: extra.minMatches ?? 1,
  terms: terms.map((term) => normalizeTerm(term)),
});

describe('محرّك القواعد', () => {
  it('يطابق عند وجود أي كلمة من المجموعة (any)', () => {
    const evaluation = evaluateRule(rule({ conditions: [condition(['مطلوب', 'أبحث عن'])] }), variants('مطلوب مبرمج'));
    assert.equal(evaluation.matched, true);
    assert.equal(evaluation.hits[0]?.matchedTerms.length, 1);
  });

  it('لا يطابق إذا غابت كل كلمات المجموعة', () => {
    const evaluation = evaluateRule(rule({ conditions: [condition(['مطلوب', 'أبحث عن'])] }), variants('إعلان عام'));
    assert.equal(evaluation.matched, false);
  });

  it('يشترط كل الكلمات في الوضع all', () => {
    const all = condition(['مطلوب', 'مبرمج'], { mode: 'all' });
    assert.equal(evaluateRule(rule({ conditions: [all] }), variants('مطلوب مبرمج')).matched, true);
    assert.equal(evaluateRule(rule({ conditions: [all] }), variants('مطلوب مصمم')).matched, false);
  });

  it('يحترم عتبة min_matches داخل الشرط', () => {
    const condition2 = condition(['مبرمج', 'مصمم', 'مهندس'], { minMatches: 2 });
    assert.equal(evaluateRule(rule({ conditions: [condition2] }), variants('مطلوب مبرمج')).matched, false);
    assert.equal(evaluateRule(rule({ conditions: [condition2] }), variants('مبرمج ومصمم')).matched, true);
  });

  it('يستبعد عند وجود أي كلمة في شرط negate (§6.4)', () => {
    const exclude = condition(['دورة', 'تدريب'], { negate: true });
    const request = condition(['مطلوب']);
    const target = rule({ conditions: [request, exclude] });
    assert.equal(evaluateRule(target, variants('مطلوب مبرمج')).matched, true);
    assert.equal(evaluateRule(target, variants('مطلوب مبرمج — دورة تدريبية')).matched, false);
  });

  it('يميّز حدود الكلمات العربية (لا مطابقة داخل كلمة أخرى)', () => {
    const target = rule({ conditions: [condition(['مطلوب'])] });
    assert.equal(evaluateRule(target, variants('مطلوبات')).matched, false);
    assert.equal(evaluateRule(target, variants('مبرمج مطلوبات')).matched, false);
  });

  it('يتسامح مع السوابق الملتصقة (ال، و، ب، ل) دون تجذيع', () => {
    const target = rule({ conditions: [condition(['مطلوب'])] });
    assert.equal(evaluateRule(target, variants('المطلوب مبرمج')).matched, true);
    assert.equal(evaluateRule(target, variants('والمطلوب مبرمج')).matched, true);
    assert.equal(evaluateRule(target, variants('مطلوب ومصمم')).matched, true);
    const designer = rule({ conditions: [condition(['مصمم'])] });
    assert.equal(evaluateRule(designer, variants('مبرمج ومصمم')).matched, true);
    assert.equal(evaluateRule(designer, variants('مبرمج بمصمم')).matched, true);
  });

  it('يطابق العبارة الكاملة بمسافات متفاوتة', () => {
    const phrase = condition(['أبحث عن'], { mode: 'all' });
    const target = rule({ conditions: [phrase] });
    // التطبيع يوحّد المسافات، والعبارة تبقى متتابعة.
    assert.equal(evaluateRule(target, variants('أبحث عن مصمم')).matched, true);
    assert.equal(evaluateRule(target, variants('أبحث كثيراً عن مصمم')).matched, false);
  });

  it('يطابق نصاً داخل كلمة عند نمط contains', () => {
    const inside: RuleConditionInput = {
      id: 'c-contains',
      mode: 'any',
      negate: false,
      minMatches: 1,
      terms: [{ display: 'برمج', normalized: 'برمج', mode: 'contains' }],
    };
    assert.equal(evaluateRule(rule({ conditions: [inside] }), variants('مطلوب مبرمج')).matched, true);
  });

  it('مجموعة بلا شروط لا تطابق شيئاً (حماية من تمرير الكل)', () => {
    assert.equal(evaluateRule(rule({ conditions: [] }), variants('أي نص')).matched, false);
  });

  it('شرط بلا مصطلحات يمنع المطابقة ويُعلَّم فارغاً', () => {
    const empty = condition([]);
    const evaluation = evaluateRule(rule({ conditions: [condition(['مطلوب']), empty] }), variants('مطلوب'));
    assert.equal(evaluation.matched, false);
    assert.equal(evaluation.hits[1]?.empty, true);
  });

  it('يطبّق applies_to: نص / نص مصاحب / كليهما', () => {
    const condition1 = condition(['مطلوب']);
    const textOnly = rule({ conditions: [condition1], appliesTo: 'text' });
    const captionOnly = rule({ conditions: [condition1], appliesTo: 'caption' });
    const input = { combined: variants('مطلوب'), text: variants(''), caption: variants('مطلوب') };
    const compiledText = compileRules([textOnly]);
    const compiledCaption = compileRules([captionOnly]);
    assert.equal(evaluateCompiled(compiledText, null, input).matches.length, 0);
    assert.equal(evaluateCompiled(compiledCaption, null, input).matches.length, 1);
  });

  it('يستثني الفلاتر غير المرتبطة بالمصدر (scope=bound)', () => {
    const bound = rule({ id: 'bound', conditions: [condition(['مطلوب'])], sourceIds: ['source-a'] });
    const all = rule({ id: 'all', name: 'عام', conditions: [condition(['مطلوب'])], sourceIds: null });
    const compiled = compileRules([bound, all]);
    const input = { combined: variants('مطلوب'), text: variants('مطلوب'), caption: variants('') };
    assert.equal(evaluateCompiled(compiled, 'source-a', input).matches.length, 2);
    assert.equal(evaluateCompiled(compiled, 'source-b', input).matches.length, 1);
    assert.equal(evaluateCompiled(compiled, 'source-b', input).evaluated, 1);
  });

  it('يرتّب المطابقات بعيداً عن الترتيب العرضي: priority ثم الاسم ثم المعرّف', () => {
    const a = rule({ id: 'b-id', name: 'ب', priority: 5, conditions: [condition(['مطلوب'])] });
    const b = rule({ id: 'a-id', name: 'أ', priority: 5, conditions: [condition(['مبرمج'])] });
    const c = rule({ id: 'c-id', name: 'ج', priority: 1, conditions: [condition(['عاجل'])] });
    const result = evaluateSnapshot([a, b, c], null, {
      combined: variants('مطلوب مبرمج عاجل'),
      text: variants('مطلوب مبرمج عاجل'),
      caption: variants(''),
    });
    assert.deepEqual(
      result.matches.map((match) => match.ruleId),
      ['c-id', 'a-id', 'b-id'],
    );
  });

  it('يطابق النسخة الواسعة للمصطلحات التي طلبت loose فقط', () => {
    const looseTerm = { display: 'شقة', normalized: 'شقه', mode: 'word' as const, loose: true };
    const target = rule({
      conditions: [{ id: 'c1', mode: 'any', negate: false, minMatches: 1, terms: [looseTerm] }],
    });
    assert.equal(evaluateRule(target, { strict: 'شقة للبيع', loose: 'شقه للبيع' }).matched, true);
  });

  it('لا تتأثر النتيجة بتقييم متكرر (حتمية بلا حالة)', () => {
    const target = rule({ conditions: [condition(['مطلوب'])] });
    const first = evaluateRule(target, variants('مطلوب'));
    const second = evaluateRule(target, variants('مطلوب'));
    assert.deepEqual(first, second);
  });
});
