/** اختبارات وحدة لخدمة الاستخراج (الخطوة 5-ج) بمخزن وهمي: الحفظ، علم المراجعة، والتعطيل. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExtractionService } from '../src/modules/processing/extraction/extractionService.js';
import type { ExtractionStore } from '../src/modules/processing/extraction/extractionRepository.js';

interface Saved {
  identityId: string;
  fields: unknown[];
  contacts: unknown[];
  needsReview: boolean;
  extractionVersion: number;
}

function build(enabled = true) {
  const saved: Saved[] = [];
  const store: ExtractionStore = {
    saveExtraction: async (input) => {
      saved.push({
        identityId: input.identityId,
        fields: input.fields,
        contacts: input.contacts,
        needsReview: input.needsReview,
        extractionVersion: input.extractionVersion,
      });
    },
  };
  return { saved, service: new ExtractionService(store, enabled) };
}

describe('خدمة الاستخراج (5-ج)', () => {
  it('تحفظ الحقول وفئات التواصل وتعيد أرقاماً فقط', async () => {
    const { saved, service } = build();
    const result = await service.extractAndStore({
      identityId: 'i1',
      sourceId: 's1',
      text: 'مطلوب مبرمج\nالراتب: 500 دولار\nللتواصل: +967771234567',
      caption: '',
    });
    assert.equal(result.ok, true);
    assert.equal(result.extractionVersion, 1);
    assert.ok(result.fields >= 2);
    assert.equal(result.contacts, 1);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.needsReview, false);
  });

  it('ترفع علم المراجعة عند غموض الاستخراج (Q7)', async () => {
    const { saved, service } = build();
    const result = await service.extractAndStore({
      identityId: 'i2',
      sourceId: 's1',
      text: 'الموقع: صنعاء\nالموقع: عدن',
      caption: '',
    });
    assert.equal(result.needsReview, true);
    assert.equal(saved[0]!.needsReview, true);
  });

  it('ترفع علم المراجعة عند رقم تواصل غامض', async () => {
    const { service } = build();
    const result = await service.extractAndStore({
      identityId: 'i3',
      sourceId: 's1',
      text: 'رقمي 12345678',
      caption: '',
    });
    assert.equal(result.needsReview, true);
  });

  it('لا تحفظ شيئاً عند تعطيل الاستخراج', async () => {
    const { saved, service } = build(false);
    const result = await service.extractAndStore({
      identityId: 'i4',
      sourceId: 's1',
      text: 'مطلوب مبرمج',
      caption: '',
    });
    assert.equal(result.ok, false);
    assert.equal(saved.length, 0);
  });

  it('تستخرج من التعليق أيضاً (D06)', async () => {
    const { saved, service } = build();
    await service.extractAndStore({
      identityId: 'i5',
      sourceId: 's1',
      text: 'مطلوب شقة',
      caption: 'المساحة: 120 متر',
    });
    const fields = saved[0]!.fields as { fieldKey: string; source: string }[];
    assert.ok(fields.some((field) => field.fieldKey === 'area_size' && field.source === 'caption'));
  });
});
