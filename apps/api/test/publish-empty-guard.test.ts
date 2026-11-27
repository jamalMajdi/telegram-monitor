/**
 * اختبار حارس المنشور الفارغ (خلل 2026-11-25).
 *
 * ما حدث فعلياً في الإنتاج: رسالة نصها «احد يقدر يسوي بحوث ومشاريع» صُنِّفت ونُشرت كمنشور
 * يحتوي العنوان «📌 الخدمات والطلبات العامة» والفاصل فقط — بلا أي محتوى — لأن الاستخراج لم يجد
 * أي حقل، ولأن فحص «الفارغ» كان يعتبر العنوان والفاصل محتوىً صالحاً.
 *
 * هذه الاختبارات تثبّت القاعدة الجديدة على طبقتين:
 *   1) باني الأسطر (`buildLines`): لا عنوان بلا سطر محتوى واحد على الأقل.
 *   2) مخطِّط التسليم: قالب بلا حقول ⇒ يُعرض **النص الأصلي** في حقل النص الحرّ؛
 *      ونص أصلي فارغ/مسافات ⇒ إغلاق `empty` بلا إرسال.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { DeliveryPlanner } from '../src/modules/publishing/deliveryPlanner.js';
import { DeliveryPlanner as DeliveryPlannerClass } from '../src/modules/publishing/deliveryPlanner.js';
import { buildLines, htmlVisibleText } from '../src/modules/publishing/publisher.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let planner: DeliveryPlanner;

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });
  const [{ PublishingRuntime }] = await Promise.all([import('../src/modules/publishing/runtime.js')]);
  planner = new PublishingRuntime({ botApi }).planner;
});

after(async () => {
  await server.close();
});

/** الرسالة التي كشفت الخلل حرفياً. */
const REPRO_TEXT = 'احد يقدر يسوي بحوث ومشاريع';

interface DeliveryRow {
  id: string;
  status: string;
  template_id: string | null;
  last_error_code: string | null;
}

async function deliveryOf(identityId: string): Promise<DeliveryRow> {
  // مهلة سخية: المجموعة الكاملة تشغّل الملفات بالتوازي على نفس قاعدة البيانات.
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const res = await server.sql<DeliveryRow>(
      'select id, status, template_id, last_error_code from deliveries where identity_id = $1',
      [identityId],
    );
    if (res.rows.length > 0) return res.rows[0]!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('لم يُنشأ أي تسليم للرسالة خلال المهلة');
}

async function partsOf(deliveryId: string) {
  const res = await server.sql<{ part_index: number; text: string }>(
    'select part_index, text from delivery_parts where delivery_id = $1 order by part_index',
    [deliveryId],
  );
  return res.rows;
}

describe('حارس المنشور الفارغ — باني الأسطر', () => {
  it('يرفض نشر عنوان وفاصل بلا أي محتوى', () => {
    const result = buildLines({ title: 'الخدمات والطلبات العامة', fields: [] }, 4096);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'empty');
  });

  it('يرفض القيم الفارغة والمسافات فقط كما يرفض غيابها', () => {
    const result = buildLines(
      {
        title: 'العقارات',
        fields: [
          { label: 'المنطقة', value: '   ' },
          { label: 'السعر', value: '' },
          { label: 'وسيلة التواصل', value: '\n\t' },
        ],
      },
      4096,
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'empty');
  });

  it('يعيد العنوان أولاً ثم المحتوى عند وجود حقل واحد صالح', () => {
    const result = buildLines(
      { title: 'العقارات', fields: [{ label: 'المنطقة', value: 'المنصورة' }] },
      4096,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const visible = result.lines.map((line) => htmlVisibleText(line.html));
    assert.ok(visible[0]!.includes('العقارات'));
    assert.ok(visible.some((line) => line.includes('المنطقة') && line.includes('المنصورة')));
  });
});

describe('حارس المنشور الفارغ — مخطِّط التسليم', () => {
  it('قالب بلا حقول مستخرجة ⇒ يُنشر النص الأصلي، لا هيكل فارغ', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    const identityId = await scenario.emit(h, REPRO_TEXT);
    const delivery = await deliveryOf(identityId);
    if (delivery.status === 'awaiting_review') {
      await h.api.post(`/api/v1/telegram/publish/deliveries/${delivery.id}/approve`, {});
    }

    const planned = await planner.plan(delivery.id, h.userId);
    assert.equal(planned.ok, true, `تعذّر التخطيط: ${planned.reason}`);
    assert.equal(planned.source, 'raw_text', 'يجب أن يُبنى المنشور من النص الأصلي');

    const parts = await partsOf(delivery.id);
    assert.ok(parts.length >= 1);
    const text = parts.map((part) => htmlVisibleText(part.text)).join('\n');
    assert.ok(text.includes(REPRO_TEXT), `النص المنشور لا يحتوي الرسالة الأصلية: ${text}`);
    // المحتوى ليس عنواناً وفاصلاً فقط: يجب أن يتجاوز طول العنوان + الفاصل بوضوح.
    const contentOnly = text
      .split('\n')
      .filter((line) => line.trim() && !line.includes('📌') && !/^ـ+$/.test(line.trim()));
    assert.ok(contentOnly.length >= 1, `لا سطر محتوى في المنشور: ${text}`);
  });

  it('لا محتوى ولا نص أصلي ⇒ رفض empty بلا إرسال (مخزن مزيّف: بلا قيود قاعدة البيانات)', async () => {
    // الحالة الواقعة: قالب بلا حقول + نص أصلي فراغات فقط ⇒ لا شيء يُنشر.
    // تُختبر بمخزن مزيّف لأن تعديل نص الرسالة في القاعدة يخالف قيد اتساق الطول (وهو حارس مقصود).
    const calls: { status?: string; code?: string | null; savedParts?: unknown[] } = {};
    const store = {
      async loadPlanContext() {
        return {
          deliveryId: 'd1',
          identityId: 'i1',
          userId: 'u1',
          sourceId: 's1',
          templateId: 't1',
          lengthPolicy: 'split' as const,
          maxParts: 10,
          planVersion: 1,
          status: 'queued',
          review: 'not_required',
          messageText: '   \n  ',
          caption: null,
          retentionExpiresAt: new Date(Date.now() + 86_400_000),
          classificationName: 'خدمات طلابية',
        };
      },
      async loadExtractionFields() {
        return [];
      },
      async loadContactViews() {
        return [];
      },
      async loadTemplate() {
        return {
          id: 't1',
          name: 'الخدمات الطلابية',
          fields: [
            { fieldKey: 'details', label: 'التفاصيل', enabled: true },
            { fieldKey: 'contact', label: 'وسيلة التواصل', enabled: true },
          ],
        };
      },
      async savePlan(input: { parts: unknown[] }) {
        calls.savedParts = input.parts;
      },
      async clearPlan() {
        calls.savedParts = [];
      },
      async setDeliveryStatus(_d: string, _u: string, status: string, code: string | null) {
        calls.status = status;
        calls.code = code;
      },
    };

    const isolated = new DeliveryPlannerClass({ store: store as never });
    const result = await isolated.plan('d1', 'u1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty');
    assert.equal(result.parts, 0);
    assert.equal(calls.status, 'blocked');
    assert.equal(calls.code, 'empty');
    assert.deepEqual(calls.savedParts, [], 'لا أجزاء تُثبَّت عند الرفض');
  });
});
