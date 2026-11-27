/**
 * اختبارات الدفعة P4-أ: نموذج القراءة واللوحة.
 *
 * قاعدة PostgreSQL حقيقية + بوابة محاكاة: لا شبكة.
 * المحاور: العدّادات من المصدر، عزل المالك، لا محتوى/لا تواصل في الاستجابات،
 * التنبيهات المشتقّة، والذاكرة القصيرة (15 ثانية) وإبطالها بـ`fresh=1`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { DashboardService } from '../src/modules/dashboard/dashboardService.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let dashboard: DashboardService;
let buildAlerts: typeof import('../src/modules/dashboard/dashboardService.js').buildAlerts;

const JOB_TEXT = 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية، للتواصل 777123456';

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });
  const mod = await import('../src/modules/dashboard/dashboardService.js');
  const { PgDashboardStore } = await import('../src/modules/dashboard/dashboardRepository.js');
  dashboard = new mod.DashboardService({ store: new PgDashboardStore() });
  buildAlerts = mod.buildAlerts;
});

after(async () => {
  await server.close();
});

interface SummaryBody {
  summary: {
    counts: {
      telegram: { accounts: number; active: number; needsReauth: number; lastConnectedAt: string | null };
      sources: { total: number; active: number; paused: number };
      filters: { total: number; active: number };
      templates: { total: number };
      destinations: { total: number; active: number };
      messages: { matchedTotal: number; matchedLast24h: number; processedTotal: number; lastSeenAt: string | null };
      deliveries: {
        total: number;
        awaitingReview: number;
        queued: number;
        published: number;
        publishedLast24h: number;
        failed: number;
        uncertain: number;
        blocked: number;
      };
    };
    alerts: { key: string; severity: string; href: string }[];
    generatedAt: string;
    cached: boolean;
  };
}

async function summary(h: ScenarioHarness, fresh = true): Promise<SummaryBody['summary']> {
  const res = await h.api.get(`/api/v1/dashboard/summary${fresh ? '?fresh=1' : ''}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body as SummaryBody).summary;
}

describe('لوحة المستخدم: العدّادات (P4-أ)', () => {
  it('تعيد صفراً صريحاً لمستخدم جديد بلا اختراع بيانات', async () => {
    const h = await scenario.create();
    const result = await summary(h);
    // السيناريو ينشئ مصدراً واحداً مراقَباً، ووجهة فعّالة واحدة؛ نتحقق من القيم الفعلية لا من أصفار مفترضة.
    assert.equal(result.counts.sources.total, 1);
    assert.equal(result.counts.sources.active, 1);
    // البذور تُنشأ عند أول استخدام لمحرك الفلترة (تسجيل كسول)، لا عند التسجيل:
    // مستخدم لم يعالج أي رسالة بعد = صفر فلتر — وهذا صادق لا نقص.
    assert.equal(result.counts.filters.total, 0);
    // السيناريو ينشئ وجهة نشر فعّالة واحدة (بوت + قناة) — والعدّاد يعكسها بصدق.
    assert.equal(result.counts.destinations.total, 1);
    assert.equal(result.counts.destinations.active, 1);
    assert.equal(result.counts.deliveries.total, 0);
    assert.equal(result.counts.messages.matchedTotal, 0);
    assert.equal(result.counts.messages.lastSeenAt, null);
    assert.equal(result.counts.telegram.accounts, 1, 'الحساب المرتبط في السيناريو موجود');
    assert.equal(result.counts.telegram.active, 1);
    assert.equal(result.cached, false);
    // لا تنبيهات: الحساب نشط، وهناك مصدر ووجهة فعّالة، ولا تسليمات معلّقة.
    assert.deepEqual(result.alerts, []);
  });

  it('تعدّ المصادر والفلاتر والوجهات والتسليمات بعد دورة كاملة', async () => {
    const h = await scenario.create();
    await scenario.route(h, { publishMode: 'review' });
    await scenario.emit(h, JOB_TEXT);

    // انتظار ظهور التسليم (المعالجة في الخلفية بعد الاستقبال).
    let deliveryId: string | null = null;
    for (let attempt = 0; attempt < 40 && !deliveryId; attempt += 1) {
      const row = await server.sql<{ id: string }>(
        'select d.id from deliveries d join telegram_sources s on s.id = (select source_id from message_identity where id = d.identity_id) where s.user_id = $1 limit 1',
        [h.userId],
      );
      deliveryId = row.rows[0]?.id ?? null;
      if (!deliveryId) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(deliveryId, 'يجب أن يُنشأ تسليم');

    const result = await summary(h);
    assert.equal(result.counts.sources.total, 1);
    assert.equal(result.counts.sources.active, 1);
    assert.ok(result.counts.destinations.total >= 1);
    assert.ok(result.counts.destinations.active >= 1);
    assert.ok(result.counts.filters.total >= 1, 'فلتر مبدئي واحد على الأقل من البذور');
    assert.equal(result.counts.messages.processedTotal, 1);
    assert.ok(result.counts.messages.matchedTotal >= 1);
    assert.ok(result.counts.messages.matchedLast24h >= 1);
    assert.ok(result.counts.messages.lastSeenAt);
    assert.equal(result.counts.deliveries.total, 1);
    assert.equal(result.counts.deliveries.awaitingReview, 1, 'مسار المراجعة يجعلها بانتظار المراجعة');
    const keys = result.alerts.map((alert) => alert.key);
    assert.ok(keys.includes('awaiting_review'), JSON.stringify(result.alerts));
  });

  it('تعزل بيانات مالك عن آخر: لا رقم مشترك', async () => {
    const first = await scenario.create();
    await scenario.route(first);
    await scenario.emit(first, JOB_TEXT);
    const second = await scenario.create();

    const firstSummary = await summary(first);
    const secondSummary = await summary(second);

    assert.equal(firstSummary.counts.sources.total, 1);
    assert.equal(secondSummary.counts.sources.total, 1, 'كل مستخدم يرى مصدره هو');
    assert.equal(firstSummary.counts.deliveries.total, 1);
    assert.equal(secondSummary.counts.deliveries.total, 0, 'تسليمات المالك الآخر لا تُعدّ');
  });

  it('لا تُعيد أي محتوى رسالة أو قيمة تواصل في أي حقل', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    await scenario.emit(h, JOB_TEXT);
    const res = await h.api.get('/api/v1/dashboard/summary?fresh=1');
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes('777123456'), 'لا رقم تواصل');
    assert.ok(!raw.includes('مطلوب مبرمج'), 'لا نص رسالة');
    assert.ok(!raw.includes('token'), 'لا رموز');
  });

  it('الذاكرة القصيرة تعمل، وfresh=1 يتجاوزها', async () => {
    const h = await scenario.create();
    const first = await summary(h);
    // كتابة مباشرة بعد الاستجابة: القراءة المخزَّنة يجب ألا تراها فوراً.
    await server.sql("update user_settings set content_retention_hours = content_retention_hours where user_id = $1", [
      h.userId,
    ]);
    await server.sql(
      `insert into rule_sets (user_id, kind, name, enabled, priority)
       values ($1, 'filter', 'فلتر جديد للذاكرة', true, 5)`,
      [h.userId],
    );
    const cached = await summary(h, false);
    assert.equal(cached.cached, true);
    assert.equal(cached.counts.filters.total, first.counts.filters.total, 'القراءة المخزَّنة لا ترى الكتابة الجديدة');

    const fresh = await summary(h, true);
    assert.equal(fresh.cached, false);
    assert.equal(fresh.counts.filters.total, first.counts.filters.total + 1);
  });

  it('آخر العمليات: تدقيق المالك وحده، بلا محتوى', async () => {
    const h = await scenario.create();
    const other = await scenario.create();
    await server.sql(
      `insert into audit_events (actor_user_id, action, target_type, target_id, outcome)
       values ($1, 'publishing.test_event', 'delivery', 'x-1', 'success'), ($2, 'publishing.other_event', 'delivery', 'x-2', 'success')`,
      [h.userId, other.userId],
    );
    const res = await h.api.get('/api/v1/dashboard/activity?limit=5');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as { activity: { action: string; occurredAt: string }[] };
    assert.ok(body.activity.length >= 1);
    assert.ok(body.activity.every((item) => item.action !== 'publishing.other_event'), 'لا عمليات مالك آخر');
    assert.ok(body.activity[0]?.occurredAt, 'وقت صريح لكل عملية');

    const tooLarge = await h.api.get('/api/v1/dashboard/activity?limit=999');
    assert.equal(tooLarge.status, 400, 'الحد الأقصى للأحداث 50');
  });
});

describe('تنبيهات اللوحة: مشتقّة لا مخترعة', () => {
  const emptyCounts = {
    telegram: { accounts: 0, active: 0, needsReauth: 0, lastConnectedAt: null },
    sources: { total: 0, active: 0, paused: 0 },
    filters: { total: 0, active: 0 },
    templates: { total: 0 },
    destinations: { total: 0, active: 0 },
    messages: { matchedTotal: 0, matchedLast24h: 0, processedTotal: 0, lastSeenAt: null },
    deliveries: {
      total: 0,
      awaitingReview: 0,
      queued: 0,
      published: 0,
      publishedLast24h: 0,
      failed: 0,
      uncertain: 0,
      blocked: 0,
    },
  };

  it('لا تنبيهات لمساحة مكتملة', () => {
    const alerts = buildAlerts({
      ...emptyCounts,
      telegram: { accounts: 1, active: 1, needsReauth: 0, lastConnectedAt: null },
      sources: { total: 2, active: 2, paused: 0 },
      destinations: { total: 1, active: 1 },
    });
    assert.deepEqual(alerts, []);
  });

  it('حساب يحتاج إعادة دخول ⇒ تنبيه حرج، والمجهول ⇒ حرج، والمراجعة ⇒ تحذير', () => {
    const alerts = buildAlerts({
      ...emptyCounts,
      telegram: { accounts: 1, active: 0, needsReauth: 1, lastConnectedAt: null },
      sources: { total: 1, active: 1, paused: 0 },
      destinations: { total: 1, active: 1 },
      deliveries: { ...emptyCounts.deliveries, uncertain: 2, awaitingReview: 3 },
    });
    const byKey = new Map(alerts.map((alert) => [alert.key, alert]));
    assert.equal(byKey.get('needs_reauth')?.severity, 'critical');
    assert.equal(byKey.get('uncertain_delivery')?.severity, 'critical');
    assert.equal(byKey.get('awaiting_review')?.severity, 'warning');
    assert.ok(byKey.get('needs_reauth')?.message.includes('2') === false, 'عدد الحسابات 1 لا 2');
  });

  it('تنبيه «لا وجهة فعّالة» يظهر فقط عند وجود مصدر', () => {
    const noSource = buildAlerts(emptyCounts);
    assert.deepEqual(noSource.map((alert) => alert.key), ['no_source']);

    const withSource = buildAlerts({ ...emptyCounts, sources: { total: 1, active: 1, paused: 0 } });
    assert.deepEqual(withSource.map((alert) => alert.key), ['no_destination']);
  });
});
