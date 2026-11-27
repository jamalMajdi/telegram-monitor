/**
 * اختبارات تكامل خط المعالجة (الخطوة 5-ب): من وصول رسالة عبر بوابة محاكاة،
 * إلى قرار مسجَّل (matched/ignored) مع حفظ محتوى **المطابق فقط** وأدلة المطابقة.
 *
 * تغطي: Q1 (حفظ المطابق وحده)، Q2 (فصل المحتوى عن الهوية)، Q3 (وسائط فقط ⇒ تجاهل)،
 * Q4 (فشل المعالجة لا يوقف الالتقاط)، Q6 (is_repeat)، Q11 (الحدود بلا اقتطاع)،
 * Q12 (احتفاظ مستقل)، Q14 (عدّادات المصدر). ولا اتصال حقيقي بتيليجرام.
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
let peerCounter = 700000;

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
    email: `proc${counter}@example.test`,
    displayName: `مستخدم معالجة ${counter}`,
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
  assert.ok(found.length > 0, 'يجب أن يكون هناك عميل محاكاة متصل');
  return found[found.length - 1]!;
}

async function addSource(api: TestClient, accountId: string): Promise<{ sourceId: string; peerId: string }> {
  peerCounter += 1;
  const peerId = String(peerCounter);
  gateway.sourceConfig.resolved.set(peerId, fakeSource({ peerId, title: `قناة ${peerId}`, username: `src_${peerId}` }));
  const res = await api.post('/api/v1/telegram/sources', { accountId, peerId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { sourceId: (res.body as { source: { id: string } }).source.id, peerId };
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
  const accountId = await linkedAccount(api, String(800 + counter));
  const { sourceId, peerId } = await addSource(api, accountId);
  const row = await server.sql<{ id: string }>(
    'select user_id as id from telegram_sources where id = $1',
    [sourceId],
  );
  return { api, accountId, sourceId, peerId, userId: row.rows[0]!.id };
}

async function emit(h: Harness, message: Partial<IncomingTextMessage>) {
  const client_ = liveClient(h.accountId);
  await client_.emit({
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

interface IdentityRow {
  id: string;
  state: string;
  ignore_reason: string | null;
  matched_count: number;
  content_hash: string | null;
  is_repeat: boolean;
  processing_version: string | null;
  normalization_version: number | null;
  content_purged_at: string | null;
  processing_error_code: string | null;
}

async function identityFor(sourceId: string, telegramMessageId: number): Promise<IdentityRow> {
  const res = await server.sql<IdentityRow>(
    `select id, state, ignore_reason, matched_count, content_hash, is_repeat,
            processing_version::text as processing_version, normalization_version,
            content_purged_at, processing_error_code
       from message_identity
      where source_id = $1 and telegram_message_id = $2`,
    [sourceId, telegramMessageId],
  );
  assert.equal(res.rows.length, 1, 'يجب أن يكون صف هوية واحد');
  return res.rows[0]!;
}

async function contentFor(identityId: string) {
  const res = await server.sql<{
    message_text: string | null;
    caption: string | null;
    text_length: number;
    caption_length: number;
    content_hash: string;
    retention_expires_at: string;
  }>(
    `select message_text, caption, text_length, caption_length, content_hash, retention_expires_at
       from message_content where identity_id = $1`,
    [identityId],
  );
  return res.rows[0] ?? null;
}

async function countersFor(sourceId: string) {
  const res = await server.sql<Record<string, string>>(
    `select ingested_count::text, duplicate_count::text, excluded_count::text,
            matched_count::text, ignored_count::text, repeat_count::text, failed_count::text
       from telegram_sources where id = $1`,
    [sourceId],
  );
  return res.rows[0]!;
}

describe('خط المعالجة (5-ب): حفظ المطابق فقط', () => {
  it('يحفظ نص الرسالة المطابقة كاملاً مع أدلة المطابقة والعدّادات', async () => {
    const h = await newMonitoredUser();
    const text = 'مطلوب مبرمج بخبرة سنتين للعمل في شركة';
    await emit(h, { messageId: 10, text });

    const identity = await identityFor(h.sourceId, 10);
    // بعد 5-ج: المطابقة تكتمل بالاستخراج فتصبح الحالة processed (§17).
    assert.equal(identity.state, 'processed');
    assert.equal(identity.ignore_reason, null);
    assert.ok(identity.matched_count >= 1);
    assert.match(identity.content_hash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(identity.is_repeat, false);
    assert.ok(Number(identity.processing_version) >= 1, 'بصمة إصدار الإعدادات محفوظة');
    assert.equal(identity.normalization_version, 1);

    const content = await contentFor(identity.id);
    assert.ok(content);
    assert.equal(content!.message_text, text, 'النص الأصلي كما ورد (D04)');
    assert.equal(content!.caption, null);
    assert.equal(content!.text_length, text.length);

    // الاحتفاظ الافتراضي 48 ساعة من أول حفظ (Q1/Q12).
    const hours = (new Date(content!.retention_expires_at).getTime() - Date.now()) / 3_600_000;
    assert.ok(hours > 47 && hours <= 48.1, `مدة الاحتفاظ الفعلية ${hours.toFixed(2)} ساعة`);

    const matches = await server.sql<{ filter_name: string; evidence: unknown[] }>(
      'select filter_name, evidence from message_matches where identity_id = $1',
      [identity.id],
    );
    assert.ok(matches.rows.length >= 1);
    assert.ok(matches.rows.some((row) => row.filter_name === 'وظائف وفرص عمل'));
    assert.ok(Array.isArray(matches.rows[0]!.evidence));

    const counters = await countersFor(h.sourceId);
    assert.equal(counters.matched_count, '1');
    assert.equal(counters.ignored_count, '0');
    assert.equal(counters.ingested_count, '1');
  });

  it('يعالج التعليق كنص ويحفظه منفصلاً عن النص (D06)', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 11, text: '', caption: 'شقة مفروشة للإيجار قريبة من الجامعة', hasMedia: true });
    const identity = await identityFor(h.sourceId, 11);
    assert.equal(identity.state, 'processed');
    const content = await contentFor(identity.id);
    assert.ok(content);
    assert.equal(content!.message_text, null);
    assert.equal(content!.caption, 'شقة مفروشة للإيجار قريبة من الجامعة');
  });

  it('لا يحفظ نص الرسالة غير المطابقة ويعلّمها ignored/processed', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 12, text: 'مساء الخير جميعاً، كيف حالكم اليوم' });
    const identity = await identityFor(h.sourceId, 12);
    assert.equal(identity.state, 'ignored');
    assert.equal(identity.ignore_reason, 'no_filter');
    assert.equal(await contentFor(identity.id), null, 'لا محتوى لرسالة غير مطابقة (F04/Q1)');
    const matches = await server.sql('select 1 from message_matches where identity_id = $1', [identity.id]);
    assert.equal(matches.rows.length, 0);
    const counters = await countersFor(h.sourceId);
    assert.equal(counters.ignored_count, '1');
    assert.equal(counters.matched_count, '0');
  });

  it('يعلّم الرسالة التي لا نص فيها ولا تعليق ignored/no_text (Q3)', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 13, text: '', caption: '', hasMedia: true });
    const identity = await identityFor(h.sourceId, 13);
    assert.equal(identity.state, 'ignored');
    assert.equal(identity.ignore_reason, 'no_text');
    assert.equal(await contentFor(identity.id), null);
  });

  it('يرفض تجاوز الحد بلا اقتطاع (Q11)', async () => {
    const h = await newMonitoredUser();
    const tooLong = `مطلوب مبرمج ${'ا'.repeat(4200)}`;
    await emit(h, { messageId: 14, text: tooLong });
    const identity = await identityFor(h.sourceId, 14);
    assert.equal(identity.state, 'ignored');
    assert.equal(identity.ignore_reason, 'too_long');
    assert.equal(await contentFor(identity.id), null, 'لا اقتطاع ولا حفظ جزئي');
  });

  it('يعلّم لا-فلتر-مصدر عندما لا ينطبق أي فلتر على المصدر (Q9)', async () => {
    const h = await newMonitoredUser();
    const list = await h.api.get('/api/v1/telegram/filters');
    const filters = (list.body as { filters: { id: string }[] }).filters;
    for (const filter of filters) {
      const deleted = await h.api.del(`/api/v1/telegram/filters/${filter.id}`);
      assert.equal(deleted.status, 204);
    }
    await emit(h, { messageId: 15, text: 'مطلوب مبرمج بخبرة سنتين' });
    const identity = await identityFor(h.sourceId, 15);
    assert.equal(identity.state, 'ignored');
    assert.equal(identity.ignore_reason, 'no_source_filter');
    assert.equal(await contentFor(identity.id), null);
  });
});

describe('خط المعالجة (5-ب): التكرار والتكرار المضمون', () => {
  it('تكرار إعادة الإرسال لا يضاعف المحتوى ولا المطابقات', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 20, text: 'مطلوب مصمم جرافيك بخبرة' });
    const first = await identityFor(h.sourceId, 20);
    const matchesBefore = await server.sql<{ count: string }>(
      'select count(*)::text as count from message_matches where identity_id = $1',
      [first.id],
    );

    await emit(h, { messageId: 20, text: 'مطلوب مصمم جرافيك بخبرة' });
    await emit(h, { messageId: 20, text: 'نص مختلف تماماً' });

    const rows = await server.sql<{ count: string }>(
      'select count(*)::text as count from message_identity where source_id = $1 and telegram_message_id = 20',
      [h.sourceId],
    );
    assert.equal(rows.rows[0]!.count, '1', 'هوية واحدة فقط');
    const content = await server.sql<{ count: string }>(
      'select count(*)::text as count from message_content where identity_id = $1',
      [first.id],
    );
    assert.equal(content.rows[0]!.count, '1');
    const matchesAfter = await server.sql<{ count: string }>(
      'select count(*)::text as count from message_matches where identity_id = $1',
      [first.id],
    );
    assert.equal(matchesAfter.rows[0]!.count, matchesBefore.rows[0]!.count, 'لا إعادة معالجة للتكرار');
    const counters = await countersFor(h.sourceId);
    assert.equal(counters.duplicate_count, '2');
    assert.equal(counters.matched_count, '1');
  });

  it('يكشف تكرار المحتوى من مصدر آخر ويعلّم is_repeat (Q6)', async () => {
    const h = await newMonitoredUser();
    const { sourceId: secondSourceId } = await addSource(h.api, h.accountId);
    const text = 'أبحث عن شقة للإيجار في المنصورة';

    await emit(h, { messageId: 21, text });
    const secondPeerId = await server.sql<{ peer_id: string }>(
      'select peer_id::text as peer_id from telegram_sources where id = $1',
      [secondSourceId],
    );
    await liveClient(h.accountId).emit({
      accountId: h.accountId,
      peerKey: `channel:${secondPeerId.rows[0]!.peer_id}`,
      peerKind: 'channel',
      messageId: 21,
      text,
      caption: '',
      hasMedia: false,
    });

    const first = await identityFor(h.sourceId, 21);
    const second = await identityFor(secondSourceId, 21);
    assert.equal(first.state, 'processed');
    assert.equal(second.state, 'processed');
    assert.equal(first.is_repeat, false);
    assert.equal(second.is_repeat, true, 'المحتوى نفسه من مصدر آخر يُعلَّم تكراراً');
    assert.equal((await countersFor(secondSourceId)).repeat_count, '1');
  });
});

describe('خط المعالجة (5-ب): الاحتفاظ والحذف', () => {
  it('يحذف المحتوى والنتائج المنتهية ويبقي الهوية والبصمة (Q12)', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 30, text: 'مطلوب محاسب بخبرة سنتين' });
    const identity = await identityFor(h.sourceId, 30);
    assert.ok(await contentFor(identity.id));

    await server.sql(
      "update message_content set retention_expires_at = now() - interval '1 hour' where identity_id = $1",
      [identity.id],
    );
    const { PgMessageProcessingStore } = await import('../src/modules/processing/messageProcessingRepository.js');
    const purged = await new PgMessageProcessingStore().purgeExpiredContent();
    assert.ok(purged >= 1);

    assert.equal(await contentFor(identity.id), null, 'المحتوى محذوف');
    const matches = await server.sql('select 1 from message_matches where identity_id = $1', [identity.id]);
    assert.equal(matches.rows.length, 0, 'النتائج محذوفة');
    const after_ = await identityFor(h.sourceId, 30);
    assert.ok(after_.content_purged_at, 'تُعلَّم الهوية بأن المحتوى أُزيل');
    assert.match(after_.content_hash ?? '', /^[0-9a-f]{64}$/, 'البصمة تبقى لمنع التكرار');
    assert.equal(after_.state, 'processed', 'الحالة محفوظة كسجل');
  });
});

describe('خط المعالجة (5-ب): الواجهة والحالة', () => {
  it('تعرض لوحة الحالة عدّادات المعالجة ولا تعرض أي نص رسالة (D07)', async () => {
    const h = await newMonitoredUser();
    const text = 'مطلوب مبرمج بخبرة سنتين للعمل في شركة';
    await emit(h, { messageId: 40, text });

    const status = await h.api.get('/api/v1/telegram/ingest/status');
    assert.equal(status.status, 200);
    const serialized = JSON.stringify(status.body);
    assert.ok(!serialized.includes('مطلوب مبرمج'), 'لا نص رسالة في الاستجابة');
    assert.ok(!serialized.includes(text.slice(0, 20)), 'لا نص رسالة في الاستجابة');
    const source = (status.body as { sources: { sourceId: string; matchedCount: string; ignoredCount: string }[] })
      .sources.find((s) => s.sourceId === h.sourceId);
    assert.ok(source);
    assert.equal(source!.matchedCount, '1');
    assert.equal(source!.ignoredCount, '0');
  });

  it('فصل تام بين المستخدمين في بيانات المعالجة', async () => {
    const first = await newMonitoredUser();
    const second = await newMonitoredUser();
    await emit(first, { messageId: 50, text: 'مطلوب مبرمج بخبرة سنتين' });

    const secondStatus = await second.api.get('/api/v1/telegram/ingest/status');
    const mine = (secondStatus.body as { sources: { sourceId: string }[] }).sources;
    assert.ok(mine.every((s) => s.sourceId !== first.sourceId));

    const rows = await server.sql<{ count: string }>(
      `select count(*)::text as count
         from message_content c join message_identity i on i.id = c.identity_id
        where i.user_id = $1`,
      [second.userId],
    );
    assert.equal(rows.rows[0]!.count, '0');
  });
});
