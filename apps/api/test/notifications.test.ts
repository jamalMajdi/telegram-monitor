/**
 * مركز التنبيهات (P4-و) — تكامل مع قاعدة حقيقية.
 *
 * نُثبِّت مصادر الحقيقة (عدّادات + صحّة العامل) عبر حقن الخدمة، فتصبح الحالات قابلة للتحكم
 * تماماً: لا ساعات انتظار ولا اعتماد على عامل حقيقي.
 *
 * المحاور: تنبيه واحد لكل حالة (لا إغراق)، التصعيد يُفرغ الاعتراف، الحل ثم العودة = صف جديد،
 * العزل بـuser_id، الاعتراف مسجَّل في التدقيق، والترقيم المؤشِّر.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import type { DashboardCounts } from '../src/modules/dashboard/dashboardRepository.js';
import type { NotificationService as ServiceType } from '../src/modules/notifications/notificationsService.js';
import type { WorkerHealthState } from '../src/modules/notifications/notificationsService.js';

let server: TestServer;
let service: ServiceType;

/** حالة قابلة للتحكم لكل مستخدم: العدّادات + صحّة العامل. */
const countsByUser = new Map<string, DashboardCounts>();
let workerState: { state: WorkerHealthState; lastSeenSeconds: number | null } = { state: 'ok', lastSeenSeconds: 2 };

function counts(overrides: { uncertain?: number; awaitingReview?: number; needsReauth?: number } = {}): DashboardCounts {
  return {
    telegram: { accounts: 1, active: 1, needsReauth: overrides.needsReauth ?? 0, lastConnectedAt: null },
    sources: { total: 1, active: 1, paused: 0 },
    filters: { total: 1, active: 1 },
    templates: { total: 1 },
    destinations: { total: 1, active: 1 },
    messages: { matchedTotal: 1, matchedLast24h: 1, processedTotal: 1, lastSeenAt: null },
    deliveries: {
      total: 1,
      awaitingReview: overrides.awaitingReview ?? 0,
      queued: 0,
      published: 0,
      publishedLast24h: 0,
      failed: 0,
      uncertain: overrides.uncertain ?? 0,
      blocked: 0,
    },
  };
}

interface AlertBody {
  id: string;
  key: string;
  severity: 'info' | 'warning' | 'critical';
  observedCount: number;
  occurrences: number;
  payload: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

interface ListBody {
  notifications: AlertBody[];
  nextCursor: string | null;
  limit: number;
}

async function register(email: string): Promise<{ api: TestClient; userId: string }> {
  const api = client(server.baseUrl);
  const res = await api.post('/api/v1/auth/register', {
    email,
    displayName: 'مالك تنبيهات',
    password: 'CorrectHorse123',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const session = await api.get('/api/v1/auth/session');
  const userId = (session.body as { user: { id: string } }).user.id;
  countsByUser.set(userId, counts());
  return { api, userId };
}

function setCounts(userId: string, value: DashboardCounts): void {
  countsByUser.set(userId, value);
}

async function list(api: TestClient, query = ''): Promise<ListBody> {
  const res = await api.get(`/api/v1/notifications${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as ListBody;
}

async function countsOf(api: TestClient) {
  const res = await api.get('/api/v1/notifications/counts');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body as { counts: { open: number; unacknowledged: number; critical: number; warning: number; info: number } })
    .counts;
}

before(async () => {
  // الخدمة تُبنى داخل المصنع بعد تهيئة قاعدة الاختبار (انظر `notificationsFactory` في harness).
  server = await startTestServer({
    logLevel: 'silent',
    notificationsFactory: ({ store, Service }) => {
      service = new Service({
        store,
        sources: {
          counts: async (userId: string) => countsByUser.get(userId) ?? counts(),
          workerHealth: async () => workerState,
        },
        // لا تثبيت زمني في الاختبار: كل قراءة تزامن فعلياً.
        throttleMs: 0,
      });
      return service;
    },
  });
});

after(async () => {
  await server.close();
});

describe('مركز التنبيهات (P4-و)', () => {
  it('يبدأ المستخدم بصندوق فارغ وأعداد صفرية', async () => {
    const { api } = await register('alerts-empty@example.test');
    const body = await list(api);
    assert.deepEqual(body.notifications, []);
    assert.equal(body.nextCursor, null);
    const counted = await countsOf(api);
    assert.deepEqual(counted, { open: 0, unacknowledged: 0, critical: 0, warning: 0, info: 0 });
  });

  it('ينشئ تنبيهاً واحداً لكل حالة، ولا يكرره مع كل قراءة', async () => {
    const { api, userId } = await register('alerts-uncertain@example.test');
    setCounts(userId, counts({ uncertain: 1 }));

    const first = await list(api);
    assert.equal(first.notifications.length, 1);
    const alert = first.notifications[0]!;
    assert.equal(alert.key, 'uncertain_delivery');
    assert.equal(alert.severity, 'warning');
    assert.equal(alert.observedCount, 1);
    assert.equal(alert.occurrences, 1);

    // ثلاث قراءات أخرى: لا صفوف جديدة ولا عدّاد يتضخم.
    await list(api);
    await list(api);
    const again = await list(api);
    assert.equal(again.notifications.length, 1);
    assert.equal(again.notifications[0]!.id, alert.id);
    assert.equal(again.notifications[0]!.occurrences, 1, 'المسح المتكرر ليس حدثاً جديداً');

    const rows = await server.sql('select count(*)::int as total from alert_notifications where user_id = $1', [userId]);
    assert.equal(Number((rows.rows[0] as { total: number }).total), 1, 'صف واحد لا صفوف متكررة');
  });

  it('التصعيد إلى حرج يرفع الخطورة ويُفرغ الاعتراف (اعتراف التحذير لا يسري على الحرج)', async () => {
    const { api, userId } = await register('alerts-escalate@example.test');
    setCounts(userId, counts({ uncertain: 1 }));
    const warning = (await list(api)).notifications[0]!;

    const ack = await api.post(`/api/v1/notifications/${warning.id}/acknowledge`);
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    assert.ok((ack.body as { notification: AlertBody }).notification.acknowledgedAt);

    // العتبة الافتراضية 3: صعود إلى 3 يعني حرج.
    setCounts(userId, counts({ uncertain: 3 }));
    const escalated = (await list(api)).notifications[0]!;
    assert.equal(escalated.id, warning.id, 'نفس الصف يُحدَّث لا يُنسخ');
    assert.equal(escalated.severity, 'critical');
    assert.equal(escalated.observedCount, 3);
    assert.equal(escalated.occurrences, 2, 'التصعيد وحده يزيد عدّاد التكرار');
    assert.equal(escalated.acknowledgedAt, null, 'التنبيه الحرج يعود غير معترَف به');
  });

  it('يُحلّ التنبيه عند اختفاء الحالة، ويعود صفاً جديداً إذا عادت', async () => {
    const { api, userId } = await register('alerts-resolve@example.test');
    setCounts(userId, counts({ awaitingReview: 2 }));
    const open = (await list(api)).notifications[0]!;
    assert.equal(open.key, 'awaiting_review');

    setCounts(userId, counts());
    const afterResolve = await list(api);
    assert.deepEqual(afterResolve.notifications, [], 'الحالة اختفت ⇒ الصندوق النشط فارغ');

    const history = await list(api, '?status=all');
    const resolved = history.notifications.find((item) => item.id === open.id);
    assert.ok(resolved);
    assert.ok(resolved!.resolvedAt, 'الصف القديم محفوظ ومختوم لا محذوف');

    setCounts(userId, counts({ awaitingReview: 1 }));
    const reappeared = (await list(api)).notifications;
    assert.equal(reappeared.length, 1);
    assert.notEqual(reappeared[0]!.id, open.id, 'العودة حالة جديدة لا إحياء للصف القديم');
    assert.equal(reappeared[0]!.occurrences, 1);
  });

  it('الاعتراف: واحد أو الكل، مع عدّادات متسقة وتدقيق مسجَّل', async () => {
    const { api, userId } = await register('alerts-ack@example.test');
    setCounts(userId, counts({ uncertain: 1, awaitingReview: 1, needsReauth: 1 }));
    const before = await list(api);
    assert.equal(before.notifications.length, 3);
    const beforeCounts = await countsOf(api);
    assert.equal(beforeCounts.open, 3);
    assert.equal(beforeCounts.unacknowledged, 3);
    // العتبة الافتراضية 3: مجهولة واحدة = تحذير، فالحرج هو الحساب المحتاج لإعادة دخول وحده.
    assert.equal(beforeCounts.critical, 1);
    assert.equal(beforeCounts.warning, 2, 'المجهولة والمراجعة المعلّقة تحذيران');

    const target = before.notifications.find((item) => item.key === 'uncertain_delivery')!;
    const acked = await api.post(`/api/v1/notifications/${target.id}/acknowledge`);
    assert.equal(acked.status, 200);
    assert.equal((acked.body as { notification: AlertBody }).notification.key, 'uncertain_delivery');

    const midCounts = await countsOf(api);
    assert.equal(midCounts.open, 3, 'الاعتراف لا يحلّ التنبيه — الحالة قائمة');
    assert.equal(midCounts.unacknowledged, 2);

    const all = await api.post('/api/v1/notifications/acknowledge-all');
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal((all.body as { acknowledged: number }).acknowledged, 2);
    const afterCounts = await countsOf(api);
    assert.equal(afterCounts.unacknowledged, 0);
    assert.equal(afterCounts.open, 3);

    const audit = await server.sql<{ action: string; metadata: unknown }>(
      `select action, metadata from audit_events
        where actor_user_id = $1 and action like 'notifications.%' order by occurred_at`,
      [userId],
    );
    assert.ok(audit.rows.length >= 2);
    const actions = audit.rows.map((row) => row.action);
    assert.ok(actions.includes('notifications.acknowledged'));
    assert.ok(actions.includes('notifications.acknowledged_all'));
    // لا نص حر في التدقيق: لا مفاتيح عربية ولا أسماء.
    for (const row of audit.rows) {
      assert.doesNotMatch(JSON.stringify(row.metadata), /[\u0600-\u06FF]/, 'التدقيق بلا نص عربي حر');
    }
  });

  it('العزل: لا يرى المستخدم تنبيهات غيره ولا يعترف بها', async () => {
    const first = await register('alerts-owner@example.test');
    const second = await register('alerts-other@example.test');
    setCounts(first.userId, counts({ uncertain: 2 }));
    setCounts(second.userId, counts());

    const mine = await list(first.api);
    assert.equal(mine.notifications.length, 1);
    const theirs = await list(second.api);
    assert.deepEqual(theirs.notifications, [], 'لا صفوف من مستخدم آخر');

    const attempts = await second.api.post(`/api/v1/notifications/${mine.notifications[0]!.id}/acknowledge`);
    assert.equal(attempts.status, 404, 'اعتراف بتنبه غيره = غير موجود');

    const anon = client(server.baseUrl);
    assert.equal((await anon.get('/api/v1/notifications')).status, 401);
    assert.equal((await anon.post('/api/v1/notifications/acknowledge-all')).status, 401);
    assert.equal((await anon.get('/api/v1/notifications/counts')).status, 401);
  });

  it('الترقيم مؤشِّر وثابت، والمؤشِّر التالف يُرفض', async () => {
    const { api, userId } = await register('alerts-cursor@example.test');
    setCounts(userId, counts({ uncertain: 1, awaitingReview: 1, needsReauth: 1 }));

    const page1 = await list(api, '?limit=2');
    assert.equal(page1.notifications.length, 2);
    assert.ok(page1.nextCursor, 'يجب أن يوجد مؤشِّر تالٍ');
    const page2 = await list(api, `?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`);
    assert.equal(page2.notifications.length, 1);
    assert.equal(page2.nextCursor, null, 'آخر صفحة بلا مؤشِّر');

    const ids = new Set([...page1.notifications, ...page2.notifications].map((item) => item.id));
    assert.equal(ids.size, 3, 'لا تكرار ولا فقدان بين الصفحتين');

    const bad = await api.get('/api/v1/notifications?cursor=not-a-cursor');
    assert.equal(bad.status, 400);
    assert.equal((bad.body as { error: { code: string } }).error.code, 'invalid_cursor');

    const tooBig = await api.get('/api/v1/notifications?limit=101');
    assert.equal(tooBig.status, 400);
  });

  it('لا نص حر ولا أرقام تواصل ولا أسرار في الاستجابة', async () => {
    const { api, userId } = await register('alerts-clean@example.test');
    setCounts(userId, counts({ uncertain: 1, needsReauth: 1 }));
    const body = JSON.stringify(await list(api, '?status=all'));
    assert.doesNotMatch(body, /777123456/, 'لا أرقام تواصل');
    assert.doesNotMatch(body, /AA[A-Za-z0-9_-]{10,}/, 'لا رموز بوت');
    for (const alert of JSON.parse(body).notifications as AlertBody[]) {
      assert.match(alert.key, /^[a-z][a-z0-9_]{2,39}$/);
      assert.ok(JSON.stringify(alert.payload).length <= 400);
    }
  });
});
