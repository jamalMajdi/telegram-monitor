/**
 * اختبارات الدفعة P4-د (الجزء الثاني): منطقة الخطر — حذف البيانات والحساب.
 *
 * المحاور: العبارة الحرفية إلزامية (Q21/Q22)، الحذف التشغيلي لا يمسّ الحساب والإعدادات،
 * والحذف النهائي يزيل كل أثر شخصي ويُبقي تدقيقاً بلا هوية — ويُثبت ذلك بالاستعلام لا بالادّعاء.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let admin: TestClient;
let PURGE_PHRASE: string;
let DELETE_ACCOUNT_PHRASE: string;

const PASSWORD = 'CorrectHorse123';
const JOB_TEXT = 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية، للتواصل 777123456';

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });

  const zone = await import('../src/modules/users/dangerZone.js');
  PURGE_PHRASE = zone.PURGE_PHRASE;
  DELETE_ACCOUNT_PHRASE = zone.DELETE_ACCOUNT_PHRASE;

  admin = client(server.baseUrl);
  const registered = await admin.post('/api/v1/auth/register', {
    email: 'danger-admin@example.test',
    displayName: 'مدير حذف',
    password: PASSWORD,
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  await server.sql("update users set role = 'admin' where email = $1", ['danger-admin@example.test']);
});

after(async () => {
  await server.close();
});

async function withData(): Promise<ScenarioHarness> {
  const h = await scenario.create();
  await scenario.route(h);
  await scenario.emit(h, JOB_TEXT);
  return h;
}

interface PurgeBody {
  purgedAt: string;
  total: number;
  report: Record<string, number>;
}

describe('حذف البيانات التشغيلية (Q21)', () => {
  it('يرفض العبارة الناقصة أو الخاطئة، ويقبل العبارة الحرفية', async () => {
    const h = await withData();

    const missing = await h.api.post('/api/v1/me/data/purge', {});
    assert.equal(missing.status, 400);

    const wrong = await h.api.post('/api/v1/me/data/purge', { confirmation: 'نعم' });
    assert.equal(wrong.status, 400);
    const wrongBody = wrong.body as { error: { code: string; message: string } };
    assert.equal(wrongBody.error.code, 'confirmation_mismatch');
    assert.ok(wrongBody.error.message.includes(PURGE_PHRASE));

    // لا شيء حُذف قبل التأكيد.
    const still = await server.sql('select count(*)::int as total from deliveries where user_id = $1', [h.userId]);
    assert.ok(Number((still.rows[0] as { total: number }).total) >= 1);

    const ok = await h.api.post('/api/v1/me/data/purge', { confirmation: PURGE_PHRASE });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const body = ok.body as PurgeBody;
    assert.ok(body.total >= 1);
    assert.equal(typeof body.report.deliveries, 'number');
    assert.equal(typeof body.report.messageIdentities, 'number');
    assert.ok(body.purgedAt);
  });

  it('يحذف المحتوى والتسليمات ويُبقي الحساب والإعدادات والمصادر والوجهات والتدقيق', async () => {
    const h = await withData();

    // تعديل إعداد ليُثبت بقاؤه.
    const settings = await h.api.patch('/api/v1/me/settings', { contentRetentionHours: 72 });
    assert.equal(settings.status, 200, JSON.stringify(settings.body));

    const ok = await h.api.post('/api/v1/me/data/purge', { confirmation: PURGE_PHRASE });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const counts = await server.sql<{
      deliveries: number;
      identities: number;
      content: number;
      accounts: number;
      sources: number;
      destinations: number;
      settings: number;
      sessions: number;
      audit: number;
    }>(
      `select
         (select count(*)::int from deliveries where user_id = $1) as deliveries,
         (select count(*)::int from message_identity where user_id = $1) as identities,
         (select count(*)::int from message_content c join message_identity i on i.id = c.identity_id where i.user_id = $1) as content,
         (select count(*)::int from telegram_accounts where user_id = $1) as accounts,
         (select count(*)::int from telegram_sources where user_id = $1) as sources,
         (select count(*)::int from destinations where user_id = $1) as destinations,
         (select count(*)::int from user_settings where user_id = $1) as settings,
         (select count(*)::int from user_sessions where user_id = $1) as sessions,
         (select count(*)::int from audit_events where action = 'user.operational_data_purged') as audit`,
      [h.userId],
    );
    const row = counts.rows[0]!;
    assert.equal(Number(row.deliveries), 0, 'التسليمات حُذفت');
    assert.equal(Number(row.identities), 0, 'هويات الرسائل حُذفت');
    assert.equal(Number(row.content), 0, 'المحتوى حُذف');

    assert.equal(Number(row.accounts), 1, 'الحساب المرتبط يبقى');
    assert.equal(Number(row.sources), 1, 'المصادر تبقى');
    assert.equal(Number(row.destinations), 1, 'الوجهات تبقى');
    assert.equal(Number(row.settings), 1, 'الإعدادات تبقى');
    assert.ok(Number(row.sessions) >= 1, 'الجلسة تبقى — المستخدم لم يُطرد');
    assert.ok(Number(row.audit) >= 1, 'الحذف مدقَّق');

    // الحساب ما زال يعمل والعدادات صفرت بصدق.
    const summary = (await h.api.get('/api/v1/dashboard/summary?fresh=1')).body as {
      summary: { counts: { messages: { matchedTotal: number }; deliveries: { total: number } } };
    };
    assert.equal(summary.summary.counts.deliveries.total, 0);
    assert.equal(summary.summary.counts.messages.matchedTotal, 0);
  });

  it('لا يُسرّب نص الرسالة في تقرير الأثر', async () => {
    const h = await withData();
    const ok = await h.api.post('/api/v1/me/data/purge', { confirmation: PURGE_PHRASE });
    const raw = JSON.stringify(ok.body);
    assert.ok(!raw.includes('مطلوب مبرمج'));
    assert.ok(!raw.includes('777123456'));
    assert.ok(!raw.includes('AAH'));
  });

  it('عبارات التأكيد تأتي من الخادم لتبقى الواجهة متزامنة', async () => {
    const h = await withData();
    const me = (await h.api.get('/api/v1/me')).body as {
      dangerZone: { purgePhrase: string; deletePhrase: string };
    };
    assert.equal(me.dangerZone.purgePhrase, PURGE_PHRASE);
    assert.equal(me.dangerZone.deletePhrase, DELETE_ACCOUNT_PHRASE);
  });

  it('المدير يحذف بيانات مستخدم بسبب إلزامي، والمستخدم العادي لا يستطيع', async () => {
    const h = await withData();
    const userId = h.userId;

    assert.equal((await h.api.post(`/api/v1/admin/users/${userId}/purge-data`, { reason: 'سبب كافٍ' })).status, 403);

    assert.equal((await admin.post(`/api/v1/admin/users/${userId}/purge-data`, {})).status, 400);
    assert.equal((await admin.post(`/api/v1/admin/users/${userId}/purge-data`, { reason: 'لا' })).status, 400);

    const ok = await admin.post(`/api/v1/admin/users/${userId}/purge-data`, {
      reason: 'طلب المستخدم عبر الدعم الفني',
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok((ok.body as PurgeBody).total >= 1);

    const left = await server.sql('select count(*)::int as total from deliveries where user_id = $1', [userId]);
    assert.equal(Number((left.rows[0] as { total: number }).total), 0);

    const audit = await server.sql<{ metadata: { reason?: string } }>(
      "select metadata from audit_events where action = 'admin.user_data_purged' order by id desc limit 1",
    );
    assert.equal(audit.rows[0]?.metadata.reason, 'طلب المستخدم عبر الدعم الفني');

    const missing = await admin.post('/api/v1/admin/users/00000000-0000-4000-8000-000000000000/purge-data', {
      reason: 'مستخدم غير موجود',
    });
    assert.equal(missing.status, 404);
  });
});

describe('حذف الحساب نهائياً (Q22)', () => {
  it('يطلب كلمة المرور والعبارة الحرفية معاً', async () => {
    const h = await withData();
    assert.equal((await h.api.del('/api/v1/me', { password: PASSWORD })).status, 400);
    assert.equal(
      (await h.api.del('/api/v1/me', { password: PASSWORD, confirmation: 'احذف' })).status,
      400,
    );
    assert.equal(
      (await h.api.del('/api/v1/me', { password: 'WrongPass1234', confirmation: DELETE_ACCOUNT_PHRASE })).status,
      403,
    );
    // لم يُحذف شيء.
    assert.equal((await server.sql('select 1 from users where id = $1', [h.userId])).rowCount, 1);
  });

  it('يحذف كل أثر شخصي فوراً ويُبقي تدقيقاً بلا هوية ولا PII', async () => {
    const h = await withData();
    const email = h.email;
    const userId = h.userId;

    const ok = await h.api.del('/api/v1/me', {
      password: PASSWORD,
      confirmation: DELETE_ACCOUNT_PHRASE,
    });
    assert.equal(ok.status, 204, JSON.stringify(ok.body));

    // 1) لا صف مستخدم ولا أي صف تابع.
    const gone = await server.sql<{
      users: number;
      accounts: number;
      sessions: number;
      settings: number;
      deliveries: number;
      identities: number;
      bots: number;
      destinations: number;
    }>(
      `select
         (select count(*)::int from users where id = $1) as users,
         (select count(*)::int from telegram_accounts where user_id = $1) as accounts,
         (select count(*)::int from user_sessions where user_id = $1) as sessions,
         (select count(*)::int from user_settings where user_id = $1) as settings,
         (select count(*)::int from deliveries where user_id = $1) as deliveries,
         (select count(*)::int from message_identity where user_id = $1) as identities,
         (select count(*)::int from publish_bots where user_id = $1) as bots,
         (select count(*)::int from destinations where user_id = $1) as destinations`,
      [userId],
    );
    const row = gone.rows[0]!;
    for (const [key, value] of Object.entries(row)) {
      assert.equal(Number(value), 0, `يجب ألا يبقى أي صف في ${key}`);
    }

    // 2) لا بريد ولا اسم في أي مكان.
    const emailRows = await server.sql('select count(*)::int as total from users where email = $1', [email]);
    assert.equal(Number((emailRows.rows[0] as { total: number }).total), 0);

    // 3) الجلسة أُبطلت والدخول مرفوض.
    assert.equal((await h.api.get('/api/v1/me')).status, 401);
    assert.equal(
      (await client(server.baseUrl).post('/api/v1/auth/login', { email, password: PASSWORD })).status,
      401,
    );

    // 4) التدقيق باقٍ لكن بلا هوية.
    const audit = await server.sql<{ actor_user_id: string | null; target_id: string | null; metadata: unknown }>(
      "select actor_user_id, target_id, metadata from audit_events where action = 'user.account_hard_deleted' order by id desc limit 1",
    );
    assert.equal(audit.rows.length, 1, 'الحذف يُدقَّق');
    assert.equal(audit.rows[0]?.actor_user_id, null);
    assert.equal(audit.rows[0]?.target_id, null);
    const metadataRaw = JSON.stringify(audit.rows[0]?.metadata ?? {});
    assert.ok(!metadataRaw.includes(email));
    assert.ok(!metadataRaw.includes('مستخدم نشر'));
    assert.ok(!metadataRaw.includes('777123456'));
    assert.ok(!metadataRaw.includes(userId));
  });

  it('لا يمكن حذف الحساب مرتين ولا استخدام الجلسة المبطلة', async () => {
    const h = await withData();
    const first = await h.api.del('/api/v1/me', { password: PASSWORD, confirmation: DELETE_ACCOUNT_PHRASE });
    assert.equal(first.status, 204);
    const second = await h.api.del('/api/v1/me', { password: PASSWORD, confirmation: DELETE_ACCOUNT_PHRASE });
    assert.equal(second.status, 401, 'الجلسة أُبطلت فلا طلب ثانٍ');
  });
});
