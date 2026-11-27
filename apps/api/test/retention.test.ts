/**
 * اختبارات الدفعة P4-د (الجزء الأول): الاحتفاظ والسياسات.
 *
 * المحاور: السياسات تحذف المنتهي فقط، ولا تمسّ الحيّ (تسليم في الطابور أو انتظار مراجعة)،
 * كل تشغيل يُسجَّل في `retention_runs` بعدد صحيح، والمشغّل لا يتداخل مع نفسه.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { RetentionService as RetentionServiceType } from '../src/modules/retention/retentionService.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let admin: TestClient;
let retention: RetentionServiceType;
let RetentionServiceClass: typeof RetentionServiceType;

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });

  const [{ RetentionService }, { PgRetentionStore }, { PgMessageProcessingStore }, { PgIngestStore }] =
    await Promise.all([
      import('../src/modules/retention/retentionService.js'),
      import('../src/modules/retention/retentionRepository.js'),
      import('../src/modules/processing/messageProcessingRepository.js'),
      import('../src/modules/telegram/ingestRepository.js'),
    ]);
  RetentionServiceClass = RetentionService;
  const processing = new PgMessageProcessingStore();
  const ingest = new PgIngestStore();
  retention = new RetentionService({
    store: new PgRetentionStore(),
    purgeContent: () => processing.purgeExpiredContent(),
    purgeIdentities: () => ingest.purgeIdentitiesOlderThan(1),
    intervalMinutes: 60,
  });

  admin = client(server.baseUrl);
  const registered = await admin.post('/api/v1/auth/register', {
    email: 'retention-admin@example.test',
    displayName: 'مدير احتفاظ',
    password: 'CorrectHorse123',
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  await server.sql("update users set role = 'admin' where email = $1", ['retention-admin@example.test']);
});

after(async () => {
  await server.close();
});

describe('سياسات الاحتفاظ (Q23)', () => {
  it('تحذف التسليمات المنتهية فقط وتُبقي ما زال حيّاً', async () => {
    const h = await scenario.create();
    const routeId = await scenario.route(h);
    const identityId = await scenario.emit(h, 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية');
    void routeId;

    // تسليم منتهٍ (قديم) + تسليم حيّ قديم ينتظر مراجعة: الثاني يجب ألا يُحذف.
    const oldIdentity = await server.sql<{ id: string }>(
      `insert into message_identity (user_id, source_id, account_id, peer_type, peer_id, telegram_message_id, first_seen_at)
       values ($1, $2, $3, 'channel', $4, 990001, now() - interval '200 days') returning id`,
      [h.userId, h.sourceId, h.accountId, h.peerId],
    );
    const stale = await server.sql<{ id: string }>(
      `insert into deliveries (user_id, identity_id, destination_id, status, created_at)
       values ($1, $2, $3, 'published', now() - interval '120 days') returning id`,
      [h.userId, oldIdentity.rows[0]!.id, h.destinationId],
    );
    // التسليم الذي أنشأه التوجيه لهذه الرسالة نُحوّله إلى «بانتظار مراجعة» ونُقدّم عمره:
    // حيّ = لا يُحذف بالتنظيف مهما طال.
    await server.sql(
      `update deliveries set status = 'awaiting_review', created_at = now() - interval '120 days'
        where identity_id = $1`,
      [identityId],
    );
    const live = await server.sql<{ id: string }>('select id from deliveries where identity_id = $1', [identityId]);

    const { PgRetentionStore } = await import('../src/modules/retention/retentionRepository.js');
    const deleted = await new PgRetentionStore().purgeExpiredDeliveries();
    assert.ok(deleted >= 1);

    const gone = await server.sql('select 1 from deliveries where id = $1', [stale.rows[0]!.id]);
    assert.equal(gone.rowCount, 0, 'التسليم المنتهي يُحذف');
    const kept = await server.sql('select 1 from deliveries where id = $1', [live.rows[0]!.id]);
    assert.equal(kept.rowCount, 1, 'التسليم الحيّ لا يُحذف مهما طال عمره');
  });

  it('تحترم احتفاظ المستخدم المخصص للتسليمات', async () => {
    const h = await scenario.create();
    await server.sql('update user_settings set delivery_retention_days = 7 where user_id = $1', [h.userId]);
    const identity = await server.sql<{ id: string }>(
      `insert into message_identity (user_id, source_id, account_id, peer_type, peer_id, telegram_message_id)
       values ($1, $2, $3, 'channel', $4, 990002) returning id`,
      [h.userId, h.sourceId, h.accountId, h.peerId],
    );
    const delivery = await server.sql<{ id: string }>(
      `insert into deliveries (user_id, identity_id, destination_id, status, created_at)
       values ($1, $2, $3, 'failed', now() - interval '10 days') returning id`,
      [h.userId, identity.rows[0]!.id, h.destinationId],
    );
    const { PgRetentionStore } = await import('../src/modules/retention/retentionRepository.js');
    await new PgRetentionStore().purgeExpiredDeliveries();
    const row = await server.sql('select 1 from deliveries where id = $1', [delivery.rows[0]!.id]);
    assert.equal(row.rowCount, 0, '10 أيام تتجاوز سياسة 7 أيام للمستخدم');
  });

  it('تحذف أحداث الأخطاء والتدقيق بحسب سياسة النظام', async () => {
    await server.sql(
      `insert into error_events (scope, kind, code, severity, occurred_at)
       values ('system', 'old_event', 'OLD_CODE', 'warn', now() - interval '45 days')`,
    );
    await server.sql(
      `insert into error_events (scope, kind, code, severity)
       values ('system', 'new_event', 'NEW_CODE', 'warn')`,
    );
    await server.sql(
      `insert into audit_events (action, outcome, occurred_at)
       values ('system.old_event', 'success', now() - interval '400 days')`,
    );

    const { PgRetentionStore } = await import('../src/modules/retention/retentionRepository.js');
    const store = new PgRetentionStore();
    const errorDays = await store.systemDays('system.error_events_retention_days', 30);
    const auditDays = await store.systemDays('system.audit_retention_days', 180);
    assert.equal(errorDays, 30);
    assert.equal(auditDays, 180);

    await store.purgeErrorEvents(errorDays);
    await store.purgeAuditEvents(auditDays);

    assert.equal((await server.sql("select 1 from error_events where kind = 'old_event'")).rowCount, 0);
    assert.equal((await server.sql("select 1 from error_events where kind = 'new_event'")).rowCount, 1);
    assert.equal((await server.sql("select 1 from audit_events where action = 'system.old_event'")).rowCount, 0);
  });

  it('تقرأ سياسة النظام من قاعدة البيانات لا من الكود، وتتجاهل القيمة غير الصالحة', async () => {
    const { PgRetentionStore } = await import('../src/modules/retention/retentionRepository.js');
    const store = new PgRetentionStore();
    await server.sql(
      `update system_settings set value = '{"days": 7}'::jsonb where key = 'system.error_events_retention_days'`,
    );
    assert.equal(await store.systemDays('system.error_events_retention_days', 30), 7);
    await server.sql(
      `update system_settings set value = '{"days": "غريب"}'::jsonb where key = 'system.error_events_retention_days'`,
    );
    assert.equal(await store.systemDays('system.error_events_retention_days', 30), 30, 'قيمة غير صالحة ⇒ الافتراضي');
    await server.sql(
      `update system_settings set value = '{"days": 30}'::jsonb where key = 'system.error_events_retention_days'`,
    );
  });
});

describe('سجل التشغيل (retention_runs)', () => {
  it('يسجّل صفاً لكل سياسة في كل دورة، بأعداد صحيحة', async () => {
    await server.sql('delete from retention_runs');
    const before = await server.sql<{ total: number }>(
      "select count(*)::int as total from error_events where kind = 'cycle_old'",
    );
    assert.equal(Number(before.rows[0]?.total), 0);
    await server.sql(
      `insert into error_events (scope, kind, code, severity, occurred_at)
       values ('system', 'cycle_old', 'CYCLE_OLD', 'warn', now() - interval '90 days')`,
    );

    const result = await retention.runCycle('scheduler');
    assert.equal(result.runs.length, 5, 'خمس سياسات: محتوى، هويات، تسليمات، أخطاء، تدقيق');
    assert.deepEqual(
      result.runs.map((run) => run.policy),
      ['content', 'identities', 'deliveries', 'error_events', 'audit_events'],
    );
    assert.ok(result.runs.every((run) => run.errorCode === null));

    const runs = await server.sql<{ policy: string; triggered_by: string; deleted: number; finished_at: Date | null }>(
      'select policy, triggered_by, deleted, finished_at from retention_runs order by id',
    );
    assert.equal(runs.rows.length, 5);
    assert.ok(runs.rows.every((row) => row.finished_at instanceof Date));
    assert.ok(runs.rows.every((row) => row.triggered_by === 'scheduler'));
    const errorsRun = runs.rows.find((row) => row.policy === 'error_events');
    assert.ok(Number(errorsRun?.deleted) >= 1, 'الحدث المنتهي محسوب في العدد');
  });

  it('لا تتداخل الدورات: النداء المتزامن الثاني يُتجاهل', async () => {
    const [first, second] = await Promise.all([retention.runCycle('scheduler'), retention.runCycle('scheduler')]);
    const total = first.runs.length + second.runs.length;
    assert.equal(total, 5, 'دورة واحدة فقط تُنفَّذ فعلياً');
  });

  it('فشل سياسة لا يوقف البقية ويُسجَّل برمز آلي', async () => {
    const failing = new RetentionServiceClass({
      store: (await import('../src/modules/retention/retentionRepository.js')).PgRetentionStore
        ? new (await import('../src/modules/retention/retentionRepository.js')).PgRetentionStore()
        : (null as never),
      purgeContent: () => Promise.reject(new Error('timeout while purging content')),
      purgeIdentities: () => Promise.resolve(0),
      intervalMinutes: 60,
    });
    const result = await failing.runCycle('scheduler');
    const content = result.runs.find((run) => run.policy === 'content');
    assert.equal(content?.errorCode, 'timeout');
    assert.equal(content?.deleted, 0);
    const others = result.runs.filter((run) => run.policy !== 'content');
    assert.equal(others.length, 4, 'بقية السياسات نُفِّذت رغم الفشل');
    assert.ok(others.every((run) => run.errorCode === null));

    const row = await server.sql<{ error_code: string }>(
      "select error_code from retention_runs where policy = 'content' and error_code is not null order by id desc limit 1",
    );
    assert.equal(row.rows[0]?.error_code, 'timeout');

    // وفشل الاحتفاظ نفسه يُسجَّل حدث خطأ نظامياً بلا نص استثناء.
    const event = await server.sql<{ code: string; detail: string | null }>(
      "select code, detail from error_events where kind = 'retention_failed' order by id desc limit 1",
    );
    assert.equal(event.rows[0]?.code, 'TIMEOUT');
    assert.equal(event.rows[0]?.detail, 'policy.content');
  });
});

describe('واجهة الاحتفاظ للمدير', () => {
  it('تتطلب مديراً وبسبباً مكتوباً', async () => {
    const anonymous = await fetch(`${server.baseUrl}/api/v1/admin/retention/runs`);
    assert.equal(anonymous.status, 401);

    const plain = client(server.baseUrl);
    const registered = await plain.post('/api/v1/auth/register', {
      email: 'retention-user@example.test',
      displayName: 'مستخدم عادي',
      password: 'CorrectHorse123',
    });
    assert.equal(registered.status, 201);
    assert.equal((await plain.get('/api/v1/admin/retention/runs')).status, 403);
    assert.equal((await plain.post('/api/v1/admin/retention/run', { reason: 'محاولة' })).status, 403);

    assert.equal((await admin.post('/api/v1/admin/retention/run', {})).status, 400);
    assert.equal((await admin.post('/api/v1/admin/retention/run', { reason: 'ab' })).status, 400);
  });

  it('تشغيل يدوي يُنفَّذ ويُسجَّل باسم admin ويُدقَّق', async () => {
    const res = await admin.post('/api/v1/admin/retention/run', { reason: 'تنظيف يدوي بعد اختبار' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as { result: { runs: { policy: string }[]; totalDeleted: number } };
    assert.equal(body.result.runs.length, 5);
    assert.equal(typeof body.result.totalDeleted, 'number');

    const runs = (await admin.get('/api/v1/admin/retention/runs?limit=10')).body as {
      runs: { policy: string; triggeredBy: string; startedAt: string }[];
    };
    assert.ok(runs.runs.some((run) => run.triggeredBy === 'admin'));

    const audit = await server.sql<{ metadata: { reason?: string } }>(
      "select metadata from audit_events where action = 'admin.retention_run' order by id desc limit 1",
    );
    assert.equal(audit.rows[0]?.metadata.reason, 'تنظيف يدوي بعد اختبار');
  });
});
