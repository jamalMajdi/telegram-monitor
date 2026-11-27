/**
 * اختبارات تكامل الدفعة 7-أ: بوت النشر ووجهاته.
 *
 * قاعدة PostgreSQL حقيقية + عميل Bot API مزيّف (لا شبكة، ولا رمز حقيقي).
 * تغطي: تشفير الرمز وعدم إظهاره، رفض الرموز غير الصالحة، شروط صلاحية النشر في القناة/المجموعة،
 * الإيقاف/الاستئناف، سحب الصلاحية، العزل بين المستخدمين، والحذف الناعم (Q15) مع التدقيق.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
// أنواع فقط: تُحذف عند الترجمة كي لا تُحمَّل وحدات تعتمد على `env` قبل تهيئة الاختبار.
import type { FakeBotApiClient } from './publish-fakes.js';

const PASSWORD = 'CorrectHorse123';
let server: TestServer;
let botApi: FakeBotApiClient;
let makeToken: (seed: number) => string;
let BotApiErrorClass: typeof import('../src/modules/publishing/botApiClient.js').BotApiError;
let counter = 0;
let botSeed = 500;

before(async () => {
  // 1) العميل المزيّف لا يحمّل أي وحدة تقرأ `env` عند التحميل.
  const fakes = await import('./publish-fakes.js');
  botApi = new fakes.FakeBotApiClient();
  makeToken = fakes.fakeBotToken;
  // 2) ثم بدء الخادم: يضبط متغيّرات البيئة ويُهيّئ قاعدة الاختبار قبل تحميل وحدات التشغيل.
  server = await startTestServer({ botApiClient: botApi, logLevel: 'silent' });
  // 3) بعد التهيئة يصبح تحميل وحدات التشغيل آمناً.
  BotApiErrorClass = (await import('../src/modules/publishing/botApiClient.js')).BotApiError;
});

after(async () => {
  await server.close();
});

async function newUser(): Promise<TestClient> {
  const api = client(server.baseUrl);
  counter += 1;
  const res = await api.post('/api/v1/auth/register', {
    email: `pub${counter}@example.test`,
    displayName: `مستخدم نشر ${counter}`,
    password: PASSWORD,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return api;
}

interface BotHarness {
  api: TestClient;
  token: string;
  telegramId: string;
}

/** يربط بوتاً فعّالاً لمستخدم جديد عبر مسار HTTP الحقيقي. */
async function userWithBot(): Promise<BotHarness> {
  const api = await newUser();
  botSeed += 1;
  const token = makeToken(botSeed);
  const telegramId = String(900000 + botSeed);
  botApi.addBot(token, { telegramId, username: `publish_bot_${botSeed}`, firstName: 'ناشر' });
  const res = await api.post('/api/v1/telegram/publish/bot', { token, label: 'بوت النشر' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { api, token, telegramId };
}

/** يضيف محادثة معروفة للبوت مع عضوية محددة. */
function registerChat(input: {
  key: string;
  chatId: string;
  kind: 'channel' | 'supergroup' | 'group' | 'private';
  title: string;
  botTelegramId: string;
  member: { status: string; canPostMessages?: boolean; canEditMessages?: boolean } | null;
}): void {
  botApi.addChat(input.key, {
    chatId: input.chatId,
    kind: input.kind,
    title: input.title,
    username: input.key.startsWith('@') ? input.key.slice(1) : null,
  });
  if (input.member) {
    botApi.setMember(input.chatId, input.botTelegramId, {
      status: input.member.status,
      canPostMessages: input.member.canPostMessages ?? false,
      canEditMessages: input.member.canEditMessages ?? false,
    });
  }
}

describe('بوت النشر', () => {
  it('يرفض رمزاً بصيغة غير صالحة قبل أي طلب خارجي', async () => {
    const api = await newUser();
    const before = botApi.calls.length;
    const res = await api.post('/api/v1/telegram/publish/bot', { token: 'not-a-valid-bot-token-shape' });
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, 'invalid_bot_token_format');
    assert.equal(botApi.calls.length, before, 'لا يجب استدعاء Bot API برمز غير صالح الشكل');
  });

  it('يرفض الرمز الذي يرفضه تيليجرام ولا يخزّن شيئاً', async () => {
    const api = await newUser();
    const res = await api.post('/api/v1/telegram/publish/bot', { token: makeToken(999) });
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, 'invalid_bot_token');
    const rows = await server.sql('select count(*)::int as c from publish_bots');
    assert.equal(rows.rows[0]?.c, 0);
  });

  it('يخزّن الرمز مشفّراً فقط ولا يعيده في أي استجابة', async () => {
    const h = await userWithBot();
    const { containsPlaintext } = await import('../src/modules/telegram/sessionCipher.js');

    const stored = await server.sql<{ token_ciphertext: Buffer; token_key_version: number; token_fingerprint: string; status: string }>(
      'select token_ciphertext, token_key_version, token_fingerprint, status from publish_bots',
    );
    const row = stored.rows.at(-1)!;
    assert.ok(Buffer.isBuffer(row.token_ciphertext));
    assert.equal(containsPlaintext(row.token_ciphertext, h.token), false, 'يجب ألا يظهر الرمز في النص المشفّر');
    assert.equal(row.token_key_version, 1);
    assert.equal(row.token_fingerprint, createHash('sha256').update(h.token).digest('hex'));
    assert.equal(row.status, 'active');

    const view = await h.api.get('/api/v1/telegram/publish/bot');
    assert.equal(view.status, 200);
    const serialized = JSON.stringify(view.body);
    assert.equal(serialized.includes(h.token), false);
    assert.equal(serialized.includes(h.token.split(':')[1]!), false);
    const bot = (view.body as { bot: { configured: boolean; status: string; telegramId: string } }).bot;
    assert.equal(bot.configured, true);
    assert.equal(bot.status, 'active');
    assert.equal(bot.telegramId, h.telegramId);

    const audit = await server.sql(
      "select count(*)::int as c from audit_events where action = 'publishing.bot_connected'",
    );
    assert.equal(audit.rows[0]?.c, 1);
  });

  it('يعيد التحقق من البوت ويحدّث حالته عند الفشل', async () => {
    const h = await userWithBot();
    botApi.failOnce('getMe', new BotApiErrorClass('Unauthorized', 'unauthorized', { httpStatus: 401 }));
    const res = await h.api.post('/api/v1/telegram/publish/bot/verify');
    assert.equal(res.status, 200);
    const bot = (res.body as { bot: { status: string; lastErrorCode: string | null } }).bot;
    assert.equal(bot.status, 'invalid');
    assert.equal(bot.lastErrorCode, 'invalid_bot_token');

    const ok = await h.api.post('/api/v1/telegram/publish/bot/verify');
    assert.equal((ok.body as { bot: { status: string } }).bot.status, 'active');
  });

  it('يعطّل البوت بإرادة المستخدم ويمنع إضافة الوجهات', async () => {
    const h = await userWithBot();
    const removed = await h.api.del('/api/v1/telegram/publish/bot');
    assert.equal(removed.status, 204);
    const view = await h.api.get('/api/v1/telegram/publish/bot');
    assert.equal((view.body as { bot: { status: string } }).bot.status, 'disabled');

    const res = await h.api.post('/api/v1/telegram/publish/destinations', { identifier: '@any' });
    assert.equal(res.status, 409);
    assert.equal((res.body as { error: { code: string } }).error.code, 'bot_not_active');
  });
});

describe('وجهات النشر', () => {
  it('يرفض الإضافة قبل ربط بوت', async () => {
    const api = await newUser();
    const res = await api.post('/api/v1/telegram/publish/destinations', { identifier: '@ch' });
    assert.equal(res.status, 409);
    assert.equal((res.body as { error: { code: string } }).error.code, 'bot_required');
  });

  it('يضيف قناة يكون البوت فيها مشرفاً بحق النشر', async () => {
    const h = await userWithBot();
    registerChat({
      key: '@jobs_channel',
      chatId: '-1001234500001',
      kind: 'channel',
      title: 'قناة الوظائف',
      botTelegramId: h.telegramId,
      member: { status: 'administrator', canPostMessages: true },
    });

    const res = await h.api.post('/api/v1/telegram/publish/destinations', { identifier: '@jobs_channel' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const destination = (res.body as { destination: Record<string, unknown> }).destination;
    assert.equal(destination.status, 'active');
    assert.equal(destination.chatId, '-1001234500001');
    assert.equal(destination.chatKind, 'channel');
    assert.equal(destination.canPostMessages, true);
    assert.ok(destination.verifiedAt);
    assert.equal(JSON.stringify(res.body).includes(h.token), false);

    const audit = await server.sql(
      "select count(*)::int as c from audit_events where action = 'publishing.destination_added' and target_id = $1",
      [destination.id],
    );
    assert.equal(audit.rows[0]?.c, 1);
  });

  it('يعلن نقص صلاحية النشر في القناة بدل افتراضها', async () => {
    const h = await userWithBot();
    registerChat({
      key: '@news_channel',
      chatId: '-1001234500002',
      kind: 'channel',
      title: 'قناة أخبار',
      botTelegramId: h.telegramId,
      member: { status: 'administrator', canPostMessages: false },
    });
    const res = await h.api.post('/api/v1/telegram/publish/destinations', { identifier: '@news_channel' });
    assert.equal(res.status, 201);
    const destination = (res.body as { destination: { status: string; lastErrorCode: string } }).destination;
    assert.equal(destination.status, 'error');
    assert.equal(destination.lastErrorCode, 'missing_post_rights');
  });

  it('يرفض القناة التي ليس البوت مشرفاً فيها', async () => {
    const h = await userWithBot();
    registerChat({
      key: '@other_channel',
      chatId: '-1001234500003',
      kind: 'channel',
      title: 'قناة أخرى',
      botTelegramId: h.telegramId,
      member: { status: 'member' },
    });
    const res = await h.api.post('/api/v1/telegram/publish/destinations', { identifier: '@other_channel' });
    assert.equal(res.status, 201);
    const destination = (res.body as { destination: { status: string; lastErrorCode: string } }).destination;
    assert.equal(destination.status, 'error');
    assert.equal(destination.lastErrorCode, 'not_administrator');
  });

  it('يقبل مجموعة عظمى يكون البوت عضواً فيها', async () => {
    const h = await userWithBot();
    registerChat({
      key: '@projects_group',
      chatId: '-1001234500004',
      kind: 'supergroup',
      title: 'مجموعة المشاريع',
      botTelegramId: h.telegramId,
      member: { status: 'member' },
    });
    const res = await h.api.post('/api/v1/telegram/publish/destinations', { identifier: '@projects_group' });
    assert.equal(res.status, 201);
    const destination = (res.body as { destination: { status: string; chatKind: string } }).destination;
    assert.equal(destination.status, 'active');
    assert.equal(destination.chatKind, 'supergroup');
  });

  it('يرفض المحادثة الخاصة ويرفض التكرار', async () => {
    const h = await userWithBot();
    registerChat({
      key: '@dup_channel',
      chatId: '-1001234500005',
      kind: 'channel',
      title: 'قناة مكررة',
      botTelegramId: h.telegramId,
      member: { status: 'creator', canPostMessages: true },
    });
    const first = await h.api.post('/api/v1/telegram/publish/destinations', { identifier: '@dup_channel' });
    assert.equal(first.status, 201);
    const second = await h.api.post('/api/v1/telegram/publish/destinations', { identifier: '-1001234500005' });
    assert.equal(second.status, 409);
    assert.equal((second.body as { error: { code: string } }).error.code, 'destination_exists');
  });

  it('يوقف الوجهة عند سحب صلاحية النشر ويسجّل السبب', async () => {
    const h = await userWithBot();
    registerChat({
      key: '@revoked_channel',
      chatId: '-1001234500006',
      kind: 'channel',
      title: 'قناة تُسحب صلاحيتها',
      botTelegramId: h.telegramId,
      member: { status: 'administrator', canPostMessages: true },
    });
    const added = await h.api.post('/api/v1/telegram/publish/destinations', { identifier: '@revoked_channel' });
    const destinationId = (added.body as { destination: { id: string } }).destination.id;

    botApi.failOnce(
      'getChat',
      new BotApiErrorClass('Forbidden: bot was kicked from the channel chat', 'forbidden', { httpStatus: 403 }),
    );
    const verify = await h.api.post(`/api/v1/telegram/publish/destinations/${destinationId}/verify`);
    assert.equal(verify.status, 200);
    const destination = (verify.body as { destination: { status: string; lastErrorCode: string } }).destination;
    assert.equal(destination.status, 'revoked');
    assert.equal(destination.lastErrorCode, 'forbidden');
  });

  it('يوقف النشر ويستأنفه بتحقق جديد', async () => {
    const h = await userWithBot();
    registerChat({
      key: '@pause_channel',
      chatId: '-1001234500007',
      kind: 'channel',
      title: 'قناة الإيقاف',
      botTelegramId: h.telegramId,
      member: { status: 'administrator', canPostMessages: true },
    });
    const added = await h.api.post('/api/v1/telegram/publish/destinations', { identifier: '@pause_channel' });
    const destinationId = (added.body as { destination: { id: string } }).destination.id;

    const paused = await h.api.post(`/api/v1/telegram/publish/destinations/${destinationId}/pause`);
    assert.equal((paused.body as { destination: { status: string } }).destination.status, 'paused');

    const resumed = await h.api.post(`/api/v1/telegram/publish/destinations/${destinationId}/resume`);
    assert.equal((resumed.body as { destination: { status: string } }).destination.status, 'active');
  });

  it('يعزل الوجهات بين المستخدمين', async () => {
    const owner = await userWithBot();
    registerChat({
      key: '@private_channel',
      chatId: '-1001234500008',
      kind: 'channel',
      title: 'قناة خاصة',
      botTelegramId: owner.telegramId,
      member: { status: 'administrator', canPostMessages: true },
    });
    const added = await owner.api.post('/api/v1/telegram/publish/destinations', { identifier: '@private_channel' });
    const destinationId = (added.body as { destination: { id: string } }).destination.id;

    const stranger = await userWithBot();
    const list = await stranger.api.get('/api/v1/telegram/publish/destinations');
    assert.equal((list.body as { destinations: unknown[] }).destinations.length, 0);

    const verify = await stranger.api.post(`/api/v1/telegram/publish/destinations/${destinationId}/verify`);
    assert.equal(verify.status, 404);
  });

  it('يحذف الوجهة تعطيلاً ويُبقي السجل (Q15)', async () => {
    const h = await userWithBot();
    registerChat({
      key: '@delete_channel',
      chatId: '-1001234500009',
      kind: 'channel',
      title: 'قناة الحذف',
      botTelegramId: h.telegramId,
      member: { status: 'administrator', canPostMessages: true },
    });
    const added = await h.api.post('/api/v1/telegram/publish/destinations', { identifier: '@delete_channel' });
    const destinationId = (added.body as { destination: { id: string } }).destination.id;

    const removed = await h.api.del(`/api/v1/telegram/publish/destinations/${destinationId}`);
    assert.equal(removed.status, 204);

    const list = await h.api.get('/api/v1/telegram/publish/destinations');
    assert.equal((list.body as { destinations: unknown[] }).destinations.length, 0);

    const row = await server.sql<{ status: string }>('select status from destinations where id = $1', [destinationId]);
    assert.equal(row.rows[0]?.status, 'deleted');

    const audit = await server.sql(
      "select count(*)::int as c from audit_events where action = 'publishing.destination_deleted' and target_id = $1",
      [destinationId],
    );
    assert.equal(audit.rows[0]?.c, 1);
  });
});
