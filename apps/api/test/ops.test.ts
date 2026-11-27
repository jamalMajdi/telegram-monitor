/**
 * اختبارات الدفعة P4-ب: التشغيل والنبض والمقاييس.
 *
 * قاعدة PostgreSQL حقيقية + بوابة محاكاة: لا شبكة.
 * المحاور: النبض المسجَّل (Q18)، الجهوزية (Q17)، عتبة توقف العامل (Q26)،
 * أن مقاييس المدير للمدير وحده، وأن أي استجابة تشغيلية لا تحمل محتوى ولا أسراراً.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { DeliveryWorker as WorkerType } from '../src/modules/publishing/deliveryWorker.js';
import type { OpsService as OpsServiceType } from '../src/modules/ops/opsService.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let ops: OpsServiceType;
let OpsServiceClass: typeof OpsServiceType;
let PgOpsStoreClass: new () => ConstructorParameters<typeof OpsServiceType>[0]['store'];
let worker: WorkerType;
let admin: TestClient;

const JOB_TEXT = 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية';

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });

  const [{ PublishingRuntime }, { OpsService, PUBLISH_WORKER }, { PgOpsStore }, { DeliveryWorker, ChatSpacer }] =
    await Promise.all([
      import('../src/modules/publishing/runtime.js'),
      import('../src/modules/ops/opsService.js'),
      import('../src/modules/ops/opsRepository.js'),
      import('../src/modules/publishing/deliveryWorker.js'),
    ]);

  OpsServiceClass = OpsService;
  PgOpsStoreClass = PgOpsStore;
  ops = new OpsService({ store: new PgOpsStore(), staleAfterSeconds: 120 });
  const runtime = new PublishingRuntime({ botApi });
  worker = new DeliveryWorker({
    store: new (await import('../src/modules/publishing/deliveryStore.js')).PgDeliveryStore(),
    botApi,
    bots: runtime.bots,
    spacer: new ChatSpacer(0),
    owner: 'ops-worker',
    heartbeat: (meta) => ops.heartbeat(PUBLISH_WORKER, 'ops-worker', meta),
  });

  // مدير حقيقي: الترقية مباشرة في قاعدة الاختبار (مسارات الترقية مُختبَرة في مرحلة سابقة).
  admin = client(server.baseUrl);
  const registered = await admin.post('/api/v1/auth/register', {
    email: 'ops-admin@example.test',
    displayName: 'مدير تشغيل',
    password: 'CorrectHorse123',
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const row = await server.sql<{ id: string }>('select id from users where email = $1', ['ops-admin@example.test']);
  await server.sql("update users set role = 'admin' where id = $1", [row.rows[0]!.id]);
});

after(async () => {
  await server.close();
});

describe('النبض والجهوزية (P4-ب)', () => {
  it('/healthz عام ومختصر بلا تفاصيل داخلية', async () => {
    const res = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, 'ok');
    assert.deepEqual(Object.keys(body).sort(), ['checkedAt', 'service', 'status']);
  });

  it('/readyz يعيد ملخصاً صريحاً ويعلن غياب العامل قبل أول دورة', async () => {
    await server.sql('delete from worker_heartbeats');
    const res = await fetch(`${server.baseUrl}/readyz`);
    assert.equal(res.status, 200, 'قاعدة البيانات سليمة ⇒ الخادم جاهز');
    const body = (await res.json()) as {
      status: string;
      database: { ok: boolean; latencyMs: number | null };
      publishWorker: { state: string; lastSeenSeconds: number | null };
      queue: { pendingParts: number; oldestPendingAgeSeconds: number | null };
    };
    assert.equal(body.database.ok, true);
    assert.equal(typeof body.database.latencyMs, 'number');
    assert.equal(body.publishWorker.state, 'missing', 'لا نبض ⇒ لا ادّعاء حياة');
    assert.equal(body.publishWorker.lastSeenSeconds, null);
    assert.equal(typeof body.queue.pendingParts, 'number');
  });

  it('دورة العامل تسجّل نبضاً في قاعدة البيانات، والجهوزية تقرؤه', async () => {
    await worker.tick();
    const row = await server.sql<{ name: string; instance: string; meta: Record<string, unknown> }>(
      'select name, instance, meta from worker_heartbeats where name = $1',
      ['publish_worker'],
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0]?.instance, 'ops-worker');
    assert.equal(row.rows[0]?.meta.owner, 'ops-worker');

    const res = await fetch(`${server.baseUrl}/readyz`);
    const body = (await res.json()) as { publishWorker: { state: string; lastSeenSeconds: number | null } };
    assert.equal(body.publishWorker.state, 'ok');
    assert.ok((body.publishWorker.lastSeenSeconds ?? 999) < 120);
  });

  it('نبض قديم ⇒ حالة stale بلا ادّعاء صحة (عتبة Q26)', async () => {
    await server.sql("update worker_heartbeats set last_seen_at = now() - interval '5 minutes'");
    const report = await ops.readiness();
    assert.equal(report.publishWorker.state, 'stale');
    assert.ok((report.publishWorker.lastSeenSeconds ?? 0) >= 240);

    // العتبة قابلة للضبط: نفس النبض يبدو «حيّاً» بعتبة أوسع.
    const relaxed = new OpsServiceClass({ store: new PgOpsStoreClass(), staleAfterSeconds: 3600 });
    const relaxedReport = await relaxed.readiness();
    assert.equal(relaxedReport.publishWorker.state, 'ok');
  });

  it('قراءة الجهوزية لا تكشف محتوى ولا رموزاً', async () => {
    const res = await fetch(`${server.baseUrl}/readyz`);
    const raw = JSON.stringify(await res.json());
    assert.ok(!raw.includes('مطلوب مبرمج'));
    assert.ok(!raw.includes('token'));
    assert.ok(!raw.includes('777123456'));
  });
});

describe('مقاييس المدير (Q17)', () => {
  it('غير المصادق يُرفض، والمستخدم العادي يُرفض بدور، والمدير يقرأ', async () => {
    const anonymous = await fetch(`${server.baseUrl}/api/v1/admin/metrics`);
    assert.equal(anonymous.status, 401);

    const h = await scenario.create();
    const asUser = await h.api.get('/api/v1/admin/metrics');
    assert.equal(asUser.status, 403, JSON.stringify(asUser.body));

    const asAdmin = await admin.get('/api/v1/admin/metrics');
    assert.equal(asAdmin.status, 200, JSON.stringify(asAdmin.body));
    const metrics = (asAdmin.body as { metrics: Record<string, unknown> }).metrics;
    assert.ok(metrics.deliveries24h);
    assert.ok(metrics.attempts1h);
    assert.ok(metrics.ingest);
    assert.ok(Array.isArray(metrics.heartbeats));
    assert.equal(metrics.staleAfterSeconds, 120);
  });

  it('تعكس أرقاماً فعلية: طابور معلّق، نافذة محاولات، وحسابات', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    await scenario.emit(h, JOB_TEXT);

    // انتظار التخطيط: تسليم بجزء معلّق.
    let pending = 0;
    for (let attempt = 0; attempt < 40 && pending === 0; attempt += 1) {
      const row = await server.sql<{ total: number }>(
        "select count(*)::int as total from delivery_parts where status = 'pending'",
      );
      pending = Number(row.rows[0]?.total ?? 0);
      if (pending === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(pending >= 1, 'يجب أن يوجد جزء معلّق بعد التخطيط');

    let metrics = (await admin.get('/api/v1/admin/metrics')).body as {
      metrics: {
        queue: { pendingParts: number; oldestPendingAgeSeconds: number | null };
        ingest: { accountsTotal: number; accountsActive: number; messagesLast24h: number };
      };
    };
    assert.ok(metrics.metrics.queue.pendingParts >= 1);
    assert.ok((metrics.metrics.queue.oldestPendingAgeSeconds ?? -1) >= 0);
    assert.ok(metrics.metrics.ingest.accountsTotal >= 1);
    assert.ok(metrics.metrics.ingest.messagesLast24h >= 1);

    // إرسال فعلي (عميل مزيّف) ⇒ تظهر نافذة المحاولات والتسليم المنشور.
    await server.sql(
      "update deliveries set status = 'queued', review = 'not_required', approved_version = plan_version",
    );
    await worker.tick();
    metrics = (await admin.get('/api/v1/admin/metrics')).body as never;
    const after = metrics.metrics as unknown as {
      attempts1h: { total: number };
      deliveries24h: { published: number };
    };
    assert.ok(after.attempts1h.total >= 1, 'المحاولة تُسجَّل وتُعدّ');
    assert.ok(after.deliveries24h.published >= 1, 'التسليم المنشور يظهر في نافذة 24 ساعة');
  });
});
