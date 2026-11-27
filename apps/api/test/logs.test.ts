/**
 * اختبارات الدفعة P4-ج: السجلات والأخطاء.
 *
 * المحور الحاكم: **الصرامة في عدم التسريب**. لا نص رسالة، لا رقم تواصل، لا رمز بوت —
 * لا في سجل الأخطاء، ولا في أي استجابة، ولا حتى لو حاول المستدعي تمريرها.
 * والقاعدة نفسها ترفض الصف المشكوك فيه (قيد مخطط، لا اجتهاد بشري).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { DeliveryWorker as WorkerType } from '../src/modules/publishing/deliveryWorker.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let admin: TestClient;
let recordErrorEvent: typeof import('../src/lib/errorLog.js').recordErrorEvent;
let cleanDetail: typeof import('../src/lib/errorLog.js').cleanDetail;

const JOB_TEXT = 'مطلوب مبرمج خبرة سنتين، الراتب 900 دولار، للتواصل 777123456';

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });

  const errorLog = await import('../src/lib/errorLog.js');
  recordErrorEvent = errorLog.recordErrorEvent;
  cleanDetail = errorLog.cleanDetail;

  admin = client(server.baseUrl);
  const registered = await admin.post('/api/v1/auth/register', {
    email: 'logs-admin@example.test',
    displayName: 'مدير سجلات',
    password: 'CorrectHorse123',
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  await server.sql("update users set role = 'admin' where email = $1", ['logs-admin@example.test']);
});

after(async () => {
  await server.close();
});

async function freshUser(tag: string): Promise<{ api: TestClient; userId: string }> {
  const api = client(server.baseUrl);
  const email = `logs-${tag}@example.test`;
  const res = await api.post('/api/v1/auth/register', {
    email,
    displayName: `مستخدم ${tag}`,
    password: 'CorrectHorse123',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = await server.sql<{ id: string }>('select id from users where email = $1', [email]);
  return { api, userId: row.rows[0]!.id };
}

interface LogsBody {
  logs: {
    id: number;
    scope: string;
    kind: string;
    code: string;
    severity: string;
    detail: string | null;
    correlationId: string | null;
    occurredAt: string;
  }[];
  nextCursor: string | null;
}

describe('تقنيع المقطع (وحدات)', () => {
  it('يرفض رموز البوت والأرقام الطويلة رفضاً كاملاً', () => {
    assert.equal(cleanDetail('123456789:AAHfakeTOKENvalue_here'), null);
    assert.equal(cleanDetail('phone 777123456'), null);
    assert.equal(cleanDetail('http.500'), 'http.500');
    assert.equal(cleanDetail('policy.content'), 'policy.content');
    assert.equal(cleanDetail('attempt.3'), 'attempt.3');
  });

  it('يرفض النص الحر والعربي بدل تمريره', () => {
    assert.equal(cleanDetail('نص رسالة عربية كاملة'), null);
    assert.equal(cleanDetail('hello world'), null, 'نص إنجليزي حر ليس تفصيلاً');
    assert.equal(cleanDetail('مطلوب مبرمج'), null);
    assert.equal(cleanDetail('http.500.extra.segments.more'), null);
    assert.equal(cleanDetail('unknown.prefix'), null);
    assert.equal(cleanDetail(''), null);
    assert.equal(cleanDetail(null), null);
  });
});

describe('منع المحتوى على مستوى المخطط (لا اجتهاد)', () => {
  it('ترفض قاعدة البيانات تفصيلاً عربياً أو رمزاً حتى لو جاء خارج المسار الآمن', async () => {
    const arabic = await server
      .sql(
        `insert into error_events (scope, kind, code, severity, detail)
         values ('system', 'direct_insert', 'TEST_CODE', 'error', $1)`,
        ['نص رسالة سرية'],
      )
      .then(() => 'inserted')
      .catch((err: Error) => err.message);
    assert.match(String(arabic), /error_events_detail_shape/);

    const token = await server
      .sql(
        `insert into error_events (scope, kind, code, severity, detail)
         values ('system', 'direct_insert', 'TEST_CODE', 'error', $1)`,
        ['123456789:AAHfakeTOKEN'],
      )
      .then(() => 'inserted')
      .catch((err: Error) => err.message);
    assert.match(String(token), /error_events_detail_shape/);

    const english = await server
      .sql(
        `insert into error_events (scope, kind, code, severity, detail)
         values ('system', 'direct_insert', 'TEST_CODE', 'error', $1)`,
        ['hello-world-free-text'],
      )
      .then(() => 'inserted')
      .catch((err: Error) => err.message);
    assert.match(String(english), /error_events_detail_shape/);
  });

  it('المقطع الآلي المقنَّع يُقبل', async () => {
    await server.sql(
      `insert into error_events (scope, kind, code, severity, detail)
       values ('system', 'direct_insert', 'TEST_CODE', 'warn', 'http.500')`,
    );
    const row = await server.sql<{ detail: string }>(
      "select detail from error_events where kind = 'direct_insert'",
    );
    assert.equal(row.rows[0]?.detail, 'http.500');
  });
});

describe('سجل المستخدم', () => {
  it('يعيد صفوف المالك فقط، وبلا أي نص رسالة أو رقم', async () => {
    const a = await freshUser('owner-a');
    const b = await freshUser('owner-b');
    await recordErrorEvent({
      scope: 'publishing',
      kind: 'send_failed',
      code: 'server_unknown',
      severity: 'critical',
      userId: a.userId,
      detail: `message ${JOB_TEXT}`,
    });
    await recordErrorEvent({
      scope: 'telegram',
      kind: 'auth_failed',
      code: 'AUTH_KEY_UNREGISTERED',
      severity: 'critical',
      userId: a.userId,
    });
    await recordErrorEvent({
      scope: 'system',
      kind: 'retention_failed',
      code: 'RUN_FAILED',
      userId: b.userId,
    });

    const res = await a.api.get('/api/v1/logs');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as LogsBody;
    assert.equal(body.logs.length, 2, 'لا يتسرّب صف المستخدم الآخر');
    for (const log of body.logs) {
      assert.ok(['publishing', 'telegram'].includes(log.scope));
    }

    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes('مطلوب مبرمج'), 'لا نص رسالة في السجل');
    assert.ok(!raw.includes('777123456'), 'لا رقم تواصل في السجل');
    // التفصيل الحر (نص الرسالة) لم يُخزَّن أصلاً: الرفض الآمن أنظف من التقنيع.
    const detail = body.logs.find((log) => log.kind === 'send_failed')?.detail;
    assert.equal(detail, null);

    const other = await b.api.get('/api/v1/logs');
    assert.equal((other.body as LogsBody).logs.length, 1);
    assert.equal((other.body as LogsBody).logs[0]?.scope, 'system');
  });

  it('يصفّي بالنطاق والخطورة والرمز', async () => {
    const { api, userId } = await freshUser('filters');
    for (const [scope, kind, code, severity] of [
      ['publishing', 'send_failed', 'server_unknown', 'critical'],
      ['publishing', 'send_retryable', 'flood_wait', 'warn'],
      ['telegram', 'connection_failed', 'TIMEOUT', 'error'],
    ] as const) {
      await recordErrorEvent({ scope, kind, code, severity, userId });
    }

    const byScope = (await api.get('/api/v1/logs?scope=publishing')).body as LogsBody;
    assert.equal(byScope.logs.length, 2);

    const bySeverity = (await api.get('/api/v1/logs?severity=warn')).body as LogsBody;
    assert.equal(bySeverity.logs.length, 1);
    assert.equal(bySeverity.logs[0]?.code, 'flood_wait');

    const byCode = (await api.get('/api/v1/logs?code=server_unknown')).body as LogsBody;
    assert.equal(byCode.logs.length, 1);

    const bad = await api.get('/api/v1/logs?scope=nope');
    assert.equal(bad.status, 400);
  });

  it('يرقّم بالمؤشِّر بلا تكرار ولا فقدان، ويرفض المؤشِّر الفاسد', async () => {
    const { api, userId } = await freshUser('cursor');
    for (let i = 0; i < 5; i += 1) {
      await recordErrorEvent({
        scope: 'processing',
        kind: 'classify_failed',
        code: `CODE_${i}`,
        severity: 'warn',
        userId,
      });
    }
    const first = (await api.get('/api/v1/logs?limit=2')).body as LogsBody;
    assert.equal(first.logs.length, 2);
    assert.ok(first.nextCursor);

    const second = (await api.get(`/api/v1/logs?limit=2&cursor=${first.nextCursor}`)).body as LogsBody;
    assert.equal(second.logs.length, 2);
    const firstIds = new Set(first.logs.map((log) => log.id));
    assert.ok(second.logs.every((log) => !firstIds.has(log.id)), 'لا تكرار بين الصفحتين');

    const third = (await api.get(`/api/v1/logs?limit=2&cursor=${second.nextCursor}`)).body as LogsBody;
    assert.equal(third.logs.length, 1);
    assert.equal(third.nextCursor, null);

    assert.equal((await api.get('/api/v1/logs?cursor=not-a-cursor')).status, 400);
    assert.equal((await api.get('/api/v1/logs?limit=500')).status, 400);
  });

  it('يتطلب جلسة صالحة', async () => {
    assert.equal((await client(server.baseUrl).get('/api/v1/logs')).status, 401);
  });
});

describe('تجميع الأخطاء للمدير', () => {
  it('يرفض غير المدير ويقبل المدير بأعداد بلا هوية مستخدم', async () => {
    const anonymous = await fetch(`${server.baseUrl}/api/v1/admin/errors`);
    assert.equal(anonymous.status, 401);

    const { api } = await freshUser('admin-view');
    assert.equal((await api.get('/api/v1/admin/errors')).status, 403);

    const res = await admin.get('/api/v1/admin/errors?windowHours=720');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const payload = (res.body as {
      errors: {
        groups: { scope: string; kind: string; code: string; occurrences: number; affectedUsers: number }[];
        totals: { total: number; critical: number };
        windowHours: number;
      };
    }).errors;
    assert.ok(Array.isArray(payload.groups));
    assert.ok(payload.totals.total >= 1);
    assert.equal(payload.windowHours, 720);

    // لا حقل هوية ولا تفصيل في استجابة المدير: تجميع فقط.
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes('userId'));
    assert.ok(!raw.includes('detail'));
    assert.ok(!raw.includes('@example.test'));
    assert.ok(!raw.includes('777123456'));
    for (const group of payload.groups) {
      assert.equal(typeof group.affectedUsers, 'number');
    }
  });

  it('يجمع التكرار في صف واحد لكل (نطاق، نوع، رمز)', async () => {
    const { userId } = await freshUser('aggregate');
    for (let i = 0; i < 3; i += 1) {
      await recordErrorEvent({ scope: 'auth', kind: 'login_failed', code: 'BAD_CREDENTIALS', userId });
    }
    const res = await admin.get('/api/v1/admin/errors?scope=auth&windowHours=720');
    const group = (res.body as { errors: { groups: { code: string; occurrences: number; affectedUsers: number }[] } })
      .errors.groups.find((row) => row.code === 'BAD_CREDENTIALS');
    assert.ok(group);
    assert.equal(group?.occurrences, 3);
    assert.equal(group?.affectedUsers, 1);
  });
});

describe('التسجيل التلقائي من عامل النشر', () => {
  it('فشل الإرسال يُنتج حدثاً يخص صاحب التسليم بلا نص ولا رمز', async () => {
    const h: ScenarioHarness = await scenario.create();
    await scenario.route(h);
    await scenario.emit(h, JOB_TEXT);
    // تجهيز التسليم للإرسال الفعلي ثم إفشاله بخطأ خادم (5xx ⇒ نتيجة مجهولة).
    await server.sql(
      "update deliveries set status = 'queued', review = 'not_required', approved_version = plan_version",
    );
    const { BotApiError } = await import('../src/modules/publishing/botApiClient.js');
    botApi.sendError = new BotApiError('Internal Server Error', 'server', { httpStatus: 500 });

    const { PgDeliveryStore } = await import('../src/modules/publishing/deliveryStore.js');
    const { DeliveryWorker, ChatSpacer } = await import('../src/modules/publishing/deliveryWorker.js');
    const { PublishingRuntime } = await import('../src/modules/publishing/runtime.js');
    const runtime = new PublishingRuntime({ botApi });
    const worker = new DeliveryWorker({
      store: new PgDeliveryStore(),
      botApi,
      bots: runtime.bots,
      spacer: new ChatSpacer(0),
      owner: 'logs-worker',
    }) as WorkerType;
    try {
      await worker.tick();
    } finally {
      botApi.sendError = null;
    }

    const rows = await server.sql<{ code: string; severity: string; detail: string | null; user_id: string }>(
      "select code, severity, detail, user_id from error_events where kind = 'send_failed' and user_id = $1",
      [h.userId],
    );
    assert.ok(rows.rows.length >= 1, 'فشل الإرسال يجب أن يُسجَّل');
    const row = rows.rows[0]!;
    assert.equal(row.code, 'server_unknown');
    assert.equal(row.severity, 'critical');
    assert.equal(row.detail, 'http.500');
    assert.equal(row.user_id, h.userId);

    // والسجل الظاهر للمستخدم خالٍ من أي محتوى.
    const listed = await h.api.get('/api/v1/logs?scope=publishing');
    assert.equal(listed.status, 200);
    const raw = JSON.stringify(listed.body);
    assert.ok(!raw.includes('مطلوب مبرمج'));
    assert.ok(!raw.includes('777123456'));
    assert.ok(!raw.includes('AAH'));
  });
});
