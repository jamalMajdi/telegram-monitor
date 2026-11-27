/**
 * اختبارات تكامل إدارة مصادر تيليجرام (الخطوة الثالثة — المرحلة الثانية).
 * قاعدة PostgreSQL حقيقية + بوابة تيليجرام محاكاة: لا اتصال حقيقي ولا قراءة محتوى.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway, fakeSource, fakeTelegramError } from './telegram-fakes.js';

const PASSWORD = 'CorrectHorse123';
const PHONE = '+967770001122';
const CODE = '12345';

let server: TestServer;
let gateway: FakeGateway;
let counter = 0;

before(async () => {
  gateway = new FakeGateway();
  gateway.outcomeSelf = { id: '777', username: 'reader_user' };
  server = await startTestServer({ telegramGateway: gateway, logLevel: 'silent' });
});

after(async () => {
  await server.close();
});

async function newUser(): Promise<TestClient> {
  const api = client(server.baseUrl);
  counter += 1;
  const res = await api.post('/api/v1/auth/register', {
    email: `src${counter}@example.test`,
    displayName: `مستخدم مصادر ${counter}`,
    password: PASSWORD,
  });
  assert.equal(res.status, 201);
  return api;
}

/**
 * ينشئ حساب تيليجرام مرتبطاً ومتصلاً عبر مسار الربط الحقيقي (مع محاكاة المكتبة).
 * كل حساب يتطلب هوية تيليجرام مختلفة، لأن القيد (user_id, telegram_user_id) يمنع تكرار الهوية.
 */
async function linkedAccount(api: TestClient, phone = PHONE, telegramUserId = '777'): Promise<string> {
  gateway.outcomeSelf = { id: telegramUserId, username: `reader_${telegramUserId}` };
  gateway.loginBehaviours.push({ submitCode: () => ({ status: 'authorized', self: { id: telegramUserId } }) });
  const started = await api.post('/api/v1/telegram/accounts', { phoneNumber: phone });
  assert.equal(started.status, 201);
  const accountId = (started.body as { account: { id: string } }).account.id;
  const verified = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: CODE });
  assert.equal(verified.status, 200);
  return accountId;
}

function addSource(api: TestClient, accountId: string, identifier: string) {
  return api.post('/api/v1/telegram/sources', { accountId, identifier });
}

describe('إدارة مصادر تيليجرام', () => {
  it('يعرض القنوات المتاحة للحساب ويميّز المُضاف منها', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api);
    gateway.sourceConfig.available = [
      { peerType: 'channel', peerId: '1001', title: 'قناة الوظائف', username: 'jobs_channel' },
      { peerType: 'group', peerId: '2002', title: 'مجموعة الفرص', username: null },
    ];
    gateway.sourceConfig.resolved.set('jobs_channel', fakeSource({ peerId: '1001', title: 'قناة الوظائف', username: 'jobs_channel' }));

    const available = await api.get(`/api/v1/telegram/accounts/${accountId}/sources/available`);
    assert.equal(available.status, 200);
    const list = (available.body as { sources: { peerId: string; alreadyMonitored: boolean }[] }).sources;
    assert.equal(list.length, 2);
    assert.equal(list.every((s) => s.alreadyMonitored === false), true);

    const added = await addSource(api, accountId, 'jobs_channel');
    assert.equal(added.status, 201);

    const again = await api.get(`/api/v1/telegram/accounts/${accountId}/sources/available`);
    const marked = (again.body as { sources: { peerId: string; alreadyMonitored: boolean }[] }).sources;
    assert.equal(marked.find((s) => s.peerId === '1001')?.alreadyMonitored, true);
    assert.equal(marked.find((s) => s.peerId === '2002')?.alreadyMonitored, false);
  });

  it('يضيف مصدراً بالاسم ويسجّل الفترة والتدقيق', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770002233');
    gateway.sourceConfig.resolved.set('opps_group', fakeSource({ peerType: 'group', peerId: '3003', title: 'فرص عمل', username: 'opps_group' }));

    const res = await addSource(api, accountId, '@opps_group');
    assert.equal(res.status, 201);
    const source = (res.body as { source: Record<string, unknown> }).source;
    assert.equal(source.peerType, 'group');
    assert.equal(source.peerId, '3003');
    assert.equal(source.title, 'فرص عمل');
    assert.equal(source.status, 'active');
    assert.equal(source.includeOwnMessages, false);
    assert.equal(source.accountId, accountId);
    assert.ok(source.monitoringStartedAt, 'يجب تسجيل بداية المراقبة');
    // لا حقول حساسة في الاستجابة.
    assert.equal(JSON.stringify(res.body).includes('session'), false);

    const periods = await server.sql(
      'select ended_at from telegram_source_periods where source_id = $1',
      [source.id],
    );
    assert.equal(periods.rowCount, 1);
    assert.equal(periods.rows[0]?.ended_at, null, 'فترة مفتوحة عند الإضافة');

    const audit = await server.sql(
      "select count(*)::int as c from audit_events where action = 'telegram.source_added' and target_id = $1",
      [source.id],
    );
    assert.equal(audit.rows[0]?.c, 1);
  });

  it('يرفض تكرار المصدر نفسه ولو أُضيف من حساب آخر للمستخدم نفسه', async () => {
    const api = await newUser();
    const first = await linkedAccount(api, '+967770003344');
    gateway.sourceConfig.resolved.set('dup_channel', fakeSource({ peerId: '4004', title: 'مكرر', username: 'dup_channel' }));
    gateway.sourceConfig.resolved.set('4004', fakeSource({ peerId: '4004', title: 'مكرر', username: 'dup_channel' }));

    assert.equal((await addSource(api, first, 'dup_channel')).status, 201);
    const duplicate = await addSource(api, first, '4004');
    assert.equal(duplicate.status, 409);
    assert.equal((duplicate.body as { error: { code: string } }).error.code, 'source_already_monitored');

    // حساب ثانٍ للمستخدم نفسه: نفس الهوية ← مصدر واحد فقط داخل المساحة (O01).
    const second = await linkedAccount(api, '+967770003355', '888');
    const secondAdd = await api.post('/api/v1/telegram/sources', { accountId: second, peerId: '4004' });
    assert.equal(secondAdd.status, 409);
    assert.equal((secondAdd.body as { error: { code: string } }).error.code, 'source_already_monitored');

    const rows = await server.sql('select count(*)::int as c from telegram_sources where peer_id = 4004');
    assert.equal(rows.rows[0]?.c, 1);
  });

  it('يرفض المصادر غير المتاحة: غير عضو أو نوع غير مدعوم أو معرّف مجهول', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770004466');

    gateway.sourceConfig.resolved.set('private_one', fakeSource({ peerId: '5005', title: 'خاصة', accessible: false, reason: 'not_member' }));
    const notMember = await addSource(api, accountId, 'private_one');
    assert.equal(notMember.status, 409);
    assert.equal((notMember.body as { error: { code: string } }).error.code, 'source_not_accessible');

    gateway.sourceConfig.resolved.set('basic_chat', fakeSource({ peerId: '6006', title: 'قديمة', accessible: false, reason: 'unsupported_peer_type' }));
    const unsupported = await addSource(api, accountId, 'basic_chat');
    assert.equal(unsupported.status, 400);
    assert.equal((unsupported.body as { error: { code: string } }).error.code, 'unsupported_source_type');

    const missing = await addSource(api, accountId, 'does_not_exist');
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { error: { code: string } }).error.code, 'not_found');
  });

  it('يرفض العمل عند تعذّر الاتصال أو أثناء انتظار تيليجرام', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770005577');

    gateway.sourceConfig.resolveError = fakeTelegramError('FLOOD_WAIT_30', 420);
    const flooded = await addSource(api, accountId, 'any_channel');
    assert.equal(flooded.status, 429);
    gateway.sourceConfig.resolveError = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const offline = await addSource(api, accountId, 'any_channel');
    assert.equal(offline.status, 503);
    assert.equal((offline.body as { error: { code: string } }).error.code, 'telegram_unreachable');
    gateway.sourceConfig.resolveError = undefined;

    // الحساب غير متصل: فشل كل محاولات التوصيل ← رفض واضح بلا إضافة.
    await api.post(`/api/v1/telegram/accounts/${accountId}/disconnect`);
    gateway.queueFailure(Object.assign(new Error('ENETUNREACH'), { code: 'ENETUNREACH' }));
    gateway.queueFailure(Object.assign(new Error('ENETUNREACH'), { code: 'ENETUNREACH' }));
    gateway.queueFailure(Object.assign(new Error('ENETUNREACH'), { code: 'ENETUNREACH' }));
    const notConnected = await addSource(api, accountId, 'any_channel');
    assert.equal(notConnected.status, 409);
    assert.equal((notConnected.body as { error: { code: string } }).error.code, 'account_not_connected');

    const rows = await server.sql('select count(*)::int as c from telegram_sources where account_id = $1', [accountId]);
    assert.equal(rows.rows[0]?.c, 0, 'لا يُضاف أي مصدر عند فشل الاتصال');
  });

  it('يوقف ويستأنف المراقبة مع تسجيل الفترات', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770006688');
    gateway.sourceConfig.resolved.set('cycle_channel', fakeSource({ peerId: '7007', title: 'دورية', username: 'cycle_channel' }));
    const created = await addSource(api, accountId, 'cycle_channel');
    const sourceId = (created.body as { source: { id: string } }).source.id;

    const paused = await api.post(`/api/v1/telegram/sources/${sourceId}/pause`);
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal((paused.body as { source: { status: string } }).source.status, 'paused');

    const openAfterPause = await server.sql(
      'select count(*)::int as c from telegram_source_periods where source_id = $1 and ended_at is null',
      [sourceId],
    );
    assert.equal(openAfterPause.rows[0]?.c, 0);

    const resumed = await api.post(`/api/v1/telegram/sources/${sourceId}/resume`);
    assert.equal(resumed.status, 200);
    assert.equal((resumed.body as { source: { status: string } }).source.status, 'active');

    const periods = await server.sql(
      'select count(*)::int as c, count(*) filter (where ended_at is null)::int as open from telegram_source_periods where source_id = $1',
      [sourceId],
    );
    assert.equal(periods.rows[0]?.c, 2);
    assert.equal(periods.rows[0]?.open, 1);

    const again = await api.post(`/api/v1/telegram/sources/${sourceId}/resume`);
    assert.equal(again.status, 200);
    const stillTwo = await server.sql(
      'select count(*)::int as c from telegram_source_periods where source_id = $1',
      [sourceId],
    );
    assert.equal(stillTwo.rows[0]?.c, 2, 'لا تُفتح فترة جديدة عند الاستئناف المتكرر بلا تغيير');
  });

  it('يحدّث إعداد رسائل المستخدم ويحذف المصدر ويسمح بإعادة إضافته', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770007799');
    gateway.sourceConfig.resolved.set('settings_channel', fakeSource({ peerId: '8008', title: 'إعدادات', username: 'settings_channel' }));
    const created = await addSource(api, accountId, 'settings_channel');
    const sourceId = (created.body as { source: { id: string } }).source.id;

    const patched = await api.patch(`/api/v1/telegram/sources/${sourceId}`, { includeOwnMessages: true });
    assert.equal(patched.status, 200);
    assert.equal((patched.body as { source: { includeOwnMessages: boolean } }).source.includeOwnMessages, true);

    assert.equal((await api.del(`/api/v1/telegram/sources/${sourceId}`)).status, 204);
    const gone = await api.get(`/api/v1/telegram/sources/${sourceId}`);
    assert.equal(gone.status, 404);

    gateway.sourceConfig.resolved.set('8008', fakeSource({ peerId: '8008', title: 'إعدادات', username: 'settings_channel' }));
    const readd = await api.post('/api/v1/telegram/sources', { accountId, peerId: '8008' });
    assert.equal(readd.status, 201, 'يمكن إعادة إضافة المصدر بعد حذفه');
  });

  it('يعزل المصادر بين المستخدمين في كل عملية', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const accountId = await linkedAccount(owner, '+967770008811');
    gateway.sourceConfig.resolved.set('iso_channel', fakeSource({ peerId: '9009', title: 'معزولة', username: 'iso_channel' }));
    const created = await addSource(owner, accountId, 'iso_channel');
    const sourceId = (created.body as { source: { id: string } }).source.id;

    assert.equal((await stranger.get('/api/v1/telegram/sources')).status, 200);
    const strangerList = await stranger.get('/api/v1/telegram/sources');
    assert.equal((strangerList.body as { sources: unknown[] }).sources.length, 0);

    assert.equal((await stranger.get(`/api/v1/telegram/sources/${sourceId}`)).status, 404);
    assert.equal((await stranger.patch(`/api/v1/telegram/sources/${sourceId}`, { includeOwnMessages: true })).status, 404);
    assert.equal((await stranger.post(`/api/v1/telegram/sources/${sourceId}/pause`)).status, 404);
    assert.equal((await stranger.post(`/api/v1/telegram/sources/${sourceId}/resume`)).status, 404);
    assert.equal((await stranger.post(`/api/v1/telegram/sources/${sourceId}/refresh`)).status, 404);
    assert.equal((await stranger.del(`/api/v1/telegram/sources/${sourceId}`)).status, 404);
    // إضافة مصدر إلى حساب لا يملكه الغريب.
    const foreignAdd = await addSource(stranger, accountId, 'iso_channel');
    assert.equal(foreignAdd.status, 404);
    // قائمة المتاح لحساب غريب.
    assert.equal((await stranger.get(`/api/v1/telegram/accounts/${accountId}/sources/available`)).status, 404);

    // لم يتغيّر شيء عند المالك.
    const stillThere = await owner.get(`/api/v1/telegram/sources/${sourceId}`);
    assert.equal(stillThere.status, 200);
    assert.equal((stillThere.body as { source: { includeOwnMessages: boolean } }).source.includeOwnMessages, false);
  });

  it('يوقف مصادر الحساب عند فصله ويبقيها ظاهرة', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770009922');
    gateway.sourceConfig.resolved.set('unlink_channel', fakeSource({ peerId: '1101', title: 'فصل', username: 'unlink_channel' }));
    const created = await addSource(api, accountId, 'unlink_channel');
    const sourceId = (created.body as { source: { id: string } }).source.id;

    assert.equal((await api.del(`/api/v1/telegram/accounts/${accountId}`)).status, 204);

    const after = await api.get(`/api/v1/telegram/sources/${sourceId}`);
    assert.equal(after.status, 200);
    assert.equal((after.body as { source: { status: string } }).source.status, 'paused');

    const periods = await server.sql(
      'select count(*) filter (where ended_at is null)::int as open from telegram_source_periods where source_id = $1',
      [sourceId],
    );
    assert.equal(periods.rows[0]?.open, 0, 'تُغلق الفترة عند الفصل');
  });

  it('يحدّث البيانات الوصفية عند التحقق ويوقف المصدر عند فقدان الوصول', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770010033');
    gateway.sourceConfig.resolved.set('verify_channel', fakeSource({ peerId: '1202', title: 'قديم', username: 'verify_channel' }));
    const created = await addSource(api, accountId, 'verify_channel');
    const sourceId = (created.body as { source: { id: string } }).source.id;

    gateway.sourceConfig.resolved.set('1202', fakeSource({ peerId: '1202', title: 'اسم محدّث', username: 'verify_channel' }));
    const refreshed = await api.post(`/api/v1/telegram/sources/${sourceId}/refresh`);
    assert.equal(refreshed.status, 200);
    const body = refreshed.body as { source: { title: string; status: string; lastVerifiedAt: string | null } };
    assert.equal(body.source.title, 'اسم محدّث');
    assert.equal(body.source.status, 'active');
    assert.ok(body.source.lastVerifiedAt);

    gateway.sourceConfig.resolved.set('1202', fakeSource({ peerId: '1202', title: 'اسم محدّث', accessible: false, reason: 'kicked' }));
    const lost = await api.post(`/api/v1/telegram/sources/${sourceId}/refresh`);
    assert.equal(lost.status, 200);
    const lostBody = lost.body as { source: { status: string; lastErrorCode: string | null } };
    assert.equal(lostBody.source.status, 'paused');
    assert.equal(lostBody.source.lastErrorCode, 'SOURCE_KICKED');
  });

  it('يفرض الحد الأقصى لعدد المصادر لكل حساب', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770012055');
    const limit = 25; // TG_MAX_SOURCES_PER_ACCOUNT الافتراضي (D11/O08).
    for (let i = 0; i < limit; i += 1) {
      const peerId = String(20000 + i);
      gateway.sourceConfig.resolved.set(peerId, fakeSource({ peerId, title: `مصدر ${i}`, username: `src_${i}` }));
      const res = await api.post('/api/v1/telegram/sources', { accountId, peerId });
      assert.equal(res.status, 201, `المصدر رقم ${i + 1} يجب أن يُقبل`);
    }
    gateway.sourceConfig.resolved.set('29999', fakeSource({ peerId: '29999', title: 'زائد', username: 'extra' }));
    const over = await api.post('/api/v1/telegram/sources', { accountId, peerId: '29999' });
    assert.equal(over.status, 409);
    assert.equal((over.body as { error: { code: string } }).error.code, 'source_limit_reached');

    const rows = await server.sql('select count(*)::int as c from telegram_sources where account_id = $1', [accountId]);
    assert.equal(rows.rows[0]?.c, limit);
  });

  it('يحدّ معدل عمليات المصادر لكل مستخدم', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770013066');
    gateway.sourceConfig.resolved.set('31001', fakeSource({ peerId: '31001', title: 'معدل', username: 'limit_channel' }));
    const created = await api.post('/api/v1/telegram/sources', { accountId, peerId: '31001' });
    assert.equal(created.status, 201);
    const sourceId = (created.body as { source: { id: string } }).source.id;

    let limited = 0;
    const seen: number[] = [];
    for (let i = 0; i < 40 && limited === 0; i += 1) {
      const res = await api.post(`/api/v1/telegram/sources/${sourceId}/refresh`);
      seen.push(res.status);
      if (res.status === 429) {
        limited = 1;
        assert.equal((res.body as { error: { code: string } }).error.code, 'rate_limited');
      }
    }
    assert.equal(limited, 1, `يجب أن تُطبَّق حدود المعدل على عمليات المصادر (${Array.from(new Set(seen)).join(',')})`);
  });

  it('يحفظ معرّفات أكبر من حدود JavaScript Number بلا فقدان دقة', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770014077');
    // 2^53 + 1: أول عدد صحيح لا يمكن تمثيله بدقة في JavaScript Number.
    const bigPeerId = '9007199254740993';
    gateway.sourceConfig.resolved.set(bigPeerId, fakeSource({ peerId: bigPeerId, title: 'هوية كبيرة', username: null }));

    const created = await api.post('/api/v1/telegram/sources', { accountId, peerId: bigPeerId });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const source = (created.body as { source: { id: string; peerId: string } }).source;
    assert.equal(typeof source.peerId, 'string');
    assert.equal(source.peerId, bigPeerId);

    const fetched = await api.get(`/api/v1/telegram/sources/${source.id}`);
    assert.equal((fetched.body as { source: { peerId: string } }).source.peerId, bigPeerId);

    const raw = await server.sql('select peer_id::text as peer_id from telegram_sources where id = $1', [source.id]);
    assert.equal(raw.rows[0]?.peer_id, bigPeerId, 'التخزين يجب أن يطابق المعرّف الأصلي تماماً');

    const list = await api.get('/api/v1/telegram/sources');
    assert.equal((list.body as { sources: { peerId: string }[] }).sources[0]?.peerId, bigPeerId);

    // نفس المعرّف من حساب آخر للمستخدم نفسه يُعتبر تكراراً بالهوية الرقمية نفسها.
    const second = await linkedAccount(api, '+967770014088', '889');
    gateway.sourceConfig.resolved.set(bigPeerId, fakeSource({ peerId: bigPeerId, title: 'هوية كبيرة', username: null }));
    const dup = await api.post('/api/v1/telegram/sources', { accountId: second, peerId: bigPeerId });
    assert.equal(dup.status, 409);
  });

  it('يرفض معرّفات رقمية خارج نطاق BIGINT أو سالبة برسالة 400 لا 500', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770015099');

    const overflow = await api.post('/api/v1/telegram/sources', { accountId, peerId: '99999999999999999999' });
    assert.equal(overflow.status, 400, JSON.stringify(overflow.body));
    assert.equal((overflow.body as { error: { code: string } }).error.code, 'validation_error');

    const negativeByPeerId = await api.post('/api/v1/telegram/sources', { accountId, peerId: '-100123456' });
    assert.equal(negativeByPeerId.status, 400);

    // المعرّف السالب عبر identifier يُرفض كنوع غير مدعوم بلا لمس قاعدة البيانات.
    const negativeByIdentifier = await api.post('/api/v1/telegram/sources', { accountId, identifier: '-100123456' });
    assert.equal(negativeByIdentifier.status, 400);
    assert.equal((negativeByIdentifier.body as { error: { code: string } }).error.code, 'unsupported_source_type');

    const rows = await server.sql('select count(*)::int as c from telegram_sources where account_id = $1', [accountId]);
    assert.equal(rows.rows[0]?.c, 0);
  });

  it('يحافظ على فترة مفتوحة واحدة عند العمليات المتزامنة', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770016100');
    const peerId = '41001';
    gateway.sourceConfig.resolved.set(peerId, fakeSource({ peerId, title: 'تزامن', username: 'concurrent_channel' }));
    const created = await api.post('/api/v1/telegram/sources', { accountId, peerId });
    assert.equal(created.status, 201);
    const sourceId = (created.body as { source: { id: string } }).source.id;

    // إيقاف متزامن مرتين: يجب ألا تُغلق الفترة مرتين ولا تُفتح فترة إضافية.
    const paused = await Promise.all([
      api.post(`/api/v1/telegram/sources/${sourceId}/pause`),
      api.post(`/api/v1/telegram/sources/${sourceId}/pause`),
    ]);
    assert.equal(paused.every((res) => res.status === 200), true);
    const afterPause = await server.sql(
      'select count(*)::int as c, count(*) filter (where ended_at is null)::int as open from telegram_source_periods where source_id = $1',
      [sourceId],
    );
    assert.equal(afterPause.rows[0]?.c, 1, 'الإيقاف المتزامن لا يُنشئ فترات إضافية');
    assert.equal(afterPause.rows[0]?.open, 0);

    // استئناف متزامن: فترة مفتوحة واحدة فقط.
    const resumed = await Promise.all([
      api.post(`/api/v1/telegram/sources/${sourceId}/resume`),
      api.post(`/api/v1/telegram/sources/${sourceId}/resume`),
    ]);
    assert.equal(resumed.every((res) => res.status === 200), true);
    const afterResume = await server.sql(
      'select count(*)::int as c, count(*) filter (where ended_at is null)::int as open from telegram_source_periods where source_id = $1',
      [sourceId],
    );
    assert.equal(afterResume.rows[0]?.c, 2);
    assert.equal(afterResume.rows[0]?.open, 1);

    // لا يوجد أي مصدر في القاعدة بفترتين مفتوحتين (فحص عام للنظام كله).
    const invariant = await server.sql(
      `select count(*)::int as c from (
         select source_id from telegram_source_periods where ended_at is null group by source_id having count(*) > 1
       ) t`,
    );
    assert.equal(invariant.rows[0]?.c, 0);
  });

  it('يمنع إضافة مكررة متزامنة (القيد الفريد هو الحكم)', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770017111');
    const peerId = '41002';
    gateway.sourceConfig.resolved.set(peerId, fakeSource({ peerId, title: 'مكرر متزامن', username: 'race_channel' }));

    const results = await Promise.all([
      api.post('/api/v1/telegram/sources', { accountId, peerId }),
      api.post('/api/v1/telegram/sources', { accountId, peerId }),
    ]);
    const statuses = results.map((res) => res.status).sort();
    assert.deepEqual(statuses, [201, 409]);
    const rows = await server.sql('select count(*)::int as c from telegram_sources where account_id = $1', [accountId]);
    assert.equal(rows.rows[0]?.c, 1);
    const periods = await server.sql(
      'select count(*)::int as c from telegram_source_periods p join telegram_sources s on s.id = p.source_id where s.account_id = $1',
      [accountId],
    );
    assert.equal(periods.rows[0]?.c, 1, 'لا فترة يتيمة من المحاولة المرفوضة');
  });

  it('تمنع قاعدة البيانات ربط مصدر بحساب يملكه مستخدم آخر', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const accountId = await linkedAccount(owner, '+967770018122');
    const strangerId = (
      await server.sql<{ id: string }>('select id from users order by created_at desc limit 1')
    ).rows[0]!.id;

    // 1) إدراج مباشر بمالك مختلف عن مالك الحساب: يجب أن ترفضه قاعدة البيانات (23503).
    await assert.rejects(
      () =>
        server.sql(
          "insert into telegram_sources (user_id, account_id, peer_type, peer_id, title) values ($1,$2,'channel',777001,'متقاطع')",
          [strangerId, accountId],
        ),
      (err: unknown) => (err as { code?: string }).code === '23503',
      'المفتاح الأجنبي المركّب يجب أن يرفض المصدر المتقاطع الملكية',
    );

    // 2) لا يمكن نقل مصدر قائم إلى مستخدم آخر مع إبقاء حساب المالك الأصلي.
    gateway.sourceConfig.resolved.set('owner_channel', fakeSource({ peerId: '777002', title: 'ملكية', username: 'owner_channel' }));
    const created = await addSource(owner, accountId, 'owner_channel');
    assert.equal(created.status, 201);
    const sourceId = (created.body as { source: { id: string } }).source.id;
    await assert.rejects(
      () => server.sql('update telegram_sources set user_id = $2 where id = $1', [sourceId, strangerId]),
      (err: unknown) => (err as { code?: string }).code === '23503',
    );

    // 3) المسار المشروع (نفس المالك) يعمل كما هو، والمستخدم الآخر لا يرى شيئاً.
    const owned = await server.sql('select user_id from telegram_sources where id = $1', [sourceId]);
    assert.equal(owned.rows[0]?.user_id, (await server.sql('select user_id from telegram_accounts where id = $1', [accountId])).rows[0]?.user_id);
    const strangerList = await stranger.get('/api/v1/telegram/sources');
    assert.equal((strangerList.body as { sources: unknown[] }).sources.length, 0);
    assert.equal((await stranger.get(`/api/v1/telegram/sources/${sourceId}`)).status, 404);
  });

  it('يُفصل الحساب ذرّياً: فشل إيقاف مصدر لا يترك أي تغيير جزئي', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770019133');
    const peerA = '777101';
    const peerB = '777102';
    gateway.sourceConfig.resolved.set(peerA, fakeSource({ peerId: peerA, title: 'عادية', username: null }));
    gateway.sourceConfig.resolved.set(peerB, fakeSource({ peerId: peerB, title: 'BLOCK_PAUSE', username: null }));
    assert.equal((await api.post('/api/v1/telegram/sources', { accountId, peerId: peerA })).status, 201);
    assert.equal((await api.post('/api/v1/telegram/sources', { accountId, peerId: peerB })).status, 201);

    const snapshot = async () => {
      const account = await server.sql<{ status: string }>('select status from telegram_accounts where id = $1', [accountId]);
      const sources = await server.sql<{ status: string; c: number }>(
        "select status, count(*)::int as c from telegram_sources where account_id = $1 group by status",
        [accountId],
      );
      const open = await server.sql<{ c: number }>(
        `select count(*)::int as c from telegram_source_periods p
           join telegram_sources s on s.id = p.source_id
          where s.account_id = $1 and p.ended_at is null`,
        [accountId],
      );
      const sessions = await server.sql<{ c: number }>(
        'select count(*)::int as c from telegram_sessions where account_id = $1',
        [accountId],
      );
      return {
        status: account.rows[0]?.status,
        active: sources.rows.find((r) => r.status === 'active')?.c ?? 0,
        paused: sources.rows.find((r) => r.status === 'paused')?.c ?? 0,
        openPeriods: open.rows[0]?.c,
        sessions: sessions.rows[0]?.c,
      };
    };

    const before = await snapshot();
    assert.deepEqual(before, { status: 'active', active: 2, paused: 0, openPeriods: 2, sessions: 1 });

    // محاكاة فشل إيقاف أحد المصادر داخل معاملة الفصل.
    await server.sql(`
      create or replace function tg_test_block_pause() returns trigger language plpgsql as $fn$
      begin
        if new.status = 'paused' and old.status = 'active' and new.title = 'BLOCK_PAUSE' then
          raise exception 'simulated pause failure';
        end if;
        return new;
      end $fn$;
    `);
    await server.sql(
      'create trigger tg_test_block_pause_trg before update on telegram_sources for each row execute function tg_test_block_pause()',
    );
    try {
      // تحقق أن سبب الفشل هو المحاكاة نفسها (وإلا فالاختبار لا يُثبت الذرّية).
      await assert.rejects(
        () => server.sql("update telegram_sources set status = 'paused' where account_id = $1 and title = 'BLOCK_PAUSE'", [accountId]),
        (err: unknown) => String((err as { message?: string }).message ?? '').includes('simulated pause failure'),
      );
      const failed = await api.del(`/api/v1/telegram/accounts/${accountId}`);
      assert.equal(failed.status, 500, JSON.stringify(failed.body));
      assert.deepEqual(await snapshot(), before, 'لا تغيير جزئي بعد فشل الفصل');
    } finally {
      await server.sql('drop trigger if exists tg_test_block_pause_trg on telegram_sources');
      await server.sql('drop function if exists tg_test_block_pause()');
    }

    // بعد إزالة سبب الفشل: الفصل ينجح كاملاً ويُبقي السجل بحالة revoked والمصادر paused.
    assert.equal((await api.del(`/api/v1/telegram/accounts/${accountId}`)).status, 204);
    assert.deepEqual(await snapshot(), { status: 'revoked', active: 0, paused: 2, openPeriods: 0, sessions: 0 });

    const periods = await server.sql<{ c: number }>(
      `select count(*)::int as c from telegram_source_periods p join telegram_sources s on s.id = p.source_id where s.account_id = $1`,
      [accountId],
    );
    assert.equal(periods.rows[0]?.c, 2, 'كل فترة أُغلقت ولم تُحذف');
    const audit = await server.sql<{ c: number }>(
      "select count(*)::int as c from audit_events where action = 'telegram.account_unlinked' and target_id = $1",
      [accountId],
    );
    assert.equal(audit.rows[0]?.c, 1, 'حدث تدقيق واحد فقط للفصل الناجح');
  });

  it('يرفض الطلبات غير المصادق عليها ويقبل معرّفات صالحة فقط', async () => {
    const anonymous = client(server.baseUrl);
    assert.equal((await anonymous.get('/api/v1/telegram/sources')).status, 401);
    assert.equal((await anonymous.post('/api/v1/telegram/sources', { accountId: 'x', identifier: 'y' })).status, 401);

    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770011044');
    const both = await api.post('/api/v1/telegram/sources', { accountId, identifier: 'a_channel', peerId: '123' });
    assert.equal(both.status, 400);
    const badPeer = await api.post('/api/v1/telegram/sources', { accountId, peerId: 'abc' });
    assert.equal(badPeer.status, 400);
    const badId = await api.get('/api/v1/telegram/sources/not-a-uuid');
    assert.equal(badId.status, 400);
  });
});
