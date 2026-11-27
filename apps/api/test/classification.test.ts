/**
 * اختبارات وحدة للتصنيف الحتمي (الخطوة 6-أ): كسر التعادل، الثقة، الغموض، وثابت «غير مصنف».
 * تُستخدم لقطة إعدادات مزيّفة (بلا قاعدة بيانات) لأن الخدمة تعتمد على محرّك القواعد النقي.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClassificationService, classificationConfidence } from '../src/modules/processing/classificationService.js';
import type { ConfigSnapshot } from '../src/modules/processing/ruleConfigRepository.js';
import { compileRules, normalizeTerm, type RuleInput } from '../src/modules/processing/ruleEngine.js';

function classificationRule(overrides: {
  id: string;
  name: string;
  priority: number;
  terms: string[];
  negate?: boolean;
}): RuleInput {
  return {
    id: overrides.id,
    name: overrides.name,
    kind: 'classification',
    priority: overrides.priority,
    appliesTo: 'any',
    sourceIds: null,
    version: 1,
    conditions: [
      {
        id: `${overrides.id}-c1`,
        mode: 'any',
        negate: Boolean(overrides.negate),
        minMatches: 1,
        terms: overrides.terms.map((term) => normalizeTerm(term)),
      },
    ],
  };
}

function snapshot(rules: RuleInput[]): ConfigSnapshot {
  return {
    version: '7',
    rules: [],
    classifications: compileRules(rules),
    hasLooseTerms: false,
    filterCount: 0,
    classificationCount: rules.length,
    templates: [],
    templateBindings: { source: {}, filter: {}, classification: {} },
    defaultTemplateId: null,
  };
}

const service = (rules: RuleInput[]) =>
  new ClassificationService({ snapshot: async () => snapshot(rules) });

describe('التصنيف الحتمي (6-أ)', () => {
  it('يختار التصنيف المطابق ويحمل إصدار الإعدادات والأدلة', async () => {
    const classifier = service([
      classificationRule({ id: 'c-jobs', name: 'وظائف وفرص عمل', priority: 10, terms: ['وظيفة', 'خبرة'] }),
    ]);
    const result = await classifier.classify({
      userId: 'u1',
      sourceId: 's1',
      text: 'مطلوب مبرمج بخبرة سنتين',
      caption: '',
    });
    assert.equal(result.classificationId, 'c-jobs');
    assert.equal(result.classificationName, 'وظائف وفرص عمل');
    assert.equal(result.version, '7');
    assert.equal(result.matched, true);
    assert.ok(result.evidence.length > 0);
    assert.ok(result.confidence >= 0.35 && result.confidence <= 0.9);
  });

  it('يكسر التعادل بالأولوية ثم الاسم ثم المعرّف (حتمية)', async () => {
    const classifier = service([
      classificationRule({ id: 'c-b', name: 'ب', priority: 20, terms: ['مطلوب'] }),
      classificationRule({ id: 'c-a', name: 'أ', priority: 20, terms: ['مطلوب'] }),
      classificationRule({ id: 'c-z', name: 'ج', priority: 5, terms: ['مطلوب'] }),
    ]);
    const result = await classifier.classify({ userId: 'u1', sourceId: 's1', text: 'مطلوب شيء', caption: '' });
    assert.equal(result.classificationName, 'ج', 'الأولوية الأدنى رقمياً هي الأعلى');
    assert.equal(result.ambiguous, true, 'وجود منافسين يُعلَن غموضاً');
    assert.deepEqual(
      result.alternatives.map((item) => item.classificationName),
      ['أ', 'ب'],
    );
  });

  it('لا يخترع تصنيفاً: يعيد «غير مصنف» عند عدم مطابقة أي قاعدة', async () => {
    const classifier = service([
      classificationRule({ id: 'c-jobs', name: 'وظائف وفرص عمل', priority: 10, terms: ['وظيفة'] }),
      { ...classificationRule({ id: 'c-none', name: 'غير مصنف', priority: 100, terms: ['x'] }), conditions: [] },
    ]);
    const result = await classifier.classify({ userId: 'u1', sourceId: 's1', text: 'نص بلا تصنيف', caption: '' });
    assert.equal(result.matched, false);
    assert.equal(result.classificationName, 'غير مصنف');
    assert.equal(result.classificationId, 'c-none', 'الثابت يبقى معرَّفاً لكنه لا يطابق أبداً');
    assert.deepEqual(result.alternatives, []);
  });

  it('يحترم شرط الاستبعاد داخل التصنيف', async () => {
    const classifier = service([
      {
        ...classificationRule({ id: 'c-jobs', name: 'وظائف وفرص عمل', priority: 10, terms: ['مطلوب'] }),
        conditions: [
          {
            id: 'c1',
            mode: 'any',
            negate: false,
            minMatches: 1,
            terms: [normalizeTerm('مطلوب')],
          },
          {
            id: 'c2',
            mode: 'any',
            negate: true,
            minMatches: 1,
            terms: [normalizeTerm('دورة')],
          },
        ],
      },
    ]);
    const allowed = await classifier.classify({ userId: 'u1', sourceId: 's1', text: 'مطلوب مبرمج', caption: '' });
    assert.equal(allowed.classificationName, 'وظائف وفرص عمل');

    const excluded = await classifier.classify({
      userId: 'u1',
      sourceId: 's1',
      text: 'مطلوب مبرمج — دورة تدريبية',
      caption: '',
    });
    assert.equal(excluded.matched, false);
    assert.equal(excluded.classificationName, 'غير مصنف');
  });

  it('الثقة تنخفض بوجود منافسين وترتفع بعدد الشروط المحققة', () => {
    assert.ok(classificationConfidence({ satisfiedConditions: 2, competitors: 0 }) >
      classificationConfidence({ satisfiedConditions: 2, competitors: 1 }));
    assert.equal(classificationConfidence({ satisfiedConditions: 0, competitors: 0 }), 0.6);
    assert.equal(classificationConfidence({ satisfiedConditions: 5, competitors: 0 }), 0.8);
  });

  it('يعمل بلا أي تصنيفات معرَّفة بلا انفجار', async () => {
    const classifier = service([]);
    const result = await classifier.classify({ userId: 'u1', sourceId: 's1', text: 'مطلوب مبرمج', caption: '' });
    assert.equal(result.classificationName, 'غير مصنف');
    assert.equal(result.classificationId, null);
    assert.equal(result.confidence, 0.3);
  });
});
