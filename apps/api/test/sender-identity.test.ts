/**
 * اختبار تكامل لالتقاط هوية المرسل وإصلاح الصفوف القديمة.
 *
 * الحالة الواقعة التي كشفتها الرسالتان 19 و20 على المصدر «ارسال رسائل»:
 * `sender_id` محفوظ، لكن `sender_username` و`sender_display_name` كلاهما `null`
 * ⇒ سطر «👤 المرسل» لا يظهر في المنشور رغم تفعيل الميزة.
 *
 * ما يثبّته هذا الملف:
 *   1) الالتقاط: ما يصل من البوابة يُحفظ كاملاً في `message_identity`.
 *   2) الإصلاح الذاتي: رسالة قديمة بلا اسم تُكمَّل تلقائياً حين يُعرف المرسل في رسالة لاحقة.
 *   3) العزل: الإصلاح لا يمسّ صفوف مستخدم آخر ولا مصدراً آخر (ولو تطابق رقم المرسل).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });
});

after(async () => {
  await server.close();
});

interface SenderRow {
  sender_id: string | null;
  sender_username: string | null;
  sender_display_name: string | null;
  post_author: string | null;
}

async function senderOf(identityId: string): Promise<SenderRow> {
  const res = await server.sql<SenderRow>(
    'select sender_id::text as sender_id, sender_username, sender_display_name, post_author from message_identity where id = $1',
    [identityId],
  );
  assert.equal(res.rows.length, 1);
  return res.rows[0]!;
}

const TEXT = 'مطلوب مندوب مبيعات — الراتب مجزٍ.';

describe('التقاط هوية المرسل — من البوابة إلى القاعدة', () => {
  it('يحفظ المعرّف و@username والاسم كما وصلت', async () => {
    const h = await scenario.create();
    const identityId = await scenario.emit(h, TEXT, {
      id: '7490507720',
      username: 'mohammed_a',
      displayName: 'محمد عبدالله',
      postAuthor: null,
    });
    const row = await senderOf(identityId);
    assert.equal(row.sender_id, '7490507720');
    assert.equal(row.sender_username, 'mohammed_a');
    assert.equal(row.sender_display_name, 'محمد عبدالله');
  });

  it('يحفظ المعرّف وحده حين تصل البيانات ناقصة (الحالة الواقعة) بلا اختراع اسم', async () => {
    const h = await scenario.create();
    const identityId = await scenario.emit(h, TEXT, {
      id: '1374219975',
      username: null,
      displayName: null,
      postAuthor: null,
    });
    const row = await senderOf(identityId);
    assert.equal(row.sender_id, '1374219975');
    assert.equal(row.sender_username, null);
    assert.equal(row.sender_display_name, null);
  });

  it('يصل التوقيع (postAuthor) ويُحفظ كما هو', async () => {
    const h = await scenario.create();
    const identityId = await scenario.emit(h, TEXT, {
      id: null,
      username: null,
      displayName: null,
      postAuthor: 'إدارة القناة',
    });
    const row = await senderOf(identityId);
    assert.equal(row.post_author, 'إدارة القناة');
    assert.equal(row.sender_id, null);
  });
});

describe('الإصلاح الذاتي للصفوف الناقصة', () => {
  it('رسالة قديمة بلا اسم تُكمَّل حين يُعرف المرسل لاحقاً على نفس المصدر', async () => {
    const h = await scenario.create();
    const oldId = await scenario.emit(h, `${TEXT} (قديمة)`, {
      id: '7490507720',
      username: null,
      displayName: null,
      postAuthor: null,
    });
    assert.equal((await senderOf(oldId)).sender_display_name, null);

    // رسالة لاحقة من المرسل نفسه لكن ببيانات محلولة (بعد خطوة الحلّ الاحتياطية).
    const newId = await scenario.emit(h, `${TEXT} (جديدة)`, {
      id: '7490507720',
      username: 'mohammed_a',
      displayName: 'محمد عبدالله',
      postAuthor: null,
    });

    const repaired = await senderOf(oldId);
    assert.equal(repaired.sender_username, 'mohammed_a', 'اسم المستخدم أُكمل للصف القديم');
    assert.equal(repaired.sender_display_name, 'محمد عبدالله');
    assert.equal((await senderOf(newId)).sender_display_name, 'محمد عبدالله');
  });

  it('الإصلاح لا يمسّ مصدراً آخر ولا مستخدماً آخر بنفس رقم المرسل', async () => {
    const first = await scenario.create();
    const other = await scenario.create();

    const sameSender = { id: '555000111', username: null, displayName: null, postAuthor: null };
    const otherId = await scenario.emit(other, `${TEXT} (مستخدم آخر)`, sameSender);
    const firstId = await scenario.emit(first, `${TEXT} (مستخدم أول)`, sameSender);

    // ترقية الاسم عند المستخدم الأول فقط.
    await scenario.emit(first, `${TEXT} (باسم)`, {
      id: '555000111',
      username: 'resolved_user',
      displayName: 'اسم محلول',
      postAuthor: null,
    });

    assert.equal((await senderOf(otherId)).sender_username, null, 'صفوف مستخدم آخر لا تُمسّ');
    assert.equal((await senderOf(firstId)).sender_username, 'resolved_user');
  });
});
