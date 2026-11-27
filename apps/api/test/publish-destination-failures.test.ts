/**
 * تدقيق 2026-11-26 — سلوك طابور النشر عند فشل الوجهة (حجب/حذف المحادثة/شبكة).
 *
 * السؤال المطروح في التدقيق: «هل تُفقد الرسالة أم تُعاد؟»
 * الإجابة المثبتة هنا:
 *  - حجب البوت أو حذف المحادثة ⇒ فشل **نهائي** بلا إعادة: الجزء يبقى محفوظاً بنصه
 *    (لا فقدان)، والتسليم `failed` ويقبل إعادة النشر اليدوية بحدّ 3 (قاعدة Q20).
 *  - خطأ شبكة/5xx ⇒ نتيجة **مجهولة**: لا إعادة تلقائية، تحتاج دليلاً بشرياً (O04).
 *  - الأجزاء المرسلة فعلاً لا تُعاد أبداً عند فشل جزء لاحق، والمنشور لا يتكرر
 *    حتى مع ثلاثة عمال متزامنين.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { BotApiError as BotApiErrorType } from '../src/modules/publishing/botApiClient.js';
import type { DeliveryWorker as WorkerType } from '../src/modules/publishing/deliveryWorker.js';
import type { PgDeliveryStore as StoreType } from '../src/modules/publishing/deliveryStore.js';
import { ChatSpacer, DeliveryWorker } from '../src/modules/publishing/deliveryWorker.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let store: StoreType;
let BotApiErrorClass: typeof BotApiErrorType;
let makeWorker: (userId: string, owner?: string) => WorkerType;

const JOB_TEXT = 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية، للتواصل 777123456';

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });
  const [{ PublishingRuntime }, { PgDeliveryStore }, client] = await Promise.all([
    import('../src/modules/publishing/runtime.js'),
    import('../src/modules/publishing/deliveryStore.js'),
    import('../src/modules/publishing/botApiClient.js'),
  ]);
  BotApiErrorClass = client.BotApiError;
  store = new PgDeliveryStore();
  const runtime = new PublishingRuntime({ botApi });
  makeWorker = (userId: string, owner = 'worker-test') =>
    new DeliveryWorker({
      store,
      botApi,
      bots: runtime.bots,
      spacer: new ChatSpacer(0),
      owner,
      userId,
    });
});

after(async () => {
  await server.close();
});

async function deliveryOf(identityId: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const res = await server.sql<{ id: string; status: string; chunk_count: number }>(
      'select id, status::text as status, chunk_count from deliveries where identity_id = $1',
      [identityId],
    );
    if (res.rows.length > 0) return res.rows[0]!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('لم يُنشأ تسليم خلال المهلة');
}

async function partsOf(deliveryId: string) {
  const res = await server.sql<{ part_index: number; status: string; text: string; telegram_message_id: string | null }>(
    'select part_index, status::text as status, text, telegram_message_id::text as telegram_message_id from delivery_parts where delivery_id = $1 order by part_index',
    [deliveryId],
  );
  return res.rows;
}

async function forceSendable(deliveryId: string): Promise<void> {
  await server.sql(
    `update deliveries set status = 'queued', review = 'not_required', review_reason = null,
            approved_version = plan_version, next_attempt_at = null
      where id = $1`,
    [deliveryId],
  );
}

/**
 * يضبط التسليم على جزأين بالضبط (بعض القوالب تُنتج جزأين أصلاً).
 * الجزء الثاني اصطناعي: الغرض اختبار سلوك تعدّد الأجزاء لا حساب التقسيم نفسه.
 */
async function addSecondPart(deliveryId: string, text: string): Promise<void> {
  const hash = (await import('node:crypto')).createHash('sha256').update(text).digest('hex');
  let parts = await partsOf(deliveryId);
  // الأجزاء مرقّمة بدءاً من 1 في القاعدة.
  if (parts.length > 2) {
    const keep = parts.slice(0, 2).map((p) => p.part_index);
    await server.sql(
      'delete from delivery_parts where delivery_id = $1 and part_index <> all($2::smallint[])',
      [deliveryId, keep],
    );
    parts = await partsOf(deliveryId);
  }
  if (parts.length === 1) {
    const nextIndex = parts[0]!.part_index + 1;
    await server.sql(
      `insert into delivery_parts (delivery_id, part_index, text, text_hash, char_count, status)
       values ($1, $2, $3, $4, $5, 'pending')`,
      [deliveryId, nextIndex, text, hash, text.length],
    );
  }
  await server.sql('update deliveries set chunk_count = (select count(*) from delivery_parts where delivery_id = $1) where id = $1', [deliveryId]);
}

async function makeDelivery(h: ScenarioHarness) {
  await scenario.route(h);
  const identityId = await scenario.emit(h, JOB_TEXT);
  const delivery = await deliveryOf(identityId);
  await forceSendable(delivery.id);
  return delivery;
}

/** يُكرّر الدورات حتى لا يبقى عمل قابل للاستحواذ (الإرسال متسلسل داخل التسليم). */
async function tickUntilIdle(worker: WorkerType, max = 6) {
  const total = { attempted: 0, ok: 0, retried: 0, failed: 0, uncertain: 0 };
  for (let round = 0; round < max; round += 1) {
    const result = await worker.tick();
    total.attempted += result.attempted;
    total.ok += result.ok;
    total.retried += result.retried;
    total.failed += result.failed;
    total.uncertain += result.uncertain;
    if (result.attempted === 0) break;
  }
  return total;
}

const botBlocked = () =>
  new BotApiErrorClass('Forbidden: bot was blocked by the user', 'bot_blocked', {
    httpStatus: 403,
    method: 'sendMessage',
  });

describe('فشل الوجهة — لا فقدان ولا تكرار', () => {
  it('حجب البوت (403) ⇒ فشل نهائي، النص محفوظ، ولا إعادة تلقائية', async () => {
    const h = await scenario.create();
    const delivery = await makeDelivery(h);
    const sentBefore = botApi.sent.length;
    botApi.sendError = botBlocked();
    try {
      const worker = makeWorker(h.userId);
      const result = await worker.tick();
      assert.equal(result.failed, 1, JSON.stringify(result));
    } finally {
      botApi.sendError = null;
    }

    const after = await server.sql<{ status: string; last_error_code: string | null; attempts: number }>(
      'select status::text as status, last_error_code, attempts from deliveries where id = $1',
      [delivery.id],
    );
    assert.equal(after.rows[0]!.status, 'failed', 'حجب البوت فشل نهائي لا مجهول');
    assert.equal(after.rows[0]!.last_error_code, 'bot_blocked');

    const parts = await partsOf(delivery.id);
    assert.equal(parts[0]!.status, 'failed');
    assert.ok(parts[0]!.text.length > 0, 'النص باقٍ في القاعدة — الرسالة لا تُفقد');

    // لا إعادة تلقائية: دورة أخرى لا تُرسل شيئاً ولا تغيّر الحالة.
    const worker = makeWorker(h.userId);
    const second = await worker.tick();
    assert.equal(second.attempted, 0, 'التسليم الفاشل نهائياً لا يُعاد');
    assert.equal(botApi.sent.length, sentBefore, 'لم يخرج شيء إلى تيليجرام');

    const attempts = await server.sql<{ outcome: string; http_status: number | null }>(
      'select outcome::text as outcome, http_status from delivery_attempts where delivery_id = $1',
      [delivery.id],
    );
    assert.equal(attempts.rows.length, 1);
    assert.equal(attempts.rows[0]!.outcome, 'permanent');
    assert.equal(attempts.rows[0]!.http_status, 403);
  });

  it('محادثة محذوفة/غير موجودة (400 chat not found) ⇒ فشل نهائي بالرمز الصحيح', async () => {
    const h = await scenario.create();
    const delivery = await makeDelivery(h);
    botApi.failOnce(
      'sendMessage',
      new BotApiErrorClass('Bad Request: chat not found', 'chat_not_found', {
        httpStatus: 400,
        method: 'sendMessage',
      }),
    );
    const worker = makeWorker(h.userId);
    await worker.tick();

    const after = await server.sql<{ status: string; last_error_code: string | null }>(
      'select status::text as status, last_error_code from deliveries where id = $1',
      [delivery.id],
    );
    assert.equal(after.rows[0]!.status, 'failed');
    assert.equal(after.rows[0]!.last_error_code, 'chat_not_found');
  });

  it('جزء أول نُشر وجزء ثانٍ محجوب ⇒ «partial» بلا إعادة إرسال للجزء الأول', async () => {
    const h = await scenario.create();
    const delivery = await makeDelivery(h);
    await addSecondPart(delivery.id, 'الجزء الثاني: تفاصيل إضافية عن الوظيفة');
    const sentBefore = botApi.sent.length;

    // الإرسال متسلسل داخل التسليم (ترتيب الأجزاء قبل الإنتاجية): الجزء الأول يخرج،
    // والثاني يصطدم بالحجب في الدورة نفسها.
    let sends = 0;
    botApi.onSend = () => {
      sends += 1;
      if (sends === 2) botApi.sendError = botBlocked(); // يُرفع في النداء الثاني نفسه
    };
    let first;
    try {
      first = await tickUntilIdle(makeWorker(h.userId));
    } finally {
      botApi.onSend = null;
      botApi.sendError = null;
    }
    assert.equal(first.ok, 1, JSON.stringify(first));
    assert.equal(first.failed, 1, JSON.stringify(first));
    assert.equal(botApi.sent.length, sentBefore + 1, 'جزء واحد خرج فعلاً');

    const parts = await partsOf(delivery.id);
    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.status, 'sent');
    assert.ok(parts[0]!.telegram_message_id);
    assert.equal(parts[1]!.status, 'failed');

    const after = await server.sql<{ status: string }>('select status::text as status from deliveries where id = $1', [
      delivery.id,
    ]);
    assert.equal(after.rows[0]!.status, 'partial', 'نشر جزئي لا «فاشل» ولا «منشور»');

    // دورة تالية: الجزء الأول المنشور لا يُرسل مرة أخرى (لا منشور مكرر).
    const third = await makeWorker(h.userId).tick();
    assert.equal(third.attempted, 0, 'لا عمل متبقٍّ على جزء منشور');
    assert.equal(botApi.sent.length, sentBefore + 1, 'لم يتكرر أي جزء');
  });

  it('خطأ شبكة على الجزء الثاني ⇒ «uncertain» ولا إعادة تلقائية للجزء الأول', async () => {
    const h = await scenario.create();
    const delivery = await makeDelivery(h);
    await addSecondPart(delivery.id, 'الجزء الثاني: تفاصيل إضافية عن الوظيفة');
    const sentBefore = botApi.sent.length;

    let sends = 0;
    botApi.onSend = () => {
      sends += 1;
      if (sends === 2) {
        botApi.sendError = new BotApiErrorClass('socket hang up', 'network', {
          httpStatus: null,
          method: 'sendMessage',
        });
      }
    };
    try {
      await tickUntilIdle(makeWorker(h.userId)); // الجزء الأول ينجح، والثاني يسقط على الشبكة
    } finally {
      botApi.onSend = null;
      botApi.sendError = null;
    }
    assert.equal(botApi.sent.length, sentBefore + 1, 'جزء واحد خرج فقط');

    const after = await server.sql<{ status: string; last_error_code: string | null }>(
      'select status::text as status, last_error_code from deliveries where id = $1',
      [delivery.id],
    );
    assert.equal(after.rows[0]!.status, 'uncertain', 'الشبكة مجهولة لا فاشلة');
    assert.equal(after.rows[0]!.last_error_code, 'network_unknown');

    // لا إعادة تلقائية للجزء المجهول، ولا تكرار للجزء المنشور.
    const again = await makeWorker(h.userId).tick();
    assert.equal(again.attempted, 0);
    assert.equal(botApi.sent.length, sentBefore + 1);
  });

  it('ثلاثة عمال متزامنين على تسليم من جزأين ⇒ كل جزء مرة واحدة فقط', async () => {
    const h = await scenario.create();
    const delivery = await makeDelivery(h);
    await addSecondPart(delivery.id, 'الجزء الثاني: تفاصيل إضافية عن الوظيفة');
    const sentBefore = botApi.sent.length;

    // إبطاء الإرسال لزيادة فرصة التصادم بين العمال.
    botApi.onSend = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    };
    try {
      // ثلاث دورات متزامنة ثم دورة تالية: التصادم الحقيقي يحدث داخل الاستحواذ نفسه.
      for (let round = 0; round < 3; round += 1) {
        await Promise.all([
          makeWorker(h.userId, 'w1').tick(),
          makeWorker(h.userId, 'w2').tick(),
          makeWorker(h.userId, 'w3').tick(),
        ]);
      }
    } finally {
      botApi.onSend = null;
    }

    const sent = botApi.sent.slice(sentBefore);
    assert.equal(sent.length, 2, 'جزآن فقط — لا نشر مكرر');
    assert.equal(new Set(sent.map((x) => x.text)).size, 2, 'لا نص مكرر');

    const after = await server.sql<{ status: string }>('select status::text as status from deliveries where id = $1', [
      delivery.id,
    ]);
    assert.equal(after.rows[0]!.status, 'published');
    const parts = await partsOf(delivery.id);
    assert.deepEqual(
      parts.map((p) => p.status),
      ['sent', 'sent'],
    );
  });
});
