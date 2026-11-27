/**
 * اختبارات تكامل الدفعة 7-ج: تخطيط أجزاء النشر وتثبيتها (المخطط + المخزن + التوجيه الحقيقي).
 *
 * قاعدة PostgreSQL حقيقية + بوابة محاكاة + عميل Bot API مزيّف: لا شبكة، لا إرسال.
 * المحور: الطول يُقاس بعد تحليل كيانات HTML، الحجب النهائي قبل التثبيت، وأي فشل ⇒ منع لا إرسال.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { DeliveryPlanner } from '../src/modules/publishing/deliveryPlanner.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let planner: DeliveryPlanner;
let smallLimitPlanner: (textLimit: number) => DeliveryPlanner;

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });

  const [{ PublishingRuntime }, { DeliveryPlanner: PlannerClass }, { PgPublishStore }] = await Promise.all([
    import('../src/modules/publishing/runtime.js'),
    import('../src/modules/publishing/deliveryPlanner.js'),
    import('../src/modules/publishing/publishRepository.js'),
  ]);
  planner = new PublishingRuntime({ botApi }).planner;
  // مخطِّط بسقف طول أصغر: يسمح باختبار التقسيم/الرفض دون تجاوز حد الاستقبال (4096).
  smallLimitPlanner = (textLimit: number) => new PlannerClass({ store: new PgPublishStore(), textLimit });
});

after(async () => {
  await server.close();
});

interface DeliveryRow {
  id: string;
  status: string;
  plan_version: number;
  chunk_count: number;
  chars_total: number;
  last_error_code: string | null;
}

/** ينتظر ظهور صف التسليم: المعالجة تُنفَّذ في الخلفية بعد استقبال الرسالة. */
async function deliveryOf(identityId: string): Promise<DeliveryRow> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await server.sql<DeliveryRow>(
      'select id, status, plan_version, chunk_count, chars_total, last_error_code from deliveries where identity_id = $1',
      [identityId],
    );
    if (res.rows.length > 0) {
      assert.equal(res.rows.length, 1);
      return res.rows[0]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('لم يُنشأ أي تسليم للرسالة خلال المهلة');
}

/** يُلغي القالب المرتبط ليُبنى المنشور من نص الرسالة نفسه (مسار بلا قالب). */
async function dropTemplate(deliveryId: string): Promise<void> {
  await server.sql('update deliveries set template_id = null where id = $1', [deliveryId]);
}

async function partsOf(deliveryId: string) {
  const res = await server.sql<{ part_index: number; text: string; char_count: number; status: string }>(
    'select part_index, text, char_count, status from delivery_parts where delivery_id = $1 order by part_index',
    [deliveryId],
  );
  return res.rows;
}

describe('تخطيط أجزاء النشر (7-ج)', () => {
  it('يخطّط جزءاً واحداً ويحجب جهات الاتصال في نصه', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    const identityId = await scenario.emit(h, 'مطلوب مبرمج للتواصل على 777123456 أو @raw_handle');
    const delivery = await deliveryOf(identityId);
    assert.ok(
      delivery.status === 'queued' || delivery.status === 'awaiting_review',
      `حالة غير متوقعة: ${delivery.status}`,
    );
    assert.equal(delivery.plan_version, 2, 'الإصدار 1 يعني «بلا خطة»، فالتخطيط الأول يرفعه إلى 2');
    assert.ok(delivery.chunk_count >= 1);
    assert.equal(delivery.last_error_code, null);

    const parts = await partsOf(delivery.id);
    assert.equal(parts.length, delivery.chunk_count);
    const text = parts.map((part) => part.text).join('\n');
    assert.ok(!text.includes('777123456'), 'الرقم الخام يجب ألا يظهر في نص الإرسال');
    assert.ok(!/@raw_handle/.test(text), 'المعرّف الخام يجب ألا يظهر في نص الإرسال');
    assert.ok(parts.every((part) => part.status === 'pending'));
    assert.ok(parts.every((part) => part.char_count >= 1 && part.char_count <= 4096));
  });

  it('يُقسّم النص الطويل تحت الحد إلى عدة أجزاء، والقياس بعد تحليل الكيانات', async () => {
    const h = await scenario.create();
    await scenario.route(h, { lengthPolicy: 'split' });
    const long = 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية بالعاصمة. '.repeat(30); // ~1500 حرف
    const identityId = await scenario.emit(h, long);
    const delivery = await deliveryOf(identityId);
    assert.ok(delivery.status === 'queued' || delivery.status === 'awaiting_review', delivery.status);
    assert.equal(delivery.chunk_count, 1, 'بسقف 4096 الافتراضي يكفي جزء واحد');

    // إعادة تخطيط بلا قالب وبسقف 600: التقسيم يعمل على النص المرئي بعد تحليل الكيانات.
    await dropTemplate(delivery.id);
    const plannerAt600 = await smallLimitPlanner(600);
    const plan = await plannerAt600.plan(delivery.id, h.userId);
    assert.equal(plan.ok, true, String(plan.reason));

    const after = await deliveryOf(identityId);
    assert.ok(after.chunk_count >= 3, `عدد الأجزاء ${after.chunk_count}`);
    const parts = await partsOf(delivery.id);
    assert.equal(parts.length, after.chunk_count);
    for (const part of parts) {
      assert.ok(part.char_count <= 600, `الجزء ${part.part_index} بطول ${part.char_count}`);
      assert.ok(!/<[a-z/][^>]*$/.test(part.text), 'لا ينتهي الجزء بوسم HTML مفتوح');
      assert.ok(!part.text.includes('&amp;amp;'), 'لا تشفير مزدوج للكيانات');
    }
    const joined = parts.map((part) => part.text).join(' ');
    assert.ok(joined.includes('مطلوب مبرمج'));
  });

  it('سياسة الرفض: نص أكبر من الحد يُغلق التسليم بلا أجزاء ولا إرسال', async () => {
    const h = await scenario.create();
    await scenario.route(h, { lengthPolicy: 'reject' });
    const identityId = await scenario.emit(h, 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية. '.repeat(20));
    const delivery = await deliveryOf(identityId);
    await dropTemplate(delivery.id);

    const plannerAt200 = await smallLimitPlanner(200);
    const plan = await plannerAt200.plan(delivery.id, h.userId);
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'too_long');

    const after = await deliveryOf(identityId);
    assert.equal(after.status, 'blocked');
    assert.equal(after.last_error_code, 'too_long');
    assert.equal(after.chunk_count, 0);
    assert.equal((await partsOf(delivery.id)).length, 0);
  });

  it('تجاوز سقف الأجزاء يرفض بدل أن يقتطع بصمت', async () => {
    const h = await scenario.create();
    await scenario.route(h, { lengthPolicy: 'split', maxParts: 1 });
    const identityId = await scenario.emit(h, 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية. '.repeat(20));
    const delivery = await deliveryOf(identityId);
    await dropTemplate(delivery.id);
    const plannerAt200 = await smallLimitPlanner(200);
    const plan = await plannerAt200.plan(delivery.id, h.userId);
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'too_long');

    const after = await deliveryOf(identityId);
    assert.equal(after.status, 'blocked');
    assert.equal(after.last_error_code, 'too_long');
    assert.equal(after.chunk_count, 0, 'الخطة السابقة أُزيلت');
    assert.equal((await partsOf(delivery.id)).length, 0);
  });

  it('محتوى بعد انتهاء الاحتفاظ لا يُخطَّط ولا يُرسل', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    const identityId = await scenario.emit(h, 'إعلان وظيفة للاختبار');
    const delivery = await deliveryOf(identityId);
    assert.ok((await partsOf(delivery.id)).length >= 1);

    await server.sql('update message_content set retention_expires_at = now() - interval \'1 hour\' where identity_id = $1', [
      identityId,
    ]);
    const result = await planner.plan(delivery.id, h.userId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'content_expired');

    const after = await deliveryOf(identityId);
    assert.equal(after.status, 'blocked');
    assert.equal(after.last_error_code, 'content_expired');
    assert.equal((await partsOf(delivery.id)).length, 0, 'أجزاء قديمة أُزيلت عند الإغلاق');
  });

  it('إعادة التخطيط ترفع إصدار الخطة ولا تُكرّر الأجزاء', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    const identityId = await scenario.emit(h, 'مطلوب مبرمج لإعادة تخطيط نفس التسليم في شركة');
    const first = await deliveryOf(identityId);
    const again = await planner.plan(first.id, h.userId);
    assert.equal(again.ok, true);
    const second = await deliveryOf(identityId);
    assert.equal(second.plan_version, 3, 'إعادة التخطيط ترفع الإصدار');
    assert.equal(second.chunk_count, first.chunk_count);
    const parts = await partsOf(first.id);
    assert.deepEqual(
      parts.map((part) => part.part_index),
      Array.from({ length: second.chunk_count }, (_unused, index) => index + 1),
      'فهارس الأجزاء متسلسلة بلا تكرار',
    );
  });
});
