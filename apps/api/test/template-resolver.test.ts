/**
 * اختبارات وحدة لمُحدِّد القالب (6-ب): أولوية O02 وحتميتها.
 * القالب (route) للمرحلة الثالثة فقط ويُمرَّر null، لكن ترتيبه مُختبر أيضاً لأنه جزء من العقد.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTemplate } from '../src/modules/processing/templateResolver.js';
import type { ConfigSnapshot, TemplateConfig } from '../src/modules/processing/ruleConfigRepository.js';

function template(id: string, overrides: Partial<TemplateConfig> = {}): TemplateConfig {
  return { id, name: `قالب ${id}`, isBuiltin: false, enabled: true, fields: [], ...overrides };
}

function snapshot(input: {
  templates?: TemplateConfig[];
  bindings?: Partial<ConfigSnapshot['templateBindings']>;
  defaultTemplateId?: string | null;
}): ConfigSnapshot {
  return {
    version: '1',
    rules: [],
    classifications: [],
    hasLooseTerms: false,
    filterCount: 0,
    classificationCount: 0,
    templates: input.templates ?? [],
    templateBindings: {
      source: input.bindings?.source ?? {},
      filter: input.bindings?.filter ?? {},
      classification: input.bindings?.classification ?? {},
    },
    defaultTemplateId: input.defaultTemplateId ?? null,
  };
}

describe('مُحدِّد القالب (6-ب)', () => {
  it('يفضّل تخصيص المصدر على كل ما دونه', () => {
    const selection = resolveTemplate({
      snapshot: snapshot({
        templates: [template('src'), template('flt'), template('cls'), template('def')],
        bindings: {
          source: { 'source-1': 'src' },
          filter: { 'filter-1': 'flt' },
          classification: { 'class-1': 'cls' },
        },
        defaultTemplateId: 'def',
      }),
      sourceId: 'source-1',
      matchedFilterIds: ['filter-1'],
      classificationId: 'class-1',
    });
    assert.equal(selection.templateId, 'src');
    assert.equal(selection.resolvedBy, 'source');
  });

  it('ينزل إلى الفلتر ثم التصنيف ثم الافتراضي بالترتيب', () => {
    const filterFirst = resolveTemplate({
      snapshot: snapshot({
        templates: [template('flt'), template('cls'), template('def')],
        bindings: { filter: { 'filter-1': 'flt' }, classification: { 'class-1': 'cls' } },
        defaultTemplateId: 'def',
      }),
      sourceId: 'source-1',
      matchedFilterIds: ['filter-1'],
      classificationId: 'class-1',
    });
    assert.equal(filterFirst.resolvedBy, 'filter');

    const classificationOnly = resolveTemplate({
      snapshot: snapshot({
        templates: [template('cls'), template('def')],
        bindings: { classification: { 'class-1': 'cls' } },
        defaultTemplateId: 'def',
      }),
      sourceId: 'source-1',
      matchedFilterIds: [],
      classificationId: 'class-1',
    });
    assert.equal(classificationOnly.resolvedBy, 'classification');

    const defaultOnly = resolveTemplate({
      snapshot: snapshot({ templates: [template('def')], defaultTemplateId: 'def' }),
      sourceId: 'source-1',
      matchedFilterIds: [],
      classificationId: null,
    });
    assert.equal(defaultOnly.resolvedBy, 'default');
  });

  it('يختار قالب الفلتر الأعلى أولوية (أول معرّف في القائمة المرتَّبة)', () => {
    const selection = resolveTemplate({
      snapshot: snapshot({
        templates: [template('flt-low'), template('flt-high')],
        bindings: { filter: { 'filter-high': 'flt-high', 'filter-low': 'flt-low' } },
      }),
      sourceId: 'source-1',
      matchedFilterIds: ['filter-high', 'filter-low'],
      classificationId: null,
    });
    assert.equal(selection.templateId, 'flt-high');
  });

  it('يتجاوز القالب المعطّل ويوثّق السبب', () => {
    const selection = resolveTemplate({
      snapshot: snapshot({
        templates: [template('src', { enabled: false }), template('def')],
        bindings: { source: { 'source-1': 'src' } },
        defaultTemplateId: 'def',
      }),
      sourceId: 'source-1',
      matchedFilterIds: [],
      classificationId: null,
    });
    assert.equal(selection.templateId, 'def');
    assert.equal(selection.resolvedBy, 'default');
    assert.deepEqual(selection.details.skipped, [{ level: 'source', templateId: 'src', reason: 'disabled' }]);
  });

  it('يتجاوز القالب المحذوف/غير الموجود بنفس المنطق', () => {
    const selection = resolveTemplate({
      snapshot: snapshot({ templates: [template('def')], bindings: { source: { 'source-1': 'ghost' } }, defaultTemplateId: 'def' }),
      sourceId: 'source-1',
      matchedFilterIds: [],
      classificationId: null,
    });
    assert.equal(selection.resolvedBy, 'default');
    assert.deepEqual(selection.details.skipped, [{ level: 'source', templateId: 'ghost', reason: 'missing' }]);
  });

  it('يعيد none بلا قالب افتراضي ولا ربط', () => {
    const selection = resolveTemplate({
      snapshot: snapshot({ templates: [] }),
      sourceId: 'source-1',
      matchedFilterIds: [],
      classificationId: null,
    });
    assert.equal(selection.templateId, null);
    assert.equal(selection.resolvedBy, 'none');
  });

  it('مسار النشر (route) يتقدّم على الجميع عند تمريره — عقد المرحلة الثالثة', () => {
    const selection = resolveTemplate({
      snapshot: snapshot({
        templates: [template('route'), template('src')],
        bindings: { source: { 'source-1': 'src' } },
      }),
      sourceId: 'source-1',
      matchedFilterIds: [],
      classificationId: null,
      routeTemplateId: 'route',
    });
    assert.equal(selection.resolvedBy, 'route');
    assert.equal(selection.templateId, 'route');
  });

  it('يوثّق كل مرشَّح في details للتدقيق', () => {
    const selection = resolveTemplate({
      snapshot: snapshot({
        templates: [template('def')],
        bindings: { source: { 'source-1': 'def' } },
        defaultTemplateId: 'def',
      }),
      sourceId: 'source-1',
      matchedFilterIds: [],
      classificationId: null,
    });
    assert.equal(selection.details.sourceTemplateId, 'def');
    assert.equal(selection.details.defaultTemplateId, 'def');
    assert.equal(selection.details.routeTemplateId, null);
  });
});
