/**
 * اختبارات تكامل نظام ربط حسابات تيليجرام (الخطوة الثانية — المرحلة الثانية).
 * تعمل على قاعدة PostgreSQL حقيقية مع بوابة تيليجرام **محاكاة**:
 * لا اتصال حقيقي بـ Telegram ولا رمز ولا كلمة مرور حقيقية.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway, fakeTelegramError, type FakeLoginBehaviour } from './telegram-fakes.js';

const PASSWORD = 'CorrectHorse123';
const PHONE = '+967771234567';
const CODE = '12345';

let server: TestServer;
let gateway: FakeGateway;
let counter = 0;
/** معرّف آخر مستخدم أُنشئ (للاستعلامات المقيّدة بالمالك في الاختبارات). */
let lastUserId = '';

before(async () => {
  gateway = new FakeGateway();
  gateway.outcomeSelf = { id: '777', username: 'fake_login_user' };
  server = await startTestServer({ telegramGateway: gateway });
});

after(async () => {
  await server.close();
});

/** مستخدم جديد لكل اختبار حتى لا تتداخل حدود المعدل بين الاختبارات. */
async function newUser(): Promise<TestClient> {
  const api = client(server.baseUrl);
  counter += 1;
  const res = await api.post('/api/v1/auth/register', {
    email: `tg${counter}@example.test`,
    displayName: `مستخدم ${counter}`,
    password: PASSWORD,
  });
  assert.equal(res.status, 201, 'فشل إنشاء مستخدم اختبار');
  lastUserId = (res.body as { user: { id: string } }).user.id;
  return api;
}

function behaviour(overrides: FakeLoginBehaviour = {}): void {
  gateway.loginBehaviours.push(overrides);
}

async function startLink(api: TestClient, phone = PHONE) {
  return api.post('/api/v1/telegram/accounts', { phoneNumber: phone });
}

async function linkedAccount(api: TestClient, phone = PHONE): Promise<string> {
  behaviour();
  const started = await startLink(api, phone);
  assert.equal(started.status, 201);
  const accountId = (started.body as { account: { id: string } }).account.id;
  const verified = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: CODE });
  assert.equal(verified.status, 200);
  return accountId;
}

function containsSecret(value: unknown, needle: string): boolean {
  return JSON.stringify(value).includes(needle);
}

describe('ربط الحساب عبر MTProto (محاكاة)', () => {
  it('يبدأ الربط وينشئ سجلاً معلّقاً دون كشف أي سر', async () => {
    const api = await newUser();
    behaviour();
    const res = await startLink(api);
    assert.equal(res.status, 201);
    const body = res.body as {
      account: { id: string; status: string; phoneLastDigits: string };
      challenge: { stage: string; viaApp: boolean; expiresAt: string; codeAttemptsRemaining: number };
    };
    assert.equal(body.account.status, 'pending_login');
    assert.equal(body.account.phoneLastDigits, '67');
    assert.equal(body.challenge.stage, 'code');
    assert.equal(body.challenge.viaApp, true);
    assert.equal(body.challenge.codeAttemptsRemaining, 5);
    // المهلة الافتراضية 10 دقائق (TG_LOGIN_TTL_MINUTES).
    const ttlMinutes = (Date.parse(body.challenge.expiresAt) - Date.now()) / 60_000;
    assert.ok(ttlMinutes > 9 && ttlMinutes <= 10.5, `مهلة غير متوقعة: ${ttlMinutes.toFixed(1)} دقيقة`);

    // لا رقم كامل، لا بصمة رمز، لا جلسة في الاستجابة.
    assert.equal(containsSecret(res.body, PHONE), false);
    assert.equal(containsSecret(res.body, 'hash-'), false);
    assert.equal(containsSecret(res.body, 'fake-login-session'), false);

    // البصمة محفوظة في القاعدة، والرقم الكامل غير محفوظ.
    const row = await server.sql(
      'select phone_hash, phone_last_digits from telegram_accounts where id = $1',
      [body.account.id],
    );
    assert.match(String(row.rows[0]?.phone_hash), /^[0-9a-f]{64}$/);
    assert.equal(row.rows[0]?.phone_last_digits, '67');
    const dump = await server.sql('select * from telegram_accounts where id = $1', [body.account.id]);
    assert.equal(JSON.stringify(dump.rows[0]).includes(PHONE), false);
  });

  it('يكمل المصادقة بالرمز ويحفظ الجلسة مشفّرة ويصل الحساب', async () => {
    const api = await newUser();
    behaviour();
    const started = await startLink(api);
    const accountId = (started.body as { account: { id: string } }).account.id;

    const verified = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: CODE });
    assert.equal(verified.status, 200);
    const body = verified.body as { status: string; account: { status: string; telegramUsername: string } };
    assert.equal(body.status, 'linked');
    assert.equal(body.account.status, 'active');
    assert.equal(body.account.telegramUsername, 'fake_login_user');
    assert.equal(containsSecret(verified.body, 'fake-login-session'), false);

    const session = await server.sql(
      'select ciphertext, key_version, octet_length(ciphertext) as bytes from telegram_sessions where account_id = $1',
      [accountId],
    );
    assert.equal(session.rowCount, 1);
    assert.equal(session.rows[0]?.key_version, 1);
    assert.ok(Number(session.rows[0]?.bytes) > 29);
    const cipher = session.rows[0]?.ciphertext as Buffer;
    assert.equal(cipher.includes(Buffer.from('fake-login-session', 'utf8')), false);

    const challenge = await server.sql(
      'select count(*)::int as active from telegram_login_challenges where account_id = $1 and consumed_at is null',
      [accountId],
    );
    assert.equal(challenge.rows[0]?.active, 0, 'يجب استهلاك محاولة الربط بعد النجاح');

    // الاتصال يبدأ تلقائياً بعد الربط عبر مدير الاتصالات.
    const view = await api.get(`/api/v1/telegram/accounts/${accountId}`);
    assert.equal((view.body as { account: { connection: { phase: string } } }).account.connection.phase, 'connected');
  });

  it('يرفض الرمز الخاطئ ويستهلك المحاولات ثم يقفل المحاولة', async () => {
    const api = await newUser();
    behaviour();
    const started = await startLink(api);
    const accountId = (started.body as { account: { id: string } }).account.id;

    const first = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: '00000' });
    assert.equal(first.status, 400);
    const error = (first.body as { error: { code: string; details?: { attemptsRemaining?: number } } }).error;
    assert.equal(error.code, 'code_invalid');
    assert.equal(error.details?.attemptsRemaining, 4);

    for (let i = 0; i < 4; i += 1) {
      const attempt = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: '00000' });
      assert.equal(attempt.status, 400);
    }
    const locked = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: CODE });
    assert.equal(locked.status, 423);
    assert.equal((locked.body as { error: { code: string } }).error.code, 'code_attempts_exceeded');

    // لا يتحول الحساب إلى نشط بعد استنفاد المحاولات.
    const row = await server.sql('select status from telegram_accounts where id = $1', [accountId]);
    assert.equal(row.rows[0]?.status, 'pending_login');
  });

  it('يدعم كلمة مرور التحقق بخطوتين ويرفض كلمة المرور الخاطئة', async () => {
    const api = await newUser();
    // الهوية الفعلية لهذا الاختبار (كلا العميلين يمثلان الحساب نفسه في الواقع).
    gateway.outcomeSelf = { id: '888', username: 'twofa_user' };
    behaviour({
      submitCode: () => ({ status: 'password_required', hint: 'اسم الحيوان المفضل' }),
      submitPassword: (password) => {
        if (password === 'two-factor-pass') return { self: { id: '888', username: 'twofa_user' } };
        throw fakeTelegramError('PASSWORD_HASH_INVALID');
      },
    });

    const started = await startLink(api);
    const accountId = (started.body as { account: { id: string } }).account.id;

    const first = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: CODE });
    assert.equal(first.status, 200);
    const firstBody = first.body as { status: string; challenge: { stage: string; hint: string | null } };
    assert.equal(firstBody.status, 'password_required');
    assert.equal(firstBody.challenge.stage, 'password');
    assert.equal(firstBody.challenge.hint, 'اسم الحيوان المفضل');

    const wrong = await api.post(`/api/v1/telegram/accounts/${accountId}/password`, { password: 'wrong-pass' });
    assert.equal(wrong.status, 400);
    assert.equal((wrong.body as { error: { code: string } }).error.code, 'password_invalid');

    const correct = await api.post(`/api/v1/telegram/accounts/${accountId}/password`, {
      password: 'two-factor-pass',
    });
    assert.equal(correct.status, 200);
    assert.equal((correct.body as { status: string }).status, 'linked');

    const row = await server.sql('select status, telegram_user_id::text as uid from telegram_accounts where id = $1', [
      accountId,
    ]);
    assert.equal(row.rows[0]?.status, 'active');
    assert.equal(row.rows[0]?.uid, '888');

    gateway.outcomeSelf = { id: '777', username: 'fake_login_user' };

    // كلمة المرور لا تُخزَّن في أي مكان.
    const challenges = await server.sql('select ciphertext from telegram_login_challenges where account_id = $1', [
      accountId,
    ]);
    for (const r of challenges.rows) {
      assert.equal((r.ciphertext as Buffer).includes(Buffer.from('two-factor-pass', 'utf8')), false);
    }
  });

  it('يرفض المحاولة المنتهية الصلاحية ويمنع إعادة استخدامها', async () => {
    const api = await newUser();
    behaviour();
    const started = await startLink(api);
    const accountId = (started.body as { account: { id: string } }).account.id;

    await server.sql(
      `update telegram_login_challenges
          set created_at = now() - interval '20 minutes',
              expires_at = now() - interval '1 minute'
        where account_id = $1`,
      [accountId],
    );

    const res = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: CODE });
    assert.equal(res.status, 410);
    assert.equal((res.body as { error: { code: string } }).error.code, 'challenge_expired');

    const active = await server.sql(
      'select count(*)::int as active from telegram_login_challenges where account_id = $1 and consumed_at is null',
      [accountId],
    );
    assert.equal(active.rows[0]?.active, 0);
  });

  it('يستعيد الجلسة المشفّرة عند إعادة الاتصال ويمنع التسريب', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api);

    const disconnected = await api.post(`/api/v1/telegram/accounts/${accountId}/disconnect`);
    assert.equal(disconnected.status, 200);

    const reconnected = await api.post(`/api/v1/telegram/accounts/${accountId}/connect`);
    assert.equal(reconnected.status, 200);
    const clients = gateway.created.filter((c) => c.accountId === accountId);
    const last = clients[clients.length - 1];
    assert.ok(last, 'يجب إنشاء عميل اتصال جديد من الجلسة المحفوظة');
    assert.equal(
      last?.sessionString,
      `fake-login-session-${accountId}`,
      'يجب أن يُستعاد الاتصال من الجلسة المحفوظة نفسها',
    );
    assert.equal(
      (reconnected.body as { account: { connection: { phase: string } } }).account.connection.phase,
      'connected',
    );
  });

  it('يصلح انقطاع الاتصال بإعادة محاولة محدودة العدد', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api);
    await api.post(`/api/v1/telegram/accounts/${accountId}/disconnect`);

    // محاولة أولى تفشل بانقطاع شبكة، ثم تنجح الثانية.
    gateway.queueFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    gateway.queueOutcome({ authorized: true, self: { id: '777', username: 'fake_login_user' } });

    const res = await api.post(`/api/v1/telegram/accounts/${accountId}/connect`);
    assert.equal(res.status, 200);
    const connection = (res.body as { account: { connection: { phase: string } } }).account.connection;
    assert.equal(connection.phase, 'connected');

    const audit = await server.sql(
      "select count(*)::int as c from audit_events where target_id = $1 and action = 'telegram.reconnect_scheduled'",
      [accountId],
    );
    assert.ok((audit.rows[0]?.c as number) >= 1, 'يجب أن تُسجَّل إعادة المحاولة في التدقيق');
  });

  it('يعزل حسابات المستخدمين ويمنع الوصول المتبادل', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    behaviour();
    const started = await startLink(owner);
    const accountId = (started.body as { account: { id: string } }).account.id;

    const listA = await owner.get('/api/v1/telegram/accounts');
    assert.equal((listA.body as { accounts: unknown[] }).accounts.length, 1);
    const listB = await stranger.get('/api/v1/telegram/accounts');
    assert.equal((listB.body as { accounts: unknown[] }).accounts.length, 0);

    assert.equal((await stranger.get(`/api/v1/telegram/accounts/${accountId}`)).status, 404);
    assert.equal(
      (await stranger.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: CODE })).status,
      404,
    );
    assert.equal(
      (await stranger.post(`/api/v1/telegram/accounts/${accountId}/password`, { password: 'x' })).status,
      404,
    );
    assert.equal((await stranger.post(`/api/v1/telegram/accounts/${accountId}/code`)).status, 404);
    assert.equal((await stranger.post(`/api/v1/telegram/accounts/${accountId}/cancel`)).status, 404);
    assert.equal(
      (await stranger.post(`/api/v1/telegram/accounts/${accountId}/reauth`, { phoneNumber: PHONE })).status,
      404,
    );
    assert.equal((await stranger.post(`/api/v1/telegram/accounts/${accountId}/connect`)).status, 404);
    assert.equal((await stranger.post(`/api/v1/telegram/accounts/${accountId}/disconnect`)).status, 404);
    assert.equal((await stranger.del(`/api/v1/telegram/accounts/${accountId}`)).status, 404);

    // حساب المالك لم يتغيّر بفعل محاولات الغريب.
    const row = await server.sql('select status from telegram_accounts where id = $1', [accountId]);
    assert.equal(row.rows[0]?.status, 'pending_login');
  });

  it('يعيد الربط للحساب نفسه بعد انتهاء صلاحية المحاولة دون تعارض في الفهرس الفريد', async () => {
    const api = await newUser();
    behaviour();
    const first = await startLink(api);
    assert.equal(first.status, 201);
    const accountId = (first.body as { account: { id: string } }).account.id;

    // إهلاك المهلة كما تفعل الساعة الحقيقية.
    await server.sql(
      `update telegram_login_challenges
          set created_at = now() - interval '20 minutes',
              expires_at = now() - interval '1 minute'
        where account_id = $1 and consumed_at is null`,
      [accountId],
    );

    const expired = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: CODE });
    assert.equal(expired.status, 410);
    const consumed = await server.sql(
      'select consumed_at from telegram_login_challenges where account_id = $1 order by created_at desc limit 1',
      [accountId],
    );
    assert.notEqual(consumed.rows[0]?.consumed_at, null, 'يجب تحديث consumed_at عند اكتشاف الانتهاء');

    // محاولة جديدة للرقم نفسه وللحساب نفسه: تُستأنف على السجل المعلّق بدل رفضها.
    behaviour();
    const second = await startLink(api);
    assert.equal(second.status, 201, 'يجب أن تُقبل محاولة جديدة بعد الانتهاء');
    const secondBody = second.body as { account: { id: string; status: string }; challenge: { codeAttemptsRemaining: number } };
    assert.equal(secondBody.account.id, accountId, 'تُستأنف المحاولة على الحساب نفسه');
    assert.equal(secondBody.challenge.codeAttemptsRemaining, 5, 'تُصفَّر عدّادات المحاولات للمحاولة الجديدة');

    // لا يوجد إلا سجل واحد غير مستهلك لكل حساب (قيد الفهرس الجزئي سليم).
    const active = await server.sql(
      'select count(*)::int as c from telegram_login_challenges where account_id = $1 and consumed_at is null',
      [accountId],
    );
    assert.equal(active.rows[0]?.c, 1);

    const accountsCount = await server.sql(
      'select count(*)::int as c from telegram_accounts where user_id = (select user_id from telegram_accounts where id = $1)',
      [accountId],
    );
    assert.equal(accountsCount.rows[0]?.c, 1, 'لا يُنشأ سجل حساب مكرر للرقم نفسه');

    // والمحاولة الجديدة تُكمل بنجاح.
    const verified = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: CODE });
    assert.equal(verified.status, 200);
    assert.equal((verified.body as { account: { status: string } }).account.status, 'active');
  });

  it('يسمح بمحاولة جديدة بعد الإلغاء وبعد فشل بدء المصادقة، دون سجلات عالقة', async () => {
    const api = await newUser();

    // 1) إلغاء محاولة ثم إعادة البدء بالرقم نفسه.
    behaviour();
    const first = await startLink(api);
    const firstId = (first.body as { account: { id: string } }).account.id;
    assert.equal((await api.post(`/api/v1/telegram/accounts/${firstId}/cancel`)).status, 204);

    behaviour();
    const afterCancel = await startLink(api);
    assert.equal(afterCancel.status, 201);
    const afterCancelId = (afterCancel.body as { account: { id: string } }).account.id;
    assert.notEqual(afterCancelId, firstId, 'الإلغاء يحذف السجل المعلّق فتُنشأ محاولة جديدة');

    // 2) فشل بدء المصادقة (انقطاع شبكة) ثم إعادة البدء بالرقم نفسه.
    await api.post(`/api/v1/telegram/accounts/${afterCancelId}/cancel`);
    gateway.loginBehaviours.push({
      requestCode: () => {
        throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      },
    });
    const failed = await startLink(api);
    assert.equal(failed.status, 503);
    assert.equal((failed.body as { error: { code: string } }).error.code, 'telegram_unreachable');

    const leftovers = await server.sql(
      "select count(*)::int as c from telegram_accounts where status = 'pending_login' and user_id = $1",
      [lastUserId],
    );
    assert.equal(leftovers.rows[0]?.c, 0, 'يجب ألا يبقى سجل معلّق بعد فشل البدء');

    behaviour();
    const afterFailure = await startLink(api);
    assert.equal(afterFailure.status, 201, 'يجب أن تعمل المحاولة التالية بعد الفشل');
  });

  it('يرفض الطلبات غير المصادق عليها', async () => {
    const anonymous = client(server.baseUrl);
    assert.equal((await anonymous.get('/api/v1/telegram/accounts')).status, 401);
    assert.equal((await anonymous.post('/api/v1/telegram/accounts', { phoneNumber: PHONE })).status, 401);
    assert.equal((await anonymous.del('/api/v1/telegram/accounts/00000000-0000-4000-8000-000000000000')).status, 401);
  });

  it('يفصل الحساب ويحذف جلسته المشفّرة ويمنع ازدواج الرقم', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api);

    const duplicate = await startLink(api, PHONE);
    assert.equal(duplicate.status, 409);
    assert.equal((duplicate.body as { error: { code: string } }).error.code, 'account_already_linked');

    const removed = await api.del(`/api/v1/telegram/accounts/${accountId}`);
    assert.equal(removed.status, 204);

    const row = await server.sql(
      'select status, telegram_user_id, phone_hash from telegram_accounts where id = $1',
      [accountId],
    );
    assert.equal(row.rows[0]?.status, 'revoked');
    assert.equal(row.rows[0]?.telegram_user_id, null);
    assert.equal(row.rows[0]?.phone_hash, null);
    const sessions = await server.sql('select count(*)::int as c from telegram_sessions where account_id = $1', [
      accountId,
    ]);
    assert.equal(sessions.rows[0]?.c, 0);

    const list = await api.get('/api/v1/telegram/accounts');
    assert.equal((list.body as { accounts: unknown[] }).accounts.length, 0);

    // إعادة الربط بعد الفصل مسموحة (السجل التاريخي لا يمنع).
    behaviour();
    const relink = await startLink(api, PHONE);
    assert.equal(relink.status, 201);
  });

  it('يعيد المصادقة لحساب أُبطلت جلسته', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api);
    await server.sql("update telegram_accounts set status = 'needs_reauth', last_error_code = 'AUTH_KEY_UNREGISTERED' where id = $1", [
      accountId,
    ]);

    const view = await api.get(`/api/v1/telegram/accounts/${accountId}`);
    assert.equal((view.body as { account: { status: string } }).account.status, 'needs_reauth');

    behaviour();
    const reauth = await api.post(`/api/v1/telegram/accounts/${accountId}/reauth`, { phoneNumber: PHONE });
    assert.equal(reauth.status, 201);
    const verified = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: CODE });
    assert.equal(verified.status, 200);
    assert.equal((verified.body as { account: { status: string } }).account.status, 'active');
  });

  it('يمنع الاتصالات المكررة للحساب نفسه', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api);
    const before = gateway.created.filter((c) => c.accountId === accountId).length;

    const first = await api.post(`/api/v1/telegram/accounts/${accountId}/connect`);
    const second = await api.post(`/api/v1/telegram/accounts/${accountId}/connect`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const after = gateway.created.filter((c) => c.accountId === accountId).length;
    assert.equal(after, before, 'لا يجب إنشاء عميل اتصال جديد لحساب متصل بالفعل');
    assert.equal(
      (second.body as { account: { connection: { phase: string } } }).account.connection.phase,
      'connected',
    );
  });

  it('يلغي محاولة الربط ويحذف السجل المعلّق', async () => {
    const api = await newUser();
    behaviour();
    const started = await startLink(api);
    const accountId = (started.body as { account: { id: string } }).account.id;

    const cancelled = await api.post(`/api/v1/telegram/accounts/${accountId}/cancel`);
    assert.equal(cancelled.status, 204);

    const rows = await server.sql('select count(*)::int as c from telegram_accounts where id = $1', [accountId]);
    assert.equal(rows.rows[0]?.c, 0);
    const challenges = await server.sql(
      'select count(*)::int as c from telegram_login_challenges where account_id = $1 and consumed_at is null',
      [accountId],
    );
    assert.equal(challenges.rows[0]?.c, 0);
  });

  it('يحدّ إعادة إرسال الرمز بفاصل زمني', async () => {
    const api = await newUser();
    behaviour();
    const started = await startLink(api);
    const accountId = (started.body as { account: { id: string } }).account.id;

    const tooSoon = await api.post(`/api/v1/telegram/accounts/${accountId}/code`);
    assert.equal(tooSoon.status, 429);
    assert.equal((tooSoon.body as { error: { code: string } }).error.code, 'rate_limited');

    await server.sql(
      "update telegram_login_challenges set last_sent_at = now() - interval '5 minutes' where account_id = $1",
      [accountId],
    );
    const resent = await api.post(`/api/v1/telegram/accounts/${accountId}/code`);
    assert.equal(resent.status, 200);
    assert.equal((resent.body as { challenge: { resendsRemaining: number } }).challenge.resendsRemaining, 2);
  });

  it('يعيد حالة التكامل دون أي قيمة سرية', async () => {
    const api = await newUser();
    const res = await api.get('/api/v1/telegram/status');
    assert.equal(res.status, 200);
    const body = res.body as { ready: boolean; library: { name: string; version: string } };
    assert.equal(body.ready, true);
    assert.equal(body.library.name, 'fake-teleproto');
    assert.equal(containsSecret(res.body, 'session'), false);
  });

  it('يرفض أرقام الهاتف غير الصالحة', async () => {
    const api = await newUser();
    const res = await startLink(api, '0771234567');
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, 'validation_error');
  });
});
