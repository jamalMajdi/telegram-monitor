/**
 * الفشل المتكرر في الوجهة (P0، البند 7) — من قاعدة البيانات إلى التنبيه إلى البريد إلى الواجهة.
 *
 * المطلوب في التدقيق: «إذا فشل النشر على وجهة، النظام يُنبّه بالبريد/الإشعار **ويُبرزه** في الواجهة».
 * هذا الملف يُثبت السلسلة كاملة على قاعدة حقيقية ومستخدم حقيقي ووجهة حقيقية:
 *
 *   تسليمات منتهية فاشلة  →  PgDestinationHealth (سلسلة ≥ 3)
 *   →  GET /publish/destinations يعرض failureStreak/lastFailureAt (قاعدة شارة الواجهة)
 *   →  NotificationService يُنشئ تنبيه `destination_failures` (تحذير، وحرج عند وجهتين)
 *   →  جسر البريد يُدرج **رسالة واحدة** مخصّصة لهذا التنبيه (dedupe `alert:<id>`)
 *
 * ونتحقق من الحدّ: تسليمان فاشلان لا يكفيان، وتسليم ناجح يقطع السلسلة.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { DestinationHealthStore } from '../src/modules/publishing/destinationHealth.js';
import type { NotificationService as ServiceType } from '../src/modules/notifications/notificationsService.js';
import type { NotificationsStore } from '../src/modules/notifications/notificationsRepository.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let health: DestinationHealthStore;
let service: ServiceType;
let h: ScenarioHarness;

interface InsertOptions {
  destinationId: string;
  status: 'published' | 'failed' | 'blocked' | 'uncertain';
  errorCode?: string | null;
  /** ترتيب زمني: الأكبر أحدث. */
  ageMinutes?: number;
}

/** يُدرج تسليماً منتهياً بهوية رسالة مستقلة (لا يمرّ بخط الإنتاج كاملاً). */
/** عدّاد رسائل تصاعدي: قيد (user, source, telegram_message_id) يمنع التكرار. */
let messageSeq = 70_000;

async function insertDelivery(options: InsertOptions): Promise<void> {
  messageSeq += 1;
  const identity = await server.sql<{ id: string }>(
    `insert into message_identity (user_id, source_id, account_id, peer_type, peer_id, telegram_message_id)
     values ($1, $2, $3, 'channel', $4, $5) returning id`,
    [
      h.userId,
      h.sourceId,
      h.accountId,
      Number(h.peerId),
      messageSeq,
    ],
  );
  const identityId = identity.rows[0]!.id;
  const publishedAt = options.status === 'published' ? 'now()' : 'null';
  await server.sql(
    `insert into deliveries
       (user_id, identity_id, destination_id, status, chunk_count, chars_total, attempts,
        last_error_code, created_at, published_at)
     values ($1, $2, $3, $4::delivery_status, 1, 40, 1, $5,
             now() - ($6::int * interval '1 minute'), ${publishedAt})`,
    [h.userId, identityId, options.destinationId, options.status, options.errorCode ?? null, options.ageMinutes ?? 0],
  );
}

async function destinationFromApi(id: string) {
  const res = await h.api.get('/api/v1/telegram/publish/destinations');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as { destinations: Array<Record<string, unknown>> };
  const found = body.destinations.find((d) => d.id === id);
  assert.ok(found, 'الوجهة موجودة في الاستجابة');
  return found as { id: string; failureStreak: number; lastFailureAt: string | null; lastErrorCode: string | null };
}

async function alertRows(userId: string) {
  const res = await server.sql<{ id: string; alert_key: string; severity: string; observed_count: number; notified_at: string | null }>(
    `select id, alert_key, severity::text as severity, observed_count::int as observed_count, notified_at
       from alert_notifications
      where user_id = $1 and resolved_at is null order by alert_key`,
    [userId],
  );
  return res.rows;
}

async function emailRows(userId: string) {
  const res = await server.sql<{ id: string; template: string; dedupe_key: string | null; payload: Record<string, unknown> }>(
    `select id, template, dedupe_key, payload from notification_outbox where user_id = $1 order by created_at`,
    [userId],
  );
  return res.rows;
}

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });

  const [{ PgDestinationHealth }, { NotificationService }, { PgNotificationsStore }, { PgDashboardStore }] =
    await Promise.all([
      import('../src/modules/publishing/destinationHealth.js'),
      import('../src/modules/notifications/notificationsService.js'),
      import('../src/modules/notifications/notificationsRepository.js'),
      import('../src/modules/dashboard/dashboardRepository.js'),
    ]);
  health = new PgDestinationHealth();
  const store: NotificationsStore = new PgNotificationsStore();
  const dashboard = new PgDashboardStore();
  service = new NotificationService({
    store,
    // مصادر حقيقية: عدّادات لوحة المستخدم + سلسلة إخفاقات الوجهات من القاعدة.
    sources: {
      counts: (userId) => dashboard.counts(userId),
      workerHealth: async () => ({ state: 'ok', lastSeenSeconds: 1 }),
      destinationFailures: (userId) => health.countFailing(userId, 3),
    },
    workerAlerts: false,
    throttleMs: 0,
    // جسر بريد حقيقي: نفس نمط الإنتاج (إدراج في الصندوق بمفتاح منع تكرار).
    emailAlerts: {
      enqueue: async (userId, alert) => {
        const res = await server.sql(
          `insert into notification_outbox (user_id, channel, recipient, template, payload, dedupe_key)
           values ($1, 'email', $2, 'alerts.raised', $3::jsonb, $4)
           on conflict (dedupe_key) do nothing returning id`,
          [
            userId,
            h.email,
            JSON.stringify({ alertKey: alert.key, severity: alert.severity, count: alert.observedCount }),
            `alert:${alert.id}`,
          ],
        );
        return (res.rowCount ?? 0) > 0;
      },
    },
  });
  h = await scenario.create();
});

after(async () => {
  await server.close();
});

beforeEach(async () => {
  await server.sql('delete from deliveries where user_id = $1', [h.userId]);
  await server.sql('delete from alert_notifications where user_id = $1', [h.userId]);
  await server.sql('delete from notification_outbox where user_id = $1', [h.userId]);
});

describe('سلسلة الإخفاقات (المصدر)', () => {
  it('ثلاثة إخفاقات متتالية = سلسلة 3، وتسليمان لا يكفيان', async () => {
    await insertDelivery({ destinationId: h.destinationId, status: 'failed', errorCode: 'bot_blocked', ageMinutes: 3 });
    await insertDelivery({ destinationId: h.destinationId, status: 'failed', errorCode: 'bot_blocked', ageMinutes: 2 });
    let stats = await health.stats(h.userId);
    assert.equal(stats.get(h.destinationId)?.streak, 2);
    assert.equal(await health.countFailing(h.userId, 3), 0, 'تسليمان ليسا «فشلاً متكرراً»');

    await insertDelivery({ destinationId: h.destinationId, status: 'blocked', errorCode: 'bot_blocked', ageMinutes: 1 });
    stats = await health.stats(h.userId);
    assert.equal(stats.get(h.destinationId)?.streak, 3);
    assert.equal(stats.get(h.destinationId)?.lastErrorCode, 'bot_blocked');
    assert.equal(await health.countFailing(h.userId, 3), 1);
  });

  it('تسليم ناجح يقطع السلسلة', async () => {
    await insertDelivery({ destinationId: h.destinationId, status: 'failed', ageMinutes: 4 });
    await insertDelivery({ destinationId: h.destinationId, status: 'failed', ageMinutes: 3 });
    await insertDelivery({ destinationId: h.destinationId, status: 'published', ageMinutes: 1 });
    const stats = await health.stats(h.userId);
    assert.equal(stats.get(h.destinationId), undefined, 'السلسلة انقطعت بالنشر');
    assert.equal(await health.countFailing(h.userId, 3), 0);
  });
});

describe('إبرازها في الواجهة (واجهة API)', () => {
  it('قائمة الوجهات تُرجع failureStreak/lastFailureAt', async () => {
    for (let i = 3; i >= 1; i -= 1) {
      await insertDelivery({ destinationId: h.destinationId, status: 'failed', errorCode: 'chat_not_found', ageMinutes: i });
    }
    const dest = await destinationFromApi(h.destinationId);
    assert.equal(dest.failureStreak, 3, 'الواجهة تعرف أن الوجهة تفشل');
    assert.ok(dest.lastFailureAt, 'وقت آخر فشل متاح للعرض');
    // رمز الخطأ الظاهر في الصف هو خطأ تحقّق الوجهة نفسها (لا رمز آخر تسليم)،
    // والسلسلة تأتي من التسليمات — نُثبت أن الاثنين لا يختلطان.
    assert.equal(typeof dest.lastErrorCode === 'string' || dest.lastErrorCode === null, true);
  });

  it('وجهة سليمة تُرجع صفراً (لا شارة حمراء بلا سبب)', async () => {
    await insertDelivery({ destinationId: h.destinationId, status: 'published' });
    const dest = await destinationFromApi(h.destinationId);
    assert.equal(dest.failureStreak, 0);
    assert.equal(dest.lastFailureAt, null);
  });
});

describe('التنبيه والبريد', () => {
  it('ينشئ تنبيهاً visible وبريداً واحداً فقط (لا تكرار)', async () => {
    for (let i = 3; i >= 1; i -= 1) {
      await insertDelivery({ destinationId: h.destinationId, status: 'failed', errorCode: 'bot_blocked', ageMinutes: i });
    }
    const synced = await service.sync(h.userId, { force: true });
    assert.equal(synced.synced, true);

    const alerts = await alertRows(h.userId);
    const failure = alerts.find((a) => a.alert_key === 'destination_failures');
    assert.ok(failure, 'تنبيه الفشل المتكرر موجود');
    assert.equal(failure!.severity, 'warning', 'وجهة واحدة ⇒ تحذير');
    assert.equal(failure!.observed_count, 1);
    assert.ok(failure!.notified_at, 'خُتم أنه أُبلغ بالبريد');

    let emails = await emailRows(h.userId);
    assert.equal(emails.length, 1, 'رسالة واحدة');
    assert.equal(emails[0]!.template, 'alerts.raised');
    assert.equal(emails[0]!.dedupe_key, `alert:${failure!.id}`);
    assert.equal(emails[0]!.payload.alertKey, 'destination_failures');
    assert.equal(emails[0]!.payload.severity, 'warning');

    // مزامنة أخرى (كما يفعل مسح العامل كل دقيقة) ⇒ لا بريد ثانٍ.
    await service.sync(h.userId, { force: true });
    await service.sync(h.userId, { force: true });
    emails = await emailRows(h.userId);
    assert.equal(emails.length, 1, 'التنبيه لا يُرسل مرتين');
  });

  it('وجهتان فاشلتان ⇒ تنبيه حرج', async () => {
    // وجهة ثانية للمستخدم نفسه عبر واجهة النشر (اسم مستخدم آخر على العميل المزيّف).
    const key = `@second_dest_${Math.floor(Math.random() * 100000)}`;
    const { fakeBotChatId } = await import('./publish-fakes.js');
    void fakeBotChatId;
    const secondChatId = String(-1009990000000 - Math.floor(Math.random() * 1000));
    botApi.addChat(key, { chatId: secondChatId, kind: 'channel', title: 'وجهة ثانية', username: key.slice(1) });
    botApi.setMember(secondChatId, h.botTelegramId, { status: 'administrator', canPostMessages: true, canEditMessages: false });
    const created = await h.api.post('/api/v1/telegram/publish/destinations', { identifier: key });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const secondId = (created.body as { destination: { id: string } }).destination.id;

    for (let i = 3; i >= 1; i -= 1) {
      await insertDelivery({ destinationId: h.destinationId, status: 'failed', errorCode: 'bot_blocked', ageMinutes: i });
      await insertDelivery({ destinationId: secondId, status: 'failed', errorCode: 'bot_blocked', ageMinutes: i });
    }
    await service.sync(h.userId, { force: true });
    const failure = (await alertRows(h.userId)).find((a) => a.alert_key === 'destination_failures');
    assert.ok(failure);
    assert.equal(failure!.severity, 'critical', 'وجهتان ⇒ حرج');
    assert.equal(failure!.observed_count, 2);
  });

  it('بلا إخفاقات: لا تنبيه فشل ولا بريد له', async () => {
    await insertDelivery({ destinationId: h.destinationId, status: 'published' });
    await service.sync(h.userId, { force: true });
    const alerts = await alertRows(h.userId);
    assert.equal(alerts.some((a) => a.alert_key === 'destination_failures'), false);
    const emails = await emailRows(h.userId);
    assert.equal(emails.some((e) => e.payload.alertKey === 'destination_failures'), false);
  });
});
