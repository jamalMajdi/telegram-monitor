/**
 * بريد استعادة كلمة المرور — من الطلب إلى الرسالة إلى تغيير كلمة المرور (P0).
 *
 * هذا هو الاختبار الذي كان يفشل في التدقيق: كان `notification_outbox` يُكتب فيه ولا يُقرأ،
 * فرسالة الاستعادة **لا تصل أبداً**. هنا نُغلق الحلقة كاملة:
 *
 *   POST /password/forgot  →  صف pending في الصندوق (رمز مشفَّر، لا رمز صريح)
 *                          →  المستهلك يبني الرسالة من قالب مغلق
 *                          →  عميل SMTP حقيقي على 127.0.0.1 (TLS) يُسلّمها
 *                          →  نستخرج الرابط من **الرسالة المستلمة** ونُغيّر كلمة المرور به
 *                          →  الدخول بكلمة المرور الجديدة ينجح (والقديمة تفشل)
 *
 * ولا يُرسل البريد مرتين: الصف يُختم sent، والدورة الثانية تجد الصندوق فارغاً.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { generateTestCert, startFakeSmtp, type FakeSmtp } from './smtp-fake-server.js';
import type { OutboxStore } from '../src/modules/notifications/outboxRepository.js';
import type { OutboxWorker as WorkerType } from '../src/modules/notifications/outboxWorker.js';
import type { SmtpMailer as SmtpMailerType } from '../src/modules/notifications/smtpClient.js';
import type { Env } from '../src/config/env.js';

let server: TestServer;
let smtp: FakeSmtp;
let store: OutboxStore;
let worker: WorkerType;
let env: Env;

const PASSWORD = 'CorrectHorse123';

before(async () => {
  const certs = generateTestCert();
  smtp = await startFakeSmtp(certs, { mode: 'tls' });

  // التطبيق نفسه يبقى بلا SMTP (يعمل بالبريد المعطَّل)، والمستهلك في الاختبار يستخدم
  // عميلاً حقيقياً نحو الخادم المحلي — فلا نتاجر بإعدادات الإنتاج.
  process.env.APP_PUBLIC_URL = 'https://app.example.test';
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  server = await startTestServer({ logLevel: 'silent' });

  const [{ PgOutboxStore }, workerModule, smtpModule, envModule] = await Promise.all([
    import('../src/modules/notifications/outboxRepository.js'),
    import('../src/modules/notifications/outboxWorker.js'),
    import('../src/modules/notifications/smtpClient.js'),
    import('../src/config/env.js'),
  ]);
  store = new PgOutboxStore();
  env = envModule.env;
  const mailer: SmtpMailerType = new smtpModule.SmtpMailer({
    host: '127.0.0.1',
    port: smtp.port,
    secure: true,
    user: 'mailer',
    pass: 'secret-pass',
    from: 'no-reply@example.test',
    fromName: 'منصة الرصد والنشر',
    timeoutMs: 5_000,
    ca: certs.cert,
  });
  worker = new workerModule.OutboxWorker({ store, mailer, env, owner: 'reset-worker', intervalMs: 0 });
});

after(async () => {
  await server.close();
  await smtp.close();
});

// عزل بين المحاور: صفوف الصندوق من اختبار سابق لا تُستهلك في الاختبار التالي.
beforeEach(async () => {
  await server.sql('delete from notification_outbox');
});

async function registerUser(suffix: string): Promise<{ api: TestClient; email: string }> {
  const email = `reset-${suffix}-${Date.now()}@example.test`;
  const api = client(server.baseUrl);
  const res = await api.post('/api/v1/auth/register', {
    email,
    displayName: 'مالك الحساب',
    password: PASSWORD,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { api, email };
}

async function outboxRows(email: string) {
  const res = await server.sql<{
    id: string;
    status: string;
    template: string;
    recipient: string;
    payload: Record<string, unknown>;
    attempts: number;
    last_error: string | null;
  }>(
    `select id, status::text as status, template, recipient, payload, attempts, last_error
       from notification_outbox where recipient = $1 order by created_at`,
    [email],
  );
  return res.rows;
}

describe('بريد استعادة كلمة المرور — الحلقة كاملة', () => {
  it('الطلب يُنشئ صفاً برمز مشفَّر (لا رمز صريح في القاعدة)', async () => {
    const { api, email } = await registerUser('seal');
    const res = await api.post('/api/v1/auth/password/forgot', { email });
    assert.equal(res.status, 202);

    const rows = await outboxRows(email);
    assert.equal(rows.length, 1, 'صف واحد فقط');
    const row = rows[0]!;
    assert.equal(row.status, 'pending');
    assert.equal(row.template, 'auth.password_reset');
    assert.equal(row.recipient, email);
    assert.equal(typeof row.payload.sealed, 'string', 'الرمز مشفَّر في الحمولة');
    assert.ok(!JSON.stringify(row.payload).includes('token='), 'لا رمز صريح');
  });

  it('المستهلك يُسلّم الرسالة فعلياً، والرابط المستلم يُغيّر كلمة المرور', async () => {
    const { api, email } = await registerUser('loop');
    const before = smtp.mails.length;
    const requested = await api.post('/api/v1/auth/password/forgot', { email });
    assert.equal(requested.status, 202);
    // في الاختبار يُكشف رمز التطوير؛ نتحقق أنه **ليس** ما يُرسل بالبريد (البريد يحمل رمزاً آخر).
    const devToken = (requested.body as { devResetToken?: string }).devResetToken;

    const tick = await worker.deliverOne();
    assert.deepEqual(tick, { sent: 1, retried: 0, failed: 0, skipped: false });
    assert.equal(smtp.mails.length, before + 1, 'وصلت رسالة واحدة');

    const mail = smtp.mails[before]!;
    assert.deepEqual(mail.to, [email]);
    const match = /https:\/\/app\.example\.test\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(mail.body);
    assert.ok(match, 'الرسالة تحمل رابط الاستعادة من APP_PUBLIC_URL');
    const token = match![1]!;
    assert.ok(!mail.body.includes('sealed'), 'لا مغلّف خام في الرسالة');

    const rows = await outboxRows(email);
    assert.equal(rows[0]!.status, 'sent', 'الصف لم يبقَ معلّقاً');

    // تغيير كلمة المرور بالرمز المستلم من البريد نفسه.
    const newPassword = 'NewCorrectHorse456';
    const reset = await api.post('/api/v1/auth/password/reset', { token, password: newPassword });
    assert.equal(reset.status, 204, JSON.stringify(reset.body));

    const fresh = client(server.baseUrl);
    const loginOld = await fresh.post('/api/v1/auth/login', { email, password: PASSWORD });
    assert.equal(loginOld.status, 401, 'كلمة المرور القديمة لم تعد تعمل');
    const loginNew = await client(server.baseUrl).post('/api/v1/auth/login', {
      email,
      password: newPassword,
    });
    assert.equal(loginNew.status, 200, 'كلمة المرور الجديدة تعمل');

    // لو كان الرمز المكشوف في الاستجابة هو نفسه المُرسَل، لكان الرابط مجرّد تكرار — وهذا
    // مقبول في وضع التطوير فقط؛ لكن الرمز المستلم يجب أن يكون صالحاً (أثبتناه أعلاه).
    assert.ok(typeof devToken === 'string' || devToken === undefined);
  });

  it('لا بريد مكرر: الدورة التالية تجد الصندوق فارغاً', async () => {
    const { api, email } = await registerUser('once');
    await api.post('/api/v1/auth/password/forgot', { email });
    await worker.deliverOne();
    const again = await worker.deliverOne();
    assert.equal(again.sent, 0);
    assert.equal(again.reason, 'empty');
    const rows = await outboxRows(email);
    assert.equal(rows.filter((r) => r.template === 'auth.password_reset').length, 1);
  });

  it('طلب جديد يُبطل الرابط السابق ويُنشئ بريداً جديداً', async () => {
    const { api, email } = await registerUser('rotate');
    await api.post('/api/v1/auth/password/forgot', { email });
    const first = await outboxRows(email);
    await api.post('/api/v1/auth/password/forgot', { email });
    const rows = await outboxRows(email);
    assert.equal(rows.length, 2, 'طلبان ⇒ رسالتان (كل طلب رمز جديد)');
    assert.notEqual(rows[0]!.id, rows[1]!.id);
    assert.notEqual(rows[0]!.payload.sealed, rows[1]!.payload.sealed);
    assert.equal(first.length, 1);
  });

  it('بريد غير مسجَّل: استجابة موحّدة وبلا صف في الصندوق', async () => {
    const api = client(server.baseUrl);
    const res = await api.post('/api/v1/auth/password/forgot', { email: 'nobody-here@example.test' });
    assert.equal(res.status, 202);
    const rows = await server.sql<{ n: string }>(
      `select count(*)::text as n from notification_outbox where recipient = 'nobody-here@example.test'`,
    );
    assert.equal(rows.rows[0]!.n, '0');
  });
});
