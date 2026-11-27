/**
 * اختبارات تكامل الاستخراج (الخطوة 5-ج): من رسالة واردة عبر بوابة محاكاة
 * إلى حقول وفئات تواصل مخزَّنة بمواضعها وثقتها، مع التحقق من ثوابت:
 *   - كل قيمة = مقتطع حرفي من النص المحفوظ (لا اختراع).
 *   - الحجب جاهز في `value_masked` ولا تُخزَّن صيغة معروضة غير محجوبة.
 *   - الرسالة غير المطابقة لا تُنتج أي نتيجة استخراج.
 *   - الحذف عند انتهاء الاحتفاظ يمسّ النتائج ويبقي الهوية.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway, fakeSource, type FakeAccountClient } from './telegram-fakes.js';
import type { IncomingTextMessage } from '../src/modules/telegram/gateway.js';

const PASSWORD = 'CorrectHorse123';
let server: TestServer;
let gateway: FakeGateway;
let counter = 0;
let peerCounter = 800000;

before(async () => {
  gateway = new FakeGateway();
  server = await startTestServer({ telegramGateway: gateway });
});

after(async () => {
  await server.close();
});

async function newUser(): Promise<TestClient> {
  const api = client(server.baseUrl);
  counter += 1;
  const res = await api.post('/api/v1/auth/register', {
    email: `ext${counter}@example.test`,
    displayName: `مستخدم استخراج ${counter}`,
    password: PASSWORD,
  });
  assert.equal(res.status, 201);
  return api;
}

async function linkedAccount(api: TestClient, telegramUserId: string): Promise<string> {
  gateway.outcomeSelf = { id: telegramUserId, username: `reader_${telegramUserId}` };
  gateway.loginBehaviours.push({ submitCode: () => ({ status: 'authorized', self: { id: telegramUserId } }) });
  const started = await api.post('/api/v1/telegram/accounts', { phoneNumber: `+9677${telegramUserId}` });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const accountId = (started.body as { account: { id: string } }).account.id;
  const verified = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: '12345' });
  assert.equal(verified.status, 200);
  return accountId;
}

function liveClient(accountId: string): FakeAccountClient {
  const found = gateway.created.filter((c) => c.accountId === accountId && c.subscribers.size > 0);
  assert.ok(found.length > 0);
  return found[found.length - 1]!;
}

interface Harness {
  api: TestClient;
  accountId: string;
  sourceId: string;
  peerId: string;
  userId: string;
}

async function newMonitoredUser(): Promise<Harness> {
  const api = await newUser();
  const accountId = await linkedAccount(api, String(900 + counter));
  peerCounter += 1;
  const peerId = String(peerCounter);
  gateway.sourceConfig.resolved.set(peerId, fakeSource({ peerId, title: `قناة ${peerId}`, username: `src_${peerId}` }));
  const created = await api.post('/api/v1/telegram/sources', { accountId, peerId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sourceId = (created.body as { source: { id: string } }).source.id;
  const row = await server.sql<{ user_id: string }>('select user_id from telegram_sources where id = $1', [sourceId]);
  return { api, accountId, sourceId, peerId, userId: row.rows[0]!.user_id };
}

async function emit(h: Harness, message: Partial<IncomingTextMessage>) {
  await liveClient(h.accountId).emit({
    accountId: h.accountId,
    peerKey: `channel:${h.peerId}`,
    peerKind: 'channel',
    messageId: 1,
    text: 'مطلوب مبرمج بخبرة سنتين',
    caption: '',
    hasMedia: false,
    ...message,
  });
}

async function identityOf(sourceId: string, telegramMessageId: number) {
  const res = await server.sql<{
    id: string;
    state: string;
    extraction_version: number | null;
    extraction_count: number;
    contact_count: number;
    review_state: string;
    extracted_at: string | null;
  }>(
    `select id, state, extraction_version, extraction_count, contact_count, review_state, extracted_at
       from message_identity where source_id = $1 and telegram_message_id = $2`,
    [sourceId, telegramMessageId],
  );
  assert.equal(res.rows.length, 1);
  return res.rows[0]!;
}

interface FieldRow {
  field_key: string;
  value_text: string;
  span_start: number;
  span_end: number;
  source: 'text' | 'caption';
  cue: string;
  confidence: string;
  ambiguous: boolean;
}

async function fieldsOf(identityId: string): Promise<FieldRow[]> {
  const res = await server.sql<FieldRow>(
    `select field_key, value_text, span_start, span_end, source, cue, confidence::text, ambiguous
       from message_extraction where identity_id = $1 order by span_start, field_key`,
    [identityId],
  );
  return res.rows;
}

interface ContactRow {
  contact_kind: string;
  value_raw: string;
  value_normalized: string;
  value_masked: string;
  span_start: number;
  span_end: number;
  source: 'text' | 'caption';
  confidence: string;
  ambiguous: boolean;
}

async function contactsOf(identityId: string): Promise<ContactRow[]> {
  const res = await server.sql<ContactRow>(
    `select contact_kind, value_raw, value_normalized, value_masked, span_start, span_end, source,
            confidence::text, ambiguous
       from message_contacts where identity_id = $1 order by span_start`,
    [identityId],
  );
  return res.rows;
}

async function contentOf(identityId: string) {
  const res = await server.sql<{ message_text: string | null; caption: string | null }>(
    'select message_text, caption from message_content where identity_id = $1',
    [identityId],
  );
  return res.rows[0] ?? null;
}

describe('الاستخراج (5-ج): حقول بمواضعها', () => {
  it('يستخرج الحقول المرتبطة بقرائنها ويحوّل الهوية إلى processed', async () => {
    const h = await newMonitoredUser();
    await emit(h, {
      messageId: 100,
      text: [
        'مطلوب مبرمج بخبرة سنتين',
        'الراتب: 500 دولار',
        'الموقع: صنعاء',
        'الموعد النهائي: 30 نوفمبر',
      ].join('\n'),
    });

    const identity = await identityOf(h.sourceId, 100);
    assert.equal(identity.state, 'processed');
    assert.equal(identity.extraction_version, 1);
    assert.ok(identity.extraction_count >= 3);
    assert.ok(identity.extracted_at);

    const content = await contentOf(identity.id);
    const fields = await fieldsOf(identity.id);
    assert.ok(fields.length >= 3);
    for (const field of fields) {
      const source = field.source === 'text' ? content!.message_text! : content!.caption ?? '';
      assert.equal(field.value_text, source.slice(field.span_start, field.span_end), `انحراف موضع: ${field.field_key}`);
      assert.ok(Number(field.confidence) > 0);
      assert.ok(field.cue.length > 0, 'القرينة محفوظة للتدقيق');
    }
    assert.ok(fields.some((field) => field.field_key === 'budget' && field.value_text === '500 دولار'));
    assert.ok(fields.some((field) => field.field_key === 'deadline' && field.value_text === '30 نوفمبر'));
  });

  it('لا يستخرج حقولاً غير موجودة (لا اختراع ولا حقول فارغة) — §7.4', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 101, text: 'مطلوب مبرمج للعمل، التفاصيل عبر الخاص' });
    const identity = await identityOf(h.sourceId, 101);
    const fields = await fieldsOf(identity.id);
    const keys = fields.map((field) => field.field_key);
    assert.ok(!keys.includes('budget'));
    assert.ok(!keys.includes('deadline'));
    assert.ok(!keys.includes('area_size'));
    assert.ok(fields.every((field) => field.value_text.trim().length > 0));
  });

  it('يستخرج من التعليق ويُسند المصدر والموضع إلى التعليق نفسه', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 102, text: 'مطلوب شقة للإيجار', caption: 'المساحة: 120 متر\nالموقع: حدة' });
    const identity = await identityOf(h.sourceId, 102);
    const content = await contentOf(identity.id);
    const fields = await fieldsOf(identity.id);
    const fromCaption = fields.filter((field) => field.source === 'caption');
    assert.ok(fromCaption.length >= 2);
    for (const field of fromCaption) {
      assert.equal(field.value_text, content!.caption!.slice(field.span_start, field.span_end));
    }
  });

  it('يعلّم الغموض ويرفع review_state بدل اختيار صامت (Q7)', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 103, text: 'مطلوب مبرمج\nالموقع: صنعاء\nالموقع: عدن' });
    const identity = await identityOf(h.sourceId, 103);
    assert.equal(identity.state, 'processed', 'الغموض لا يمنع المعالجة');
    assert.equal(identity.review_state, 'needs_review');
    const fields = await fieldsOf(identity.id);
    const locations = fields.filter((field) => field.field_key === 'location');
    assert.equal(locations.length, 2);
    assert.ok(locations.every((location) => location.ambiguous));
  });
});

describe('الاستخراج (5-ج): فئات التواصل والحجب', () => {
  it('يكتشف الهاتف والمعرّف ويخزّن صيغة محجوبة فقط للعرض', async () => {
    const h = await newMonitoredUser();
    await emit(h, {
      messageId: 110,
      text: 'مطلوب مبرمج\nللتواصل: +967 771 234 567 أو @ahmed_dev',
    });
    const identity = await identityOf(h.sourceId, 110);
    const contacts = await contactsOf(identity.id);
    assert.equal(contacts.length, 2);
    const phone = contacts.find((contact) => contact.contact_kind === 'phone')!;
    assert.equal(phone.value_normalized, '967771234567');
    assert.ok(!phone.value_masked.includes('967771234567'), 'العرض الافتراضي محجوب');
    assert.ok(phone.value_masked.includes('•'));
    const username = contacts.find((contact) => contact.contact_kind === 'username')!;
    assert.equal(username.value_normalized, 'ahmed_dev');
    assert.equal(username.value_masked, '@a•••••••v');
    assert.equal(identity.contact_count, 2);
  });

  it('يحفظ مواضع فئات التواصل بدقة داخل النص الأصلي', async () => {
    const h = await newMonitoredUser();
    const text = 'مطلوب مبرمج — واتساب: 0771234567';
    await emit(h, { messageId: 111, text });
    const identity = await identityOf(h.sourceId, 111);
    const content = await contentOf(identity.id);
    const contacts = await contactsOf(identity.id);
    assert.equal(contacts.length, 1);
    const phone = contacts[0]!;
    assert.equal(phone.value_raw, content!.message_text!.slice(phone.span_start, phone.span_end));
    assert.equal(phone.value_raw, '0771234567');
  });

  it('يعلّم الرقم الغامض للمراجعة ولا يمنع الحفظ', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 112, text: 'مطلوب مبرمج، رقمي 12345678' });
    const identity = await identityOf(h.sourceId, 112);
    assert.equal(identity.state, 'processed');
    assert.equal(identity.review_state, 'needs_review');
    const contacts = await contactsOf(identity.id);
    assert.equal(contacts[0]!.ambiguous, true);
  });
});

describe('الاستخراج (5-ج): الحدود والعزل والاحتفاظ', () => {
  it('لا يُنتج أي نتيجة استخراج للرسالة غير المطابقة', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 120, text: 'مساء الخير، للتواصل 0771234567' });
    const identity = await identityOf(h.sourceId, 120);
    assert.equal(identity.state, 'ignored');
    assert.equal(identity.extraction_count, 0);
    assert.equal(identity.contact_count, 0);
    assert.deepEqual(await fieldsOf(identity.id), []);
    assert.deepEqual(await contactsOf(identity.id), []);
  });

  it('الاحتفاظ يحذف النتائج ويُبقي الهوية والبصمة (Q12)', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 121, text: 'مطلوب مبرمج\nالراتب: 500 دولار\nللتواصل: 0771234567' });
    const identity = await identityOf(h.sourceId, 121);
    assert.ok((await fieldsOf(identity.id)).length > 0);
    assert.ok((await contactsOf(identity.id)).length > 0);

    await server.sql(
      "update message_content set retention_expires_at = now() - interval '1 hour' where identity_id = $1",
      [identity.id],
    );
    const { PgMessageProcessingStore } = await import('../src/modules/processing/messageProcessingRepository.js');
    await new PgMessageProcessingStore().purgeExpiredContent();

    assert.deepEqual(await fieldsOf(identity.id), [], 'الحقول محذوفة');
    assert.deepEqual(await contactsOf(identity.id), [], 'فئات التواصل محذوفة (بيانات شخصية)');
    const after_ = await identityOf(h.sourceId, 121);
    assert.ok(after_.extracted_at, 'سجل المعالجة التاريخي يبقى');
    const hash = await server.sql<{ content_hash: string | null }>(
      'select content_hash from message_identity where id = $1',
      [identity.id],
    );
    assert.match(hash.rows[0]!.content_hash ?? '', /^[0-9a-f]{64}$/);
  });

  it('لا تتسرّب نتائج مستخدم إلى آخر', async () => {
    const first = await newMonitoredUser();
    const second = await newMonitoredUser();
    await emit(first, { messageId: 130, text: 'مطلوب مبرمج\nللتواصل: 0771234567' });

    const rows = await server.sql<{ count: string }>(
      `select count(*)::text as count from message_contacts c
         join message_identity i on i.id = c.identity_id
        where i.user_id = $1`,
      [second.userId],
    );
    assert.equal(rows.rows[0]!.count, '0');
  });

  it('عدّاد المصدر يعكس الرسائل التي أكملت الاستخراج', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 140, text: 'مطلوب مبرمج\nالراتب: 500 دولار' });
    await emit(h, { messageId: 141, text: 'مساء الخير' });
    const counters = await server.sql<{ extracted_count: string; matched_count: string; ignored_count: string }>(
      'select extracted_count::text, matched_count::text, ignored_count::text from telegram_sources where id = $1',
      [h.sourceId],
    );
    assert.equal(counters.rows[0]!.extracted_count, '1');
    assert.equal(counters.rows[0]!.matched_count, '1');
    assert.equal(counters.rows[0]!.ignored_count, '1');
  });

  it('لوحة الحالة تعرض عدّاد الاستخراج ولا تعرض أي قيمة تواصل خام (O03/D07)', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 150, text: 'مطلوب مبرمج\nللتواصل: +967771234567' });
    const status = await h.api.get('/api/v1/telegram/ingest/status');
    assert.equal(status.status, 200);
    const serialized = JSON.stringify(status.body);
    assert.ok(!serialized.includes('967771234567'), 'لا رقم خام في الاستجابة');
    assert.ok(!serialized.includes('مطلوب مبرمج'), 'لا نص رسالة في الاستجابة');
    const source = (status.body as { sources: { sourceId: string; extractedCount: string }[] }).sources.find(
      (item) => item.sourceId === h.sourceId,
    );
    assert.equal(source!.extractedCount, '1');
  });
});
