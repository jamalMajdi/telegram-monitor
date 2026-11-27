/**
 * اختبارات الدفعة P4-هـ: الترقيم المؤشِّر للنتائج + الخط الزمني الموحّد.
 *
 * المحور: المؤشِّر **ثابت** — إدخال رسالة جديدة أثناء التنقّل لا يُكرّر صفاً ولا يُسقطه،
 * والإجمالي لا يُحسب في وضع المؤشِّر. والخط الزمني يجمع الحالات الثلاث بلا محتوى تواصل.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;

const TEXT = 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية، للتواصل 777123456';

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });
});

after(async () => {
  await server.close();
});

/** ينتظر حتى تُعالَج الرسالة فعلاً: القائمة تعرض فقط ما خرج من طور الانتظار. */
async function waitProcessed(identityId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const row = await server.sql<{ state: string }>('select state::text as state from message_identity where id = $1', [
      identityId,
    ]);
    const state = row.rows[0]?.state;
    if (state && state !== 'pending') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('لم تُعالَج الرسالة في الوقت المتوقع');
}

interface ResultsPage {
  results: { identityId: string; receivedAt: string; publishState?: string }[];
  nextCursor: string | null;
  limit: number;
  total?: number;
  offset?: number;
}

describe('الترقيم المؤشِّر للنتائج (Q30)', () => {
  it('يتنقّل بثبات: لا تكرار، لا فقدان، ولا إجمالي في وضع المؤشِّر', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      // فاصل زمني بسيط يمنع تساوي `first_seen_at` تماماً فيصير الترتيب أوضح.
      await new Promise((resolve) => setTimeout(resolve, 15));
      ids.push(await scenario.emit(h, `${TEXT} #${i}`));
    }
    for (const id of ids) await waitProcessed(id);

    const first = (await h.api.get('/api/v1/telegram/results?limit=2')).body as ResultsPage;
    assert.equal(first.results.length, 2);
    assert.ok(first.nextCursor, 'يجب أن يوجد مؤشِّر للصفحة التالية');
    assert.equal(first.total, undefined, 'لا عدّ كامل في وضع المؤشِّر');
    assert.equal(first.offset, undefined);

    // رسالة جديدة تصل **بين** الصفحتين: لا يجوز أن تُزيح صفوفاً في الصفحة التالية.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const lateId = await scenario.emit(h, `${TEXT} واصلة أثناء التنقّل`);
    await waitProcessed(lateId);

    const second = (await h.api.get(`/api/v1/telegram/results?limit=2&cursor=${first.nextCursor}`)).body as ResultsPage;
    assert.equal(second.results.length, 2);
    let cursor = second.nextCursor;
    const seen = [...first.results, ...second.results].map((row) => row.identityId);
    const pages = [first, second];
    while (cursor) {
      const page = (await h.api.get(`/api/v1/telegram/results?limit=2&cursor=${cursor}`)).body as ResultsPage;
      pages.push(page);
      seen.push(...page.results.map((row) => row.identityId));
      cursor = page.nextCursor;
    }

    const unique = new Set(seen);
    assert.equal(unique.size, seen.length, 'لا صف يتكرّر بين الصفحات');
    for (const id of ids) assert.ok(unique.has(id), 'كل الرسائل القديمة ظهرت مرة واحدة');
    assert.equal(unique.has(lateId), false, 'الرسالة الواصلة أثناء التنقّل لا تقفز إلى صفحات سابقة');
    assert.equal(seen.length, 5);
  });

  it('يرفض المؤشِّر الفاسد ويحترم حدود المالك والحد الأقصى', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    await waitProcessed(await scenario.emit(h, TEXT));

    assert.equal((await h.api.get('/api/v1/telegram/results?cursor=not-a-cursor')).status, 400);
    assert.equal((await h.api.get('/api/v1/telegram/results?limit=500')).status, 400);

    // مؤشِّر سليم الشكل لكن من مساحة أخرى: يعيد صفحة فارغة، لا بيانات غيرك.
    const other = await scenario.create();
    await waitProcessed(await scenario.emit(other, TEXT));
    const otherPage = (await other.api.get('/api/v1/telegram/results?limit=1')).body as ResultsPage;
    assert.equal(otherPage.results.length, 1);
    const hPage = (await h.api.get('/api/v1/telegram/results?limit=1')).body as ResultsPage;
    assert.notEqual(hPage.results[0]?.identityId, otherPage.results[0]?.identityId);
  });

  it('يُصفّي بحالة النشر ويُبقي وضع offset القديم متوافقاً', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    await waitProcessed(await scenario.emit(h, TEXT));

    // بعد تحسين البذور (SEED_VERSION 2+) صار طلب الوظائف الواضح يُوجَّه بلا مراجعة إجبارية:
    // لا منافس للتصنيف العام ⇒ لا غموض ⇒ `routed` لا `awaiting_review`.
    const routed = (await h.api.get('/api/v1/telegram/results?publishState=routed')).body as ResultsPage;
    assert.equal(routed.results.length, 1, 'رسالة واضحة تُوجَّه مباشرة');
    const awaiting = (await h.api.get('/api/v1/telegram/results?publishState=awaiting_review')).body as ResultsPage;
    assert.equal(awaiting.results.length, 0, 'لا حجز بلا سبب');
    const notRouted = (await h.api.get('/api/v1/telegram/results?publishState=not_routed')).body as ResultsPage;
    assert.equal(notRouted.results.length, 0);

    const legacy = (await h.api.get('/api/v1/telegram/results?limit=10&offset=0')).body as ResultsPage;
    assert.equal(legacy.total, 1, 'وضع offset يعيد الإجمالي كما كان');
    assert.equal(legacy.offset, 0);
  });
});

interface JourneyBody {
  journey: {
    identityId: string;
    state: string;
    publishState: string;
    states: { processing: string; publishing: string; deliveryStatuses: string[] };
    deliveries: {
      id: string;
      status: string;
      destinationTitle: string | null;
      parts: { partIndex: number; status: string }[];
      republish: { allowed: boolean; reason: string | null; remaining: number };
    }[];
    timeline: { at: string; stage: string; code: string; detail: Record<string, unknown> }[];
    matchedFilters: { id: string; name: string }[];
    contentAvailable: boolean;
  };
}

describe('الخط الزمني الموحّد للرسالة', () => {
  it('يجمع الحالات الثلاث ويعرض خطاً زمنياً مرتّباً بلا محتوى تواصل', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    const identityId = await scenario.emit(h, TEXT);

    const res = await h.api.get(`/api/v1/telegram/results/${identityId}/journey`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const journey = (res.body as JourneyBody).journey;

    assert.equal(journey.identityId, identityId);
    assert.equal(journey.states.processing, journey.state);
    assert.equal(journey.states.publishing, journey.publishState);
    assert.equal(journey.states.deliveryStatuses.length, 1);
    assert.equal(journey.deliveries.length, 1);
    assert.ok(journey.deliveries[0]!.parts.length >= 1, 'الخطة تُبنى بعد التوجيه');

    const codes = journey.timeline.map((event) => event.code);
    for (const required of ['received', 'filter_matched', 'classified', 'delivery_created']) {
      assert.ok(codes.includes(required), `الحدث «${required}» يجب أن يظهر في الخط الزمني`);
    }
    assert.ok(journey.timeline.length >= 4);

    // ترتيب زمني غير متناقص.
    const times = journey.timeline.map((event) => event.at);
    const sorted = [...times].sort();
    assert.deepEqual(times, sorted, 'الخط الزمني مرتّب زمنياً');

    // لا قيمة تواصل خامة ولا نص رسالة في الخط الزمني.
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes('777123456'));
    assert.ok(!raw.includes('مطلوب مبرمج'));
  });

  it('يعرض المحاولات والدليل في الخط الزمني للتسليم المجهول', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    const identityId = await scenario.emit(h, TEXT);

    const delivery = await server.sql<{ id: string }>('select id from deliveries where identity_id = $1', [identityId]);
    const deliveryId = delivery.rows[0]!.id;
    await server.sql(
      `update deliveries set status = 'uncertain', review = 'not_required', attempts = 2 where id = $1`,
      [deliveryId],
    );
    await server.sql(
      `insert into delivery_attempts (delivery_id, part_id, attempt_no, outcome, error_code, started_at)
       select $1, p.id, 1, 'uncertain', 'server_unknown', now() from delivery_parts p where p.delivery_id = $1 limit 1`,
      [deliveryId],
    );

    const journey = ((await h.api.get(`/api/v1/telegram/results/${identityId}/journey`)).body as JourneyBody).journey;
    const item = journey.deliveries[0]!;
    assert.equal(item.status, 'uncertain');
    assert.equal(item.republish.allowed, false);
    assert.equal(item.republish.reason, 'uncertain_forbidden');

    const codes = journey.timeline.map((event) => event.code);
    assert.ok(codes.includes('attempt.uncertain'), 'المحاولة المجهولة تظهر كحدث');
    assert.ok(codes.includes('delivery_uncertain'), 'حالة التسليم النهائية تظهر كحدث');
  });

  it('لا يكشف رسالة مستخدم آخر (404) ويتطلب جلسة', async () => {
    const mine = await scenario.create();
    await scenario.route(mine);
    const identityId = await scenario.emit(mine, TEXT);

    const other = await scenario.create();
    const res = await other.api.get(`/api/v1/telegram/results/${identityId}/journey`);
    assert.equal(res.status, 404);

    const anonymous = await fetch(`${server.baseUrl}/api/v1/telegram/results/${identityId}/journey`);
    assert.equal(anonymous.status, 401);
  });
});
