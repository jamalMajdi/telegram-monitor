/**
 * صندوق البريد الصادر — المستهلك (P0، البند 6). تكامل مع قاعدة حقيقية.
 *
 * السؤال الذي كان التدقيق يطرحه: «هل يُقرأ `notification_outbox` فعلاً؟»
 * هنا نُثبت السلوك كاملاً:
 *  - استحواذ بلُقية: عاملان متزامنان لا يُرسلان الصف نفسه مرتين،
 *  - `sent` بعد النجاح، وإعادة جدولة بتأخير متزايد بعد الفشل، ثم `failed` بعد الحد،
 *  - قالب مجهول ⇒ إغلاق فاشل فوري بلا حرق محاولات،
 *  - بريد معطَّل ⇒ الصفوف تبقى `pending` بلا استهلاك ولا انهيار،
 *  - `dedupe_key` يمنع صفين متطابقين،
 *  - `counts()` يُعطي المدير صورة صادقة (معلّق/فاشل/مُرسل).
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, type TestServer } from './harness.js';
import type { OutboxStore } from '../src/modules/notifications/outboxRepository.js';
import type { OutboxWorker as WorkerType } from '../src/modules/notifications/outboxWorker.js';
import type { SmtpClient, SmtpMessage, SmtpSendResult } from '../src/modules/notifications/smtpClient.js';
import type { Env } from '../src/config/env.js';

let server: TestServer;
let store: OutboxStore;
let OutboxWorkerClass: typeof WorkerType;
let DisabledMailerClass: new () => SmtpClient;
let env: Env;
let userId: string;
let email: string;

/** مُرسِل يسجّل الرسائل ويتحكم بنتيجتها. */
class RecordingMailer implements SmtpClient {
  readonly configured = true;
  readonly sent: SmtpMessage[] = [];
  result: SmtpSendResult = { ok: true };
  constructor(private readonly handler?: (m: SmtpMessage) => SmtpSendResult) {}
  async send(message: SmtpMessage): Promise<SmtpSendResult> {
    this.sent.push(message);
    return this.handler ? this.handler(message) : this.result;
  }
}

function worker(mailer: SmtpClient, owner = 'test-worker'): WorkerType {
  return new OutboxWorkerClass({ store, mailer, env, owner, intervalMs: 0, leaseMs: 60_000 });
}

async function enqueue(input: {
  template?: string;
  recipient?: string;
  dedupeKey?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const ok = await store.enqueue({
    userId,
    channel: 'email',
    recipient: input.recipient ?? email,
    template: input.template ?? 'alerts.raised',
    payload: input.payload ?? { alertKey: 'awaiting_review', severity: 'warning', count: 3 },
    dedupeKey: input.dedupeKey ?? `test:${randomUUID()}`,
  });
  assert.equal(ok, true, 'الصف أُدرج');
}

async function rowById(id: string) {
  const res = await server.sql<{ status: string; attempts: number; error: string | null; next_attempt_at: string | null }>(
    'select status::text as status, attempts, last_error as error, next_attempt_at from notification_outbox where id = $1',
    [id],
  );
  return res.rows[0]!;
}

async function firstPendingId(): Promise<string> {
  const res = await server.sql<{ id: string }>(
    `select id from notification_outbox where status = 'pending' order by created_at limit 1`,
  );
  assert.ok(res.rows[0], 'يوجد صف معلّق');
  return res.rows[0]!.id;
}

before(async () => {
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
  OutboxWorkerClass = workerModule.OutboxWorker;
  DisabledMailerClass = smtpModule.DisabledMailer;
  env = envModule.env;
  // مستخدم حقيقي: الصفوف مرتبطة بـuser_id، والواقعية تكشف أي قيد مفقود.
  const { hashPassword } = await import('../src/lib/password.js');
  email = `outbox-${Date.now()}@example.test`;
  const hash = await hashPassword('CorrectHorse123');
  const res = await server.sql<{ id: string }>(
    `insert into users (email, display_name, password_hash, role, status)
     values ($1, 'صاحب البريد', $2, 'user', 'active') returning id`,
    [email, hash],
  );
  userId = res.rows[0]!.id;
});

after(async () => {
  await server.close();
});

beforeEach(async () => {
  // كل اختبار يبدأ بصندوق فارغ: الحالة لا تتسرّب بين المحاور.
  await server.sql('delete from notification_outbox');
});

describe('مستهلك الصندوق — النجاح والاستحواذ', () => {
  it('يُرسل صفاً معلّقاً ويختمه sent', async () => {
    await enqueue({});
    const id = await firstPendingId();
    const mailer = new RecordingMailer();
    const result = await worker(mailer).deliverOne();
    assert.deepEqual(result, { sent: 1, retried: 0, failed: 0, skipped: false });

    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0]!.to, email);
    assert.ok(mailer.sent[0]!.subject.includes('بانتظار موافقتك'), 'الموضوع من قالب التنبيه');
    const row = await rowById(id);
    assert.equal(row.status, 'sent');
  });

  it('لا يُرسل الصف نفسه مرتين (عاملان متزامنان، لُقية)', async () => {
    await enqueue({});
    const a = new RecordingMailer();
    const b = new RecordingMailer();
    const [ra, rb] = await Promise.all([worker(a, 'w-a').deliverOne(), worker(b, 'w-b').deliverOne()]);
    assert.equal(ra.sent + rb.sent, 1, 'تسليم واحد فقط');
    assert.equal(a.sent.length + b.sent.length, 1);

    // دورة أخرى: لا شيء معلّق ⇒ لا إرسال.
    const ra2 = await worker(a, 'w-a').deliverOne();
    assert.equal(ra2.sent, 0);
    assert.equal(ra2.reason, 'empty');
  });

  it('dedupe_key يمنع صفاً مكرراً', async () => {
    await enqueue({ dedupeKey: 'alert:same-alert' });
    const again = await store.enqueue({
      userId,
      channel: 'email',
      recipient: email,
      template: 'alerts.raised',
      payload: { alertKey: 'awaiting_review', severity: 'warning', count: 3 },
      dedupeKey: 'alert:same-alert',
    });
    assert.equal(again, false, 'الصف المكرر لم يُدرَج');
    const count = await server.sql<{ n: string }>('select count(*)::text as n from notification_outbox');
    assert.equal(count.rows[0]!.n, '1');
  });
});

describe('مستهلك الصندوق — الفشل والإعادة', () => {
  it('فشل الإرسال ⇒ إعادة جدولة بتأخير متزايد ثم failed بعد الحد', async () => {
    await enqueue({});
    const id = await firstPendingId();
    const failing = new RecordingMailer(() => ({ ok: false, errorCode: 'connect_failed' }));
    const w = worker(failing);

    let result = await w.deliverOne();
    assert.equal(result.retried, 1);
    let row = await rowById(id);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.ok(row.next_attempt_at !== null, 'مؤجّل');
    assert.ok(new Date(row.next_attempt_at!).getTime() > Date.now(), 'التأخير في المستقبل');
    assert.equal(row.error, 'connect_failed');

    // نُقرّب موعد المحاولة لكل تكرار حتى نصل الحد.
    for (let attempt = 2; attempt <= env.OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      await server.sql('update notification_outbox set next_attempt_at = now() where id = $1', [id]);
      result = await w.deliverOne();
    }
    row = await rowById(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, env.OUTBOX_MAX_ATTEMPTS);
    assert.equal(result.failed, 1, 'الفشل النهائي محسوب');
    assert.equal(result.retried, 0);
  });

  it('قالب مجهول ⇒ failed فوراً (لا محاولات مهدورة)', async () => {
    await enqueue({ template: 'nope.unknown' });
    const id = await firstPendingId();
    const mailer = new RecordingMailer();
    const result = await worker(mailer).deliverOne();
    assert.equal(result.failed, 1);
    assert.equal(mailer.sent.length, 0, 'لا رسالة مشوّهة');
    const row = await rowById(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'unknown_template');
  });

  it('بريد معطَّل ⇒ الصف يبقى pending بلا استهلاك ولا انهيار', async () => {
    await enqueue({});
    const id = await firstPendingId();
    const result = await worker(new DisabledMailerClass()).deliverOne();
    assert.deepEqual(result, { sent: 0, retried: 0, failed: 0, skipped: true, reason: 'not_configured' });
    const row = await rowById(id);
    assert.equal(row.status, 'pending', 'الصف لم يُحرق');
    assert.equal(row.attempts, 0, 'لم تُحسب محاولة');
    const counts = await store.counts();
    assert.equal(counts.pending, 1);
  });

  it('counts() يعكس الحالة الحقيقية للصندوق', async () => {
    // ترتيب صريح بالوقت: الصفوف الثلاثة قد تُدرَج في نفس الميلي ثانية، فيصبح ترتيب
    // الاستحواذ غير محدد — نُثبّت الزمن ليكون الاختبار حتمياً.
    await enqueue({});
    await enqueue({ template: 'nope.unknown' });
    await enqueue({});
    // ترتيب صريح بالوقت: الصفوف الثلاثة قد تُدرَج في نفس الميلي ثانية فيصبح ترتيب
    // الاستحواذ غير محدد. نُثبّت: تنبيه (الأقدم) ⇒ قالب مجهول ⇒ تنبيه.
    await server.sql(
      `update notification_outbox
          set created_at = case
                when template = 'nope.unknown' then now() - interval '2 minutes'
                when created_at = (select max(created_at) from notification_outbox) then now() - interval '1 minute'
                else now() - interval '3 minutes'
              end`,
    );
    const w = worker(new RecordingMailer());
    await w.deliverOne(); // الأول: تنبيه ⇒ sent
    await w.deliverOne(); // الثاني: قالب مجهول ⇒ failed
    const counts = await store.counts();
    assert.equal(counts.sent, 1);
    assert.equal(counts.failed, 1);
    assert.equal(counts.pending, 1);
  });
});
