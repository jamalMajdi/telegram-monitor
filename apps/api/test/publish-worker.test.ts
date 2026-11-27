/**
 * اختبارات تكامل الدفعة 7-د: عامل الإرسال، المحاولات، اللُقى، ومخارج O04.
 *
 * قاعدة PostgreSQL حقيقية + بوابة محاكاة + عميل Bot API مزيّف (بلا شبكة ولا رموز حقيقية).
 * المحاور: المحاولة تُحفظ قبل HTTP، لا إرسال بلا موافقة، لا إعادة تلقائية للمجهول،
 * 429 يُحترم حرفياً، الفشل النهائي بلا إعادة، وسقف المحاولات، ومنع الإرسال المزدوج باللُقية.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { BotApiError as BotApiErrorType } from '../src/modules/publishing/botApiClient.js';
import type { DeliveryWorker as WorkerType } from '../src/modules/publishing/deliveryWorker.js';
import type { ChatSpacer as SpacerType } from '../src/modules/publishing/deliveryWorker.js';
import type { PgDeliveryStore as StoreType } from '../src/modules/publishing/deliveryStore.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let worker: WorkerType;
let store: StoreType;
let makeWorker: (userId: string) => WorkerType;
let BotApiErrorClass: typeof BotApiErrorType;
let SpacerClass: typeof SpacerType;

const JOB_TEXT = 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية، للتواصل 777123456';

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });

  const [{ PublishingRuntime }, { DeliveryWorker, ChatSpacer }, { PgDeliveryStore }, client] = await Promise.all([
    import('../src/modules/publishing/runtime.js'),
    import('../src/modules/publishing/deliveryWorker.js'),
    import('../src/modules/publishing/deliveryStore.js'),
    import('../src/modules/publishing/botApiClient.js'),
  ]);
  BotApiErrorClass = client.BotApiError;
  SpacerClass = ChatSpacer;
  store = new PgDeliveryStore();
  const runtime = new PublishingRuntime({ botApi });
  // عامل بلا فاصل زمني في الاختبار: الفاصل نفسه مُختبَر وحدةً أدناه.
  // يُحصر الاستحواذ بمستخدم السيناريو حتى لا يلتقط تسليمات سيناريوهات أخرى في قاعدة الاختبار.
  makeWorker = (userId: string) =>
    new DeliveryWorker({
      store,
      botApi,
      bots: runtime.bots,
      spacer: new ChatSpacer(0),
      owner: 'worker-test',
      userId,
    });
  worker = makeWorker('00000000-0000-4000-8000-000000000000');
});

after(async () => {
  await server.close();
});

interface DeliveryRow {
  id: string;
  identityId: string;
  status: string;
  review: string;
  plan_version: number;
  approved_version: number | null;
  chunk_count: number;
  attempts: number;
  last_error_code: string | null;
  next_attempt_at: Date | null;
}

async function deliveryOf(identityId: string): Promise<DeliveryRow> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await server.sql<DeliveryRow>(
      `select id, identity_id, status::text as status, review::text as review, plan_version, approved_version,
              chunk_count, attempts, last_error_code, next_attempt_at
         from deliveries where identity_id = $1`,
      [identityId],
    );
    if (res.rows.length > 0) {
      assert.equal(res.rows.length, 1);
      const row = res.rows[0]!;
      return { ...row, identityId: (row as unknown as { identity_id: string }).identity_id };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('لم يُنشأ أي تسليم للرسالة خلال المهلة');
}

async function partsOf(deliveryId: string) {
  const res = await server.sql<{ part_index: number; status: string; telegram_message_id: string | null }>(
    'select part_index, status::text as status, telegram_message_id::text as telegram_message_id from delivery_parts where delivery_id = $1 order by part_index',
    [deliveryId],
  );
  return res.rows;
}

/** يجعل التسليم جاهزاً للإرسال بلا مراجعة (العامل هو موضوع الاختبار). */
async function forceSendable(deliveryId: string): Promise<void> {
  await server.sql(
    `update deliveries set status = 'queued', review = 'not_required', review_reason = null,
            approved_version = plan_version, next_attempt_at = null
      where id = $1`,
    [deliveryId],
  );
}

async function makeDelivery(h: ScenarioHarness, options: { publishMode?: 'auto' | 'review' } = {}) {
  await scenario.route(h, options);
  const identityId = await scenario.emit(h, JOB_TEXT);
  const delivery = await deliveryOf(identityId);
  worker = makeWorker(h.userId);
  return { identityId, delivery };
}

async function attemptRows(deliveryId: string) {
  const res = await server.sql<{ attempt_no: number; outcome: string; http_status: number | null; error_code: string | null }>(
    'select attempt_no, outcome::text as outcome, http_status, error_code from delivery_attempts where delivery_id = $1 order by attempt_no',
    [deliveryId],
  );
  return res.rows;
}

describe('عامل الإرسال (7-د)', () => {
  it('يرسل الجزء، ويحفظ المحاولة قبل طلب HTTP', async () => {
    const h = await scenario.create();
    const sendsAtStart = botApi.sent.length;
    const { delivery } = await makeDelivery(h);
    await forceSendable(delivery.id);

    let attemptVisibleBeforeHttp = false;
    botApi.onSend = async () => {
      const res = await server.sql<{ total: string }>(
        `select count(*)::text as total from delivery_attempts a
          join delivery_parts p on p.id = a.part_id
         where a.delivery_id = $1 and a.outcome = 'started' and a.finished_at is null and p.status = 'sending'`,
        [delivery.id],
      );
      attemptVisibleBeforeHttp = Number(res.rows[0]?.total ?? 0) === 1;
    };
    try {
      const result = await worker.tick();
      assert.equal(result.ok, 1, JSON.stringify(result));
    } finally {
      botApi.onSend = null;
    }
    assert.equal(attemptVisibleBeforeHttp, true, 'يجب أن يكون صف المحاولة مرئياً قبل الطلب');

    const after = await deliveryOf(delivery.identityId);
    assert.equal(after.status, 'published');
    assert.equal(after.attempts, 1);
    const parts = await partsOf(delivery.id);
    assert.equal(parts.length, 1);
    assert.equal(parts[0]?.status, 'sent');
    assert.ok(parts[0]?.telegram_message_id);

    const attempts = await attemptRows(delivery.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.outcome, 'ok');
    assert.equal(attempts[0]?.http_status, 200);

    assert.equal(botApi.sent.length, sendsAtStart + 1);
    const sent = botApi.sent[sendsAtStart]!;
    assert.equal(sent.chatId, h.destinationChatId);
    assert.ok(!sent.text.includes('777123456'), 'لا يخرج رقم تواصل خام في المنشور');
  });

  it('لا يرسل تسليماً بانتظار المراجعة قبل الموافقة، ويرسله بعدها', async () => {
    const h = await scenario.create();
    const sendsAtStart = botApi.sent.length;
    const { delivery } = await makeDelivery(h, { publishMode: 'review' });
    assert.equal(delivery.status, 'awaiting_review');
    assert.equal(delivery.review, 'pending');

    const before = await worker.tick();
    assert.equal(before.attempted, 0, 'المراجعة المعلّقة تمنع أي إرسال');
    assert.equal(botApi.sent.length, sendsAtStart);

    const approved = await h.api.post(`/api/v1/telegram/publish/deliveries/${delivery.id}/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const approvedBody = approved.body as { delivery: { status: string; approvedVersion: number | null; planVersion: number } };
    assert.equal(approvedBody.delivery.status, 'queued');
    assert.equal(approvedBody.delivery.approvedVersion, approvedBody.delivery.planVersion);

    const after = await worker.tick();
    assert.equal(after.ok, 1, JSON.stringify(after));
    assert.equal((await deliveryOf(delivery.identityId)).status, 'published');
  });

  it('الرفض يُلغي التسليم ولا يرسل شيئاً', async () => {
    const h = await scenario.create();
    const sendsAtStart = botApi.sent.length;
    const { delivery } = await makeDelivery(h, { publishMode: 'review' });

    const rejected = await h.api.post(`/api/v1/telegram/publish/deliveries/${delivery.id}/reject`, {
      reason: 'صياغة غير مناسبة',
    });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal((rejected.body as { delivery: { status: string; review: string } }).delivery.status, 'cancelled');

    const result = await worker.tick();
    assert.equal(result.attempted, 0);
    assert.equal(botApi.sent.length, sendsAtStart);
    const rejectedAgain = await h.api.post(`/api/v1/telegram/publish/deliveries/${delivery.id}/approve`);
    assert.equal(rejectedAgain.status, 409, 'لا اعتماد بعد الرفض');
  });

  it('429 يُحترم حرفياً: إعادة جدولة بعد retry_after بلا إرسال فوري', async () => {
    const h = await scenario.create();
    const sendsAtStart = botApi.sent.length;
    const { delivery } = await makeDelivery(h);
    await forceSendable(delivery.id);

    botApi.sendError = new BotApiErrorClass('Too Many Requests: retry after 30', 'flood_wait', {
      httpStatus: 429,
      retryAfterSeconds: 30,
      method: 'sendMessage',
    });
    try {
      const first = await worker.tick();
      assert.equal(first.retried, 1, JSON.stringify(first));
    } finally {
      botApi.sendError = null;
    }

    const expected = await deliveryOf(delivery.identityId);
    assert.equal(expected.status, 'queued');
    assert.equal(expected.last_error_code, 'flood_wait');
    assert.ok(expected.next_attempt_at);
    const delayMs = expected.next_attempt_at!.getTime() - Date.now();
    assert.ok(delayMs > 25_000 && delayMs <= 31_000, `التأجيل ${delayMs}ms`);

    const attempts = await attemptRows(delivery.id);
    assert.equal(attempts[0]?.outcome, 'retryable');
    assert.equal(attempts[0]?.http_status, 429);

    const tooEarly = await worker.tick();
    assert.equal(tooEarly.attempted, 0, 'لا إرسال قبل انقضاء retry_after');
    assert.equal(botApi.sent.length, sendsAtStart);
  });

  it('الفشل النهائي (403) لا يُعاد ويُغلق التسليم فاشلاً', async () => {
    const h = await scenario.create();
    const sendsAtStart = botApi.sent.length;
    const { delivery } = await makeDelivery(h);
    await forceSendable(delivery.id);

    botApi.sendError = new BotApiErrorClass('Forbidden: bot was blocked by the user', 'forbidden', {
      httpStatus: 403,
      method: 'sendMessage',
    });
    try {
      const result = await worker.tick();
      assert.equal(result.failed, 1, JSON.stringify(result));
    } finally {
      botApi.sendError = null;
    }

    const after = await deliveryOf(delivery.identityId);
    assert.equal(after.status, 'failed');
    assert.equal(after.last_error_code, 'bot_forbidden');
    const parts = await partsOf(delivery.id);
    assert.equal(parts[0]?.status, 'failed');

    // لا إعادة: دورة أخرى لا تفعل شيئاً.
    assert.equal((await worker.tick()).attempted, 0);
  });

  it('النتيجة المجهولة لا تُعاد تلقائياً وتحتاج دليلاً بشرياً (O04)', async () => {
    const h = await scenario.create();
    const sendsAtStart = botApi.sent.length;
    const { delivery } = await makeDelivery(h);
    await forceSendable(delivery.id);

    botApi.sendError = new BotApiErrorClass('request timed out', 'timeout', { method: 'sendMessage' });
    try {
      const result = await worker.tick();
      assert.equal(result.uncertain, 1, JSON.stringify(result));
    } finally {
      botApi.sendError = null;
    }

    const uncertain = await deliveryOf(delivery.identityId);
    assert.equal(uncertain.status, 'uncertain');
    assert.equal(uncertain.last_error_code, 'timeout_unknown');
    assert.equal(uncertain.next_attempt_at, null, 'لا جدولة إعادة تلقائية');
    assert.equal((await partsOf(delivery.id))[0]?.status, 'uncertain');

    // دورة أخرى: لا إرسال إطلاقاً.
    const again = await worker.tick();
    assert.equal(again.attempted, 0);
    assert.equal(botApi.sent.length, sendsAtStart);

    const evidence = await h.api.post(`/api/v1/telegram/publish/deliveries/${delivery.id}/evidence`, {
      method: 'manual_check',
      decision: 'published',
      note: 'ظهر المنشور في القناة',
    });
    assert.equal(evidence.status, 200, JSON.stringify(evidence.body));
    const settled = evidence.body as { delivery: { status: string } };
    assert.equal(settled.delivery.status, 'published');

    const detail = await h.api.get(`/api/v1/telegram/publish/deliveries/${delivery.id}`);
    assert.equal(detail.status, 200);
    const body = detail.body as { delivery: { evidence: { method: string; decision: string }[] } };
    assert.equal(body.delivery.evidence.length, 1);
    assert.equal(body.delivery.evidence[0]?.decision, 'published');

    const second = await h.api.post(`/api/v1/telegram/publish/deliveries/${delivery.id}/evidence`, {
      method: 'manual_check',
      decision: 'not_published',
    });
    assert.equal(second.status, 409, 'لا دليل ثانٍ بعد الحسم');
  });

  it('يعيد المحاولة عند 429 حتى سقف Q12 ثم يفشل صراحة', async () => {
    const h = await scenario.create();
    const sendsAtStart = botApi.sent.length;
    const { delivery } = await makeDelivery(h);
    await forceSendable(delivery.id);

    // 429 وحده هو الخطأ القابل للإعادة (retry_after=1 لتصغير زمن الاختبار).
    botApi.sendError = new BotApiErrorClass('Too Many Requests: retry after 1', 'flood_wait', {
      httpStatus: 429,
      retryAfterSeconds: 1,
      method: 'sendMessage',
    });
    let sends = 0;
    try {
      for (let round = 0; round < 5; round += 1) {
        const result = await worker.tick();
        sends += result.attempted;
        // تسريع الاختبار: إزالة التأجيل للسماح بالمحاولة التالية.
        await server.sql('update deliveries set next_attempt_at = now() - interval \'1 second\' where id = $1', [
          delivery.id,
        ]);
      }
    } finally {
      botApi.sendError = null;
    }
    assert.equal(sends, 5, 'خمس محاولات كحد أقصى');

    const after = await deliveryOf(delivery.identityId);
    assert.equal(after.status, 'failed');
    assert.equal(after.last_error_code, 'retry_exhausted');
    const attempts = await attemptRows(delivery.id);
    assert.equal(attempts.length, 5);
    assert.ok(attempts.every((item) => item.outcome === 'retryable'));

    const later = await worker.tick();
    assert.equal(later.attempted, 0, 'لا محاولة بعد استنفاد السقف');
    assert.equal(botApi.sent.length, sendsAtStart);
  });

  it('خطأ الخادم 5xx مجهول لا يُعاد تلقائياً (قرار المستخدم)', async () => {
    const h = await scenario.create();
    const sendsAtStart = botApi.sent.length;
    const { delivery } = await makeDelivery(h);
    await forceSendable(delivery.id);

    botApi.sendError = new BotApiErrorClass('Bad Gateway', 'server', { httpStatus: 502, method: 'sendMessage' });
    try {
      const first = await worker.tick();
      assert.equal(first.uncertain, 1, JSON.stringify(first));
    } finally {
      botApi.sendError = null;
    }

    const after = await deliveryOf(delivery.identityId);
    assert.equal(after.status, 'uncertain');
    assert.equal(after.last_error_code, 'server_unknown');
    assert.equal(after.next_attempt_at, null, 'لا جدولة إعادة تلقائية لخطأ الخادم');

    const attempts = await attemptRows(delivery.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.outcome, 'uncertain');
    assert.equal(attempts[0]?.http_status, 502);

    // لا إعادة إطلاقاً، رغم أن الخادم «تعافى» الآن.
    const later = await worker.tick();
    assert.equal(later.attempted, 0);
    assert.equal(botApi.sent.length, sendsAtStart);

    // ولا تُسوّى إلا بدليل بشري.
    const evidence = await h.api.post(`/api/v1/telegram/publish/deliveries/${delivery.id}/evidence`, {
      method: 'manual_check',
      decision: 'not_published',
    });
    assert.equal(evidence.status, 200, JSON.stringify(evidence.body));
    assert.equal((evidence.body as { delivery: { status: string } }).delivery.status, 'failed');
  });

  it('لُقية الجزء تمنع الإرسال المزدوج من عامل آخر', async () => {
    const h = await scenario.create();
    const sendsAtStart = botApi.sent.length;
    const { delivery } = await makeDelivery(h);
    await forceSendable(delivery.id);

    const claimed = await store.claimPart('worker-other', 90_000, { userId: h.userId });
    assert.ok(claimed);
    assert.equal(claimed!.deliveryId, delivery.id);

    const result = await worker.tick();
    assert.equal(result.attempted, 0, 'الجزء مستحوذ عليه من عامل آخر');
    assert.equal(botApi.sent.length, sendsAtStart);

    // بعد انتهاء اللُقية يستعيده العامل بلا تكرار.
    await server.sql(
      `update delivery_parts set lease_expires_at = now() - interval '1 second'
        where delivery_id = $1 and status = 'sending'`,
      [delivery.id],
    );
    await server.sql(
      `update deliveries set lease_expires_at = now() - interval '1 second' where id = $1`,
      [delivery.id],
    );
    const recovered = await worker.tick();
    assert.equal(recovered.ok, 1, JSON.stringify(recovered));
    assert.equal((await deliveryOf(delivery.identityId)).status, 'published');
  });

  it('لا يرسل شيئاً لوجهة عُطّلت بعد التخطيط', async () => {
    const h = await scenario.create();
    const sendsAtStart = botApi.sent.length;
    const { delivery } = await makeDelivery(h);
    await forceSendable(delivery.id);

    const paused = await h.api.post(`/api/v1/telegram/publish/destinations/${h.destinationId}/pause`);
    assert.equal(paused.status, 200, JSON.stringify(paused.body));

    const result = await worker.tick();
    assert.equal(result.attempted, 0);
    assert.equal(botApi.sent.length, sendsAtStart);
    const after = await deliveryOf(delivery.identityId);
    assert.equal(after.status, 'blocked');
    assert.equal(after.last_error_code, 'destination_inactive');
  });
});

describe('فاصل المحادثة', () => {
  it('يفصل بين رسالتين في المحادثة نفسها ولا يؤثر في محادثة أخرى', async () => {
    const waits: number[] = [];
    let now = 1_000;
    const spacer = new SpacerClass(
      1200,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    assert.equal(await spacer.wait('a'), 0);
    assert.equal(await spacer.wait('a'), 1200);
    assert.equal(await spacer.wait('b'), 0);
    now += 1200;
    assert.equal(await spacer.wait('a'), 0);
    assert.deepEqual(waits, [1200]);
  });
});
