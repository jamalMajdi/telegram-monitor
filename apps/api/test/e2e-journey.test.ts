/**
 * سيناريو الرحلة الكاملة (P4-و) — من التسجيل إلى ظهور الأرقام في اللوحة.
 *
 * هذا الاختبار هو «بوابة القبول» للمشروع كله: يتصل بالمكوّنات الحقيقية فقط (قاعدة PostgreSQL
 * حقيقية، تطبيق Express كامل، بوابة تيليجرام محاكاة، عميل Bot API مزيّف) ويمرّ بالمسار:
 *
 *   تسجيل → ربط حساب → مصدر → فلتر (اختبار في الذاكرة) → استقبال رسالة → تصنيف وقالب
 *   → وجهة ومسار → تسليم → مراجعة/إرسال → نتائج وترقيم مؤشِّر → خط زمني موحّد
 *   → لوحة الأرقام → تنبيهات → اعتراف → منع إعادة النشر للمجهول → سجلات بلا محتوى → تدقيق.
 *
 * أي كسر في أحد هذه الحلقات يُسقط هذا الملف — وهو المقصود.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { DeliveryWorker as WorkerType } from '../src/modules/publishing/deliveryWorker.js';
import type { BotApiError as BotApiErrorType } from '../src/modules/publishing/botApiClient.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let makeWorker: (userId: string) => WorkerType;
let BotApiErrorClass: typeof BotApiErrorType;

const FILTER_TERM = 'عقارمميز';
const MESSAGE_TEXT = `${FILTER_TERM}: شقة ثلاث غرف للإيجار في حي هادئ، للتواصل 777123456`;

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });

  const [{ PublishingRuntime }, { DeliveryWorker, ChatSpacer }, { PgDeliveryStore }, botClient] = await Promise.all([
    import('../src/modules/publishing/runtime.js'),
    import('../src/modules/publishing/deliveryWorker.js'),
    import('../src/modules/publishing/deliveryStore.js'),
    import('../src/modules/publishing/botApiClient.js'),
  ]);
  const runtime = new PublishingRuntime({ botApi });
  const store = new PgDeliveryStore();
  BotApiErrorClass = botClient.BotApiError;
  // عامل مُقصَر على مستخدم السيناريو، وبلا فاصل زمني: الاختبار يقود الدورة بنفسه.
  makeWorker = (userId: string) =>
    new DeliveryWorker({
      store,
      botApi,
      bots: runtime.bots,
      spacer: new ChatSpacer(0),
      owner: 'e2e',
      userId,
    });
});

after(async () => {
  await server.close();
});

async function waitFor<T>(fn: () => Promise<T | null>, label: string, attempts = 80): Promise<T> {
  for (let i = 0; i < attempts; i += 1) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`مهلة منتهية في انتظار: ${label}`);
}

async function waitProcessed(identityId: string): Promise<void> {
  await waitFor(async () => {
    const row = await server.sql<{ state: string }>('select state::text as state from message_identity where id = $1', [
      identityId,
    ]);
    const state = row.rows[0]?.state;
    return state && state !== 'pending' ? state : null;
  }, 'معالجة الرسالة');
}

async function deliveryOf(identityId: string): Promise<{ id: string; status: string } | null> {
  const res = await server.sql<{ id: string; status: string }>(
    'select id, status::text as status from deliveries where identity_id = $1',
    [identityId],
  );
  const row = res.rows[0];
  return row ? { id: row.id, status: row.status } : null;
}

describe('الرحلة الكاملة: من التسجيل إلى اللوحة (P4-و)', () => {
  it('تمرّ الرسالة بالمسار كاملاً وتظهر أرقامها وتنبيهاتها بلا تسريب', async () => {
    // ——— (1) التسجيل والربط والمصدر والوجهة: جاهزة من السيناريو الموحّد ———
    const h: ScenarioHarness = await scenario.create();
    const api: TestClient = h.api;

    const session = await api.get('/api/v1/auth/session');
    assert.equal(session.status, 200);
    assert.equal((session.body as { user: { id: string } }).user.id, h.userId);

    // ——— (2) فلتر مخصّص + اختباره في الذاكرة قبل حفظ أي رسالة ———
    const created = await api.post('/api/v1/telegram/filters', {
      name: 'فلتر العقارات (E2E)',
      conditions: [{ mode: 'any', terms: [FILTER_TERM], matchMode: 'word' }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const filterId = (created.body as { filter: { id: string } }).filter.id;

    const beforeCounts = await server.sql<{ identities: number; contents: number }>(
      `select (select count(*)::int from message_identity where user_id = $1) as identities,
              (select count(*)::int from message_content) as contents`,
      [h.userId],
    );
    const testRun = await api.post(`/api/v1/telegram/filters/${filterId}/test`, { text: MESSAGE_TEXT });
    assert.equal(testRun.status, 200, JSON.stringify(testRun.body));
    const tested = (
      testRun.body as { result: { matched: boolean; matches: { hits: { count: number }[] }[] } }
    ).result;
    assert.equal(tested.matched, true, 'اختبار الفلتر يجب أن يطابق النص التجريبي');
    assert.ok(tested.matches[0]!.hits[0]!.count >= 1, 'الشرط المطابق يعيد عدد الإصابات');

    const afterCounts = await server.sql<{ identities: number; contents: number }>(
      `select (select count(*)::int from message_identity where user_id = $1) as identities,
              (select count(*)::int from message_content) as contents`,
      [h.userId],
    );
    assert.deepEqual(afterCounts.rows[0], beforeCounts.rows[0], 'اختبار الفلتر لا يكتب شيئاً في القاعدة');

    // ——— (3) مسار نشر تلقائي إلى الوجهة ———
    await scenario.route(h, { publishMode: 'auto' });

    // ——— (4) استقبال رسالة حقيقية من المصدر ومعالجتها ———
    const identityId = await scenario.emit(h, MESSAGE_TEXT);
    await waitProcessed(identityId);

    const processed = await server.sql<{ state: string; publish_state: string; matched: number }>(
      `select i.state::text as state, i.publish_state,
              (select count(*)::int from message_matches m where m.identity_id = i.id) as matched
         from message_identity i where i.id = $1`,
      [identityId],
    );
    const row = processed.rows[0]!;
    // «processed» هي النهاية الطبيعية: مطابقة + استخراج + تصنيف + قالب.
    // (حالة «matched» تظهر فقط حين تتوقف المعالجة عند المطابقة بلا استخراج.)
    assert.equal(row.state, 'processed', 'الرسالة يجب أن تُعالَج كاملاً');
    assert.ok(row.matched >= 1, 'صف مطابقة محفوظ');
    assert.notEqual(row.publish_state, 'not_routed', 'التوجيه يجب أن يحدث بعد المطابقة');

    // ——— (5) التسليم ثم الإرسال الفعلي عبر العامل ———
    const delivery = await waitFor(() => deliveryOf(identityId), 'إنشاء التسليم');
    const sendsBefore = botApi.sent.length;
    const worker = makeWorker(h.userId);
    const cycle = await worker.tick();
    assert.ok(cycle.ok >= 1, JSON.stringify(cycle));

    const published = await waitFor(
      async () => {
        const current = await deliveryOf(identityId);
        return current && current.status === 'published' ? current : null;
      },
      'نشر التسليم',
    );
    assert.equal(published.id, delivery.id, 'الصف نفسه (لا تسليم ثانٍ لنفس الوجهة)');
    assert.equal(botApi.sent.length, sendsBefore + 1, 'إرسال واحد فقط');

    const sentText = botApi.sent[botApi.sent.length - 1]!.text;
    assert.ok(sentText.length > 0);
    assert.ok(!sentText.includes('777123456'), 'لا رقم تواصل خام في المنشور');

    // ——— (6) النتائج + الترقيم المؤشِّر ———
    const results = await api.get('/api/v1/telegram/results?limit=5');
    assert.equal(results.status, 200, JSON.stringify(results.body));
    const page = results.body as { results: { identityId: string; publishState: string }[]; nextCursor: string | null };
    assert.ok(
      page.results.some((item) => item.identityId === identityId),
      'الرسالة تظهر في النتائج',
    );
    assert.equal(page.nextCursor, null);

    // ——— (7) الخط الزمني الموحّد: قصة واحدة كاملة ———
    const journeyRes = await api.get(`/api/v1/telegram/results/${identityId}/journey`);
    assert.equal(journeyRes.status, 200, JSON.stringify(journeyRes.body));
    const journey = (journeyRes.body as {
      journey: {
        state: string;
        publishState: string;
        timeline: { stage: string; code: string; at: string }[];
        deliveries: { status: string; parts: { status: string; telegramMessageId: string | null }[] }[];
        states: { deliveryStatuses: string[] };
      };
    }).journey;
    const codes = journey.timeline.map((event) => event.code);
    for (const required of ['received', 'filter_matched', 'delivery_created', 'delivery_published']) {
      assert.ok(codes.includes(required), `الخط الزمني يجب أن يحتوي «${required}» — الموجود: ${codes.join(', ')}`);
    }
    assert.equal(journey.states.deliveryStatuses[0], 'published');
    assert.equal(journey.deliveries[0]!.parts[0]!.status, 'sent');
    assert.ok(journey.deliveries[0]!.parts[0]!.telegramMessageId);
    // ترتيب زمني تصاعدي حتمي.
    const times = journey.timeline.map((event) => new Date(event.at).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'الخط الزمني مرتّب زمنياً');
    // لا محتوى رسالة في الخط الزمني.
    assert.doesNotMatch(JSON.stringify(journey), /777123456/);
    assert.doesNotMatch(JSON.stringify(journey), /شقة ثلاث غرف/);

    // ——— (8) الأرقام في اللوحة ———
    const dashboard = await api.get('/api/v1/dashboard/summary?fresh=1');
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
    const summary = (dashboard.body as {
      summary: {
        counts: {
          messages: { matchedTotal: number; matchedLast24h: number };
          deliveries: { published: number; publishedLast24h: number };
          sources: { total: number; active: number };
          destinations: { total: number; active: number };
        };
        alerts: { key: string; severity: string }[];
      };
    }).summary;
    assert.ok(summary.counts.messages.matchedTotal >= 1);
    assert.ok(summary.counts.messages.matchedLast24h >= 1);
    assert.ok(summary.counts.deliveries.published >= 1);
    assert.ok(summary.counts.deliveries.publishedLast24h >= 1);
    assert.equal(summary.counts.sources.active, 1);
    assert.equal(summary.counts.destinations.active, 1);

    // ——— (9) الفشل المجهول: لا إعادة تلقائية، تنبيه، ومنع إعادة نشر (Q20) ———
    const secondIdentity = await scenario.emit(h, `${MESSAGE_TEXT} — نسخة ثانية`);
    await waitProcessed(secondIdentity);
    const secondDelivery = await waitFor(() => deliveryOf(secondIdentity), 'تسليم الرسالة الثانية');

    botApi.sendError = new BotApiErrorClass('request timed out', 'timeout', { method: 'sendMessage' });
    try {
      const uncertainCycle = await makeWorker(h.userId).tick();
      assert.equal(uncertainCycle.uncertain, 1, JSON.stringify(uncertainCycle));
    } finally {
      botApi.sendError = null;
    }
    const uncertainDelivery = await deliveryOf(secondIdentity);
    assert.equal(uncertainDelivery!.status, 'uncertain');

    // العامل لا يعيد المحاولة تلقائياً.
    const idle = await makeWorker(h.userId).tick();
    assert.equal(idle.attempted, 0, 'النتيجة المجهولة لا تُعاد تلقائياً (O04)');

    // إعادة النشر ممنوعة منعاً باتاً على المجهول.
    const republish = await api.post(`/api/v1/telegram/publish/deliveries/${secondDelivery.id}/republish`);
    assert.equal(republish.status, 409, JSON.stringify(republish.body));
    assert.equal((republish.body as { error: { code: string } }).error.code, 'republish_uncertain_forbidden');

    // ——— (10) مركز التنبيهات يمتصّ الحالة ويُعترف به ———
    const inbox = await api.get('/api/v1/notifications?status=open');
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    const notifications = (
      inbox.body as { notifications: { id: string; key: string; severity: string; observedCount: number }[] }
    ).notifications;
    const uncertainAlert = notifications.find((item) => item.key === 'uncertain_delivery');
    assert.ok(uncertainAlert, `تنبيه النتيجة المجهولة مفقود: ${notifications.map((n) => n.key).join(', ')}`);
    assert.ok(uncertainAlert!.severity === 'warning' || uncertainAlert!.severity === 'critical');
    assert.ok(uncertainAlert!.observedCount >= 1);

    const acked = await api.post(`/api/v1/notifications/${uncertainAlert!.id}/acknowledge`);
    assert.equal(acked.status, 200, JSON.stringify(acked.body));
    assert.ok((acked.body as { notification: { acknowledgedAt: string | null } }).notification.acknowledgedAt);

    const counts = await api.get('/api/v1/notifications/counts');
    assert.equal(counts.status, 200);
    const badges = (counts.body as { counts: { open: number; unacknowledged: number } }).counts;
    assert.ok(badges.open >= 1);
    assert.ok(badges.unacknowledged >= 0);

    // ——— (11) السجلات: متاحة بلا نص رسالة ولا توكن ———
    const logs = await api.get('/api/v1/logs?limit=20');
    assert.equal(logs.status, 200, JSON.stringify(logs.body));
    const logsBody = JSON.stringify(logs.body);
    assert.doesNotMatch(logsBody, /777123456/, 'لا أرقام تواصل في السجلات');
    assert.doesNotMatch(logsBody, /شقة ثلاث غرف/, 'لا نص رسالة في السجلات');
    assert.doesNotMatch(logsBody, /bot[0-9A-Za-z:_-]{20,}/, 'لا رموز بوت في السجلات');

    // ——— (12) التدقيق يحفظ الأثر بلا محتوى ———
    const audit = await server.sql<{ action: string; metadata: unknown }>(
      `select action, metadata from audit_events where actor_user_id = $1 order by occurred_at`,
      [h.userId],
    );
    assert.ok(audit.rows.length >= 4, `يجب أن يوجد أثر تدقيق كافٍ (${audit.rows.length})`);
    for (const entry of audit.rows) {
      assert.doesNotMatch(JSON.stringify(entry.metadata), /777123456/);
      assert.doesNotMatch(JSON.stringify(entry.metadata), /شقة ثلاث غرف/);
    }
    // العزل: مستخدم آخر لا يرى شيئاً من رحلة الأول.
    const other = client(server.baseUrl);
    await other.post('/api/v1/auth/register', {
      email: 'e2e-other@example.test',
      displayName: 'مستخدم آخر',
      password: 'CorrectHorse123',
    });
    assert.equal((await other.get(`/api/v1/telegram/results/${identityId}/journey`)).status, 404);
    const otherResults = await other.get('/api/v1/telegram/results');
    assert.equal((otherResults.body as { results: unknown[] }).results.length, 0);
    assert.equal((await other.post(`/api/v1/notifications/${uncertainAlert!.id}/acknowledge`)).status, 404);
  });
});
