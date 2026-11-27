/**
 * اختبار عميل SMTP (P0 — تدقيق ما قبل التسليم) ضد **خادم SMTP حقيقي على 127.0.0.1**.
 *
 * لا محاكاة لدالة الإرسال: مقبس TCP/TLS حقيقي، بروتوكول SMTP حقيقي، وشهادة مُولَّدة للاختبار.
 * المحاور: العربية سليمة بعد فك base64، ترميز الموضوع RFC 2047، رفض العناوين غير الصالحة
 * محلياً، رفض المصادقة، رفض المستلم، رفض المصادقة على قناة صريحة، المهلة، و«غير مهيأ».
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SmtpMailer } from '../src/modules/notifications/smtpClient.js';
import { startFakeSmtp, type FakeSmtp } from './smtp-fake-server.js';

/** شهادة ذاتية التوقيع لخادم الاختبار. */
function generateCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'smtp-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

let certs: { key: string; cert: string };
let tlsServer: FakeSmtp;
const extras: FakeSmtp[] = [];

before(async () => {
  certs = generateCert();
  // المسار الأساسي: TLS مباشر (منفذ 465) — نفس مسار الإنتاج في التشفير والمصادقة.
  tlsServer = await startFakeSmtp(certs, { mode: 'tls' });
});

after(async () => {
  await tlsServer.close();
  for (const extra of extras) await extra.close();
});

function config(port: number, overrides: Partial<{ user: string; pass: string; secure: boolean }> = {}) {
  return {
    host: '127.0.0.1',
    port,
    secure: overrides.secure ?? true,
    user: overrides.user ?? 'mailer',
    pass: overrides.pass ?? 'secret-pass',
    from: 'no-reply@example.test',
    fromName: 'منصة الرصد والنشر',
    timeoutMs: 4_000,
    ca: certs.cert,
  };
}

describe('عميل SMTP — مسار النجاح (TLS حقيقي)', () => {
  it('يصادق ويُسلّم رسالة عربية كاملة عبر TLS', async () => {
    const mailer = new SmtpMailer(config(tlsServer.port));
    const before = tlsServer.mails.length;
    const result = await mailer.send({
      to: 'owner@example.test',
      subject: 'استعادة كلمة المرور — منصة الرصد والنشر',
      text: 'مرحباً،\nهذا رابط استعادة كلمة المرور.\nhttps://app.example.test/reset-password?token=abc123',
    });
    assert.deepEqual(result, { ok: true });
    const tail = tlsServer.commands.slice(-6);
    assert.ok(tail.includes('EHLO'), 'EHLO أُرسل');
    assert.deepEqual(tail.slice(-5), ['AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT'], 'تسلسل SMTP كما في البروتوكول');

    assert.equal(tlsServer.mails.length, before + 1, 'رسالة واحدة وصلت للخادم');
    const mail = tlsServer.mails[before]!;
    assert.equal(mail.from, 'no-reply@example.test');
    assert.deepEqual(mail.to, ['owner@example.test']);
    assert.match(mail.raw, /Subject: =\?UTF-8\?B\?/, 'الموضوع مرمّز RFC 2047');
    assert.match(mail.raw, /Content-Transfer-Encoding: base64/);
    assert.match(mail.raw, /Message-ID: </);
    assert.ok(mail.body.includes('مرحباً'), 'العربية وصلت سليمة');
    assert.ok(mail.body.includes('/reset-password?token=abc123'), 'الرابط كما هو');
  });

  it('يرفض عناوين غير صالحة محلياً بلا أي اتصال', async () => {
    const mailer = new SmtpMailer(config(tlsServer.port));
    for (const bad of ['', 'not-an-email', 'x@y', 'a@b.c\r\nBcc: z@z.z']) {
      const result = await mailer.send({ to: bad, subject: 's', text: 't' });
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, 'rejected');
    }
  });
});

describe('عميل SMTP — مسارات الفشل', () => {
  it('محاولة STARTTLS تُرسَل فعلاً حين يُعلنها الخادم، وفشلها لا يُكمل الإرسال', async () => {
    const plain = await startFakeSmtp(certs, { mode: 'plain', advertiseStartTls: true });
    extras.push(plain);
    const mailer = new SmtpMailer(config(plain.port, { secure: false }));
    const result = await mailer.send({ to: 'owner@example.test', subject: 's', text: 't' });
    assert.equal(result.ok, false, 'لا إرسال بلا تشفير');
    assert.ok(plain.commands.includes('STARTTLS'), 'العميل طلب الترقية');
    assert.equal(plain.mails.length, 0, 'لا رسالة على قناة صريحة');
  });

  it('مصادقة مرفوضة ⇒ auth_failed بلا كشف كلمة المرور وبلا حلقة إعادة', async () => {
    const rejecting = await startFakeSmtp(certs, { mode: 'tls', rejectAuth: true });
    extras.push(rejecting);
    const mailer = new SmtpMailer(config(rejecting.port, { pass: 'super-secret-password' }));
    const result = await mailer.send({ to: 'owner@example.test', subject: 's', text: 't' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'auth_failed', 'رفض المصادقة خطأ نهائي لا حلقة إعادة');
    assert.ok(!(result.detail ?? '').includes('super-secret-password'), 'كلمة المرور لا تظهر في التشخيص');
    assert.equal(rejecting.mails.length, 0);
  });

  it('خادم يرفض المستلم ⇒ rejected بلا إرسال', async () => {
    const strict = await startFakeSmtp(certs, { mode: 'tls', rejectRcpt: true });
    extras.push(strict);
    const mailer = new SmtpMailer(config(strict.port));
    const result = await mailer.send({ to: 'nobody@example.test', subject: 's', text: 't' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'rejected');
    assert.equal(strict.mails.length, 0);
  });

  it('خادم صريح بلا STARTTLS مع مصادقة ⇒ tls_unavailable (لا كلمة مرور على قناة مكشوفة)', async () => {
    const plainNoTls = await startFakeSmtp(certs, { mode: 'plain', advertiseStartTls: false });
    extras.push(plainNoTls);
    const mailer = new SmtpMailer(config(plainNoTls.port, { secure: false }));
    const result = await mailer.send({ to: 'owner@example.test', subject: 's', text: 't' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'tls_unavailable');
    assert.ok(!plainNoTls.commands.includes('AUTH'), 'لم تُرسل مصادقة إطلاقاً');
  });

  it('خادم لا يستجيب ⇒ ينتهي بمهلة ولا يتعلّق', async () => {
    const silent = createServer(() => {
      // يتصل ولا يقول شيئاً.
    });
    const port = await new Promise<number>((resolve) => {
      silent.listen(0, '127.0.0.1', () => {
        const address = silent.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    try {
      const mailer = new SmtpMailer({ ...config(port, { secure: false }), timeoutMs: 300 });
      const started = Date.now();
      const result = await mailer.send({ to: 'owner@example.test', subject: 's', text: 't' });
      assert.equal(result.ok, false);
      assert.ok(Date.now() - started < 3_000, 'لا تعليق');
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it('مُرسِل غير مهيأ ⇒ not_configured بلا محاولة اتصال', async () => {
    const mailer = new SmtpMailer(null);
    assert.equal(mailer.configured, false);
    const result = await mailer.send({ to: 'owner@example.test', subject: 's', text: 't' });
    assert.deepEqual(result, { ok: false, errorCode: 'not_configured' });
  });
});
