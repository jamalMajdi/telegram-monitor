/**
 * اختبارات وحدة لخدمة المعالجة (الخطوة 5-ب) بمخزن وهمي: دلالة القرار، ترتيب الخطوات،
 * وضمان Q4 (فشل المعالجة ⇒ failed بلا رفع خطأ وبلا تأثير على نقطة الاستئناف).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageProcessingService } from '../src/modules/processing/messageProcessingService.js';
import type {
  ContentRow,
  IgnoreReason,
  MatchRow,
  ProcessingStore,
} from '../src/modules/processing/messageProcessingRepository.js';
import type { FilterDecision } from '../src/modules/processing/filterService.js';

interface SaveCall {
  identityId: string;
  content: ContentRow;
  matches: MatchRow[];
  processingVersion: string;
  isRepeat: boolean;
  retentionHours: number;
}

class FakeStore implements ProcessingStore {
  ignored: { identityId: string; reason: IgnoreReason }[] = [];
  failed: { identityId: string; code: string }[] = [];
  saved: SaveCall[] = [];
  retentionReads = 0;
  isRepeat = false;
  failSave = false;

  async contentRetentionHours(): Promise<number> {
    this.retentionReads += 1;
    return 48;
  }
  async markIgnored(input: { identityId: string; reason: IgnoreReason }): Promise<void> {
    this.ignored.push({ identityId: input.identityId, reason: input.reason });
  }
  async markFailed(input: { identityId: string; code: string }): Promise<void> {
    this.failed.push({ identityId: input.identityId, code: input.code });
  }
  async isRepeatContent(): Promise<boolean> {
    return this.isRepeat;
  }
  async saveMatch(input: SaveCall): Promise<void> {
    if (this.failSave) throw new Error('قاعدة البيانات غير متاحة');
    this.saved.push(input);
  }
  async purgeExpiredContent(): Promise<number> {
    return 0;
  }
}

function decision(overrides: Partial<FilterDecision> = {}): FilterDecision {
  return {
    matched: true,
    reason: 'matched',
    matches: [
      {
        ruleId: 'f1',
        ruleName: 'وظائف وفرص عمل',
        priority: 10,
        version: 1,
        hits: [
          {
            conditionId: 'c1',
            mode: 'any',
            negate: false,
            satisfied: true,
            count: 1,
            matchedTerms: ['خبرة'],
            empty: false,
          },
        ],
      },
    ],
    evaluatedRules: 7,
    processingVersion: '3',
    ...overrides,
  };
}

const base = { userId: 'u1', identityId: 'i1', sourceId: 's1', text: 'مطلوب مبرمج بخبرة', caption: '' };

interface FakeExtraction {
  ok: boolean;
  fields: number;
  contacts: number;
  needsReview: boolean;
  extractionVersion: number;
}

function service(
  response: FilterDecision,
  options: { enabled?: boolean; extraction?: { result?: FakeExtraction; fail?: boolean } } = {},
) {
  const store = new FakeStore();
  const calls: unknown[] = [];
  const filters = {
    decide: async (input: unknown) => {
      calls.push(input);
      return response;
    },
  };
  const extracted: unknown[] = [];
  const extraction = options.extraction
    ? {
        extractAndStore: async (input: unknown) => {
          extracted.push(input);
          if (options.extraction!.fail) throw new Error('فشل الاستخراج');
          return (
            options.extraction!.result ?? {
              ok: true,
              fields: 2,
              contacts: 1,
              needsReview: false,
              extractionVersion: 1,
            }
          );
        },
      }
    : undefined;
  const processing = new MessageProcessingService({
    store,
    filters,
    enabled: options.enabled ?? true,
    ...(extraction ? { extraction } : {}),
  });
  return { store, filters, calls, extracted, processing };
}

describe('خدمة المعالجة (5-ب)', () => {
  it('تحفظ الرسالة المطابقة بنصها الأصلي وأدلتها', async () => {
    const { store, processing } = service(decision());
    const outcome = await processing.process(base);
    assert.equal(outcome.state, 'matched');
    assert.equal(outcome.matchedCount, 1);
    assert.equal(store.saved.length, 1);
    const saved = store.saved[0]!;
    assert.equal(saved.content.text, base.text, 'النص كما ورد');
    assert.equal(saved.content.contentHash.length, 64);
    assert.equal(saved.matches[0]!.filterId, 'f1');
    assert.deepEqual(saved.matches[0]!.evidence[0]!.matchedTerms, ['خبرة']);
    assert.equal(saved.processingVersion, '3', 'إصدار الإعدادات محفوظ مع القرار');
    assert.equal(saved.retentionHours, 48);
  });

  it('تتجاهل غير المطابق بلا حفظ ولا استدعاء حفظ', async () => {
    const { store, processing } = service(decision({ matched: false, reason: 'no_filter_match', matches: [] }));
    const outcome = await processing.process(base);
    assert.equal(outcome.state, 'ignored');
    assert.equal(outcome.reason, 'no_filter');
    assert.equal(store.saved.length, 0);
    assert.deepEqual(store.ignored, [{ identityId: 'i1', reason: 'no_filter' }]);
  });

  it('تميّز غياب أي فلتر مطابق للمصدر (Q9)', async () => {
    const { store, processing } = service(decision({ matched: false, reason: 'no_active_filter', matches: [] }));
    const outcome = await processing.process(base);
    assert.equal(outcome.reason, 'no_source_filter');
    assert.equal(store.ignored[0]!.reason, 'no_source_filter');
  });

  it('تفحص نوع المحتوى والحدود قبل الفلترة', async () => {
    const { store, calls, processing } = service(decision());
    const empty = await processing.process({ ...base, text: '  ', caption: '' });
    assert.equal(empty.reason, 'no_text');
    const tooLong = await processing.process({ ...base, text: 'مطلوب ' + 'ا'.repeat(4100) });
    assert.equal(tooLong.reason, 'too_long');
    assert.equal(calls.length, 0, 'لا استدعاء للفلترة لرسالة مرفوضة شكلاً');
    assert.equal(store.saved.length, 0);
  });

  it('تسجّل تعطيل المعالجة بلا فلترة', async () => {
    const { store, calls, processing } = service(decision(), { enabled: false });
    const outcome = await processing.process(base);
    assert.equal(outcome.reason, 'processing_disabled');
    assert.equal(calls.length, 0);
    assert.equal(store.ignored[0]!.reason, 'processing_disabled');
  });

  it('فشل الحفظ ⇒ failed بلا رفع خطأ (Q4: النقطة تتقدّم)', async () => {
    const { store, processing } = service(decision());
    store.failSave = true;
    const outcome = await processing.process(base);
    assert.equal(outcome.state, 'failed');
    assert.equal(outcome.errorCode, 'PROCESSING_FAILED');
    assert.equal(store.failed.length, 1);
    assert.equal(store.failed[0]!.code, 'PROCESSING_FAILED');
  });

  it('تعلّم تكرار المحتوى عند وجود بصمة سابقة (Q6)', async () => {
    const { store, processing } = service(decision());
    store.isRepeat = true;
    const outcome = await processing.process(base);
    assert.equal(outcome.isRepeat, true);
    assert.equal(store.saved[0]!.isRepeat, true);
  });

  it('ترقّي الحالة إلى processed بعد نجاح الاستخراج (5-ج)', async () => {
    const { processing, extracted, store } = service(decision(), { extraction: {} });
    const outcome = await processing.process(base);
    assert.equal(outcome.state, 'processed');
    assert.equal(outcome.extractedFields, 2);
    assert.equal(outcome.contacts, 1);
    assert.equal(extracted.length, 1);
    assert.equal(store.saved.length, 1, 'المحتوى والمطابقات تُحفظ قبل الاستخراج');
  });

  it('ترفع علم المراجعة من الاستخراج إلى نتيجة المعالجة (Q7)', async () => {
    const { processing } = service(decision(), {
      extraction: { result: { ok: true, fields: 1, contacts: 0, needsReview: true, extractionVersion: 1 } },
    });
    const outcome = await processing.process(base);
    assert.equal(outcome.state, 'processed');
    assert.equal(outcome.needsReview, true);
  });

  it('فشل الاستخراج ⇒ failed بلا رفع خطأ (Q4)', async () => {
    const { processing, store } = service(decision(), { extraction: { fail: true } });
    const outcome = await processing.process(base);
    assert.equal(outcome.state, 'failed');
    assert.equal(store.failed.length, 1);
  });

  it('تخزّن مدة الاحتفاظ مؤقتاً لتفادي استعلام لكل رسالة', async () => {
    const { store, processing } = service(decision());
    await processing.process(base);
    await processing.process({ ...base, identityId: 'i2' });
    assert.equal(store.retentionReads, 1);
  });
});
