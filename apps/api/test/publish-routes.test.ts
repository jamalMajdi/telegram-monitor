/**
 * اختبارات تكامل الدفعة 7-ب: المسارات، منع الحلقات (O05)، وإنشاء التسليمات (D05).
 *
 * قاعدة PostgreSQL حقيقية + بوابة تيليجرام محاكاة + عميل Bot API مزيّف: لا شبكة ولا رموز حقيقية.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway, fakeSource, type FakeAccountClient } from './telegram-fakes.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { IncomingTextMessage } from '../src/modules/telegram/gateway.js';
import type { PublishingRuntime } from '../src/modules/publishing/runtime.js';

const PASSWORD = 'CorrectHorse123';
let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let makeToken: (seed: number) => string;
let routing: PublishingRuntime['routing'];
let counter = 0;
let peerCounter = 0;
let botSeed = 700;
let messageId = 0;

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  makeToken = fakes.fakeBotToken;
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  const { PublishingRuntime: PublishingRuntimeClass } = await import('../src/modules/publishing/runtime.js');
  routing = new PublishingRuntimeClass().routing;
});

after(async () => {
  await server.close();
});

async function newUser(): Promise<TestClient> {
  const api = client(server.baseUrl);
  counter += 1;
  const res = await api.post('/api/v1/auth/register', {
    email: `route${counter}@example.test`,
    displayName: `مستخدم توجيه ${counter}`,
    password: PASSWORD,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return api;
}

async function linkedAccount(api: TestClient): Promise<string> {
  counter += 1;
  const telegramUserId = String(1200 + counter);
  gateway.outcomeSelf = { id: telegramUserId, username: `reader_${telegramUserId}` };
  gateway.loginBehaviours.push({ submitCode: () => ({ status: 'authorized', self: { id: telegramUserId } }) });
  const started = await api.post('/api/v1/telegram/accounts', { phoneNumber: `+9677${telegramUserId}` });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const accountId = (started.body as { account: { id: string } }).account.id;
  const verified = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: '12345' });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return accountId;
}

/** معرّف محادثة bot API المطابق لمعرّف مصدر (قناة/مجموعة عظمى). */
function chatIdOfPeer(peerId: string): string {
  return (-(1_000_000_000_000n + BigInt(peerId))).toString();
}

async function addSource(api: TestClient, accountId: string, peerId?: string): Promise<{ sourceId: string; peerId: string }> {
  peerCounter += 1;
  const id = peerId ?? String(777000 + peerCounter);
  gateway.sourceConfig.resolved.set(id, fakeSource({ peerId: id, title: `قناة ${id}`, username: `src_${id}` }));
  const res = await api.post('/api/v1/telegram/sources', { accountId, peerId: id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { sourceId: (res.body as { source: { id: string } }).source.id, peerId: id };
}

async function addBot(api: TestClient): Promise<{ token: string; telegramId: string }> {
  botSeed += 1;
  const token = makeToken(botSeed);
  const telegramId = String(950000 + botSeed);
  botApi.addBot(token, { telegramId, username: `pb_${botSeed}`, firstName: 'ناشر' });
  const res = await api.post('/api/v1/telegram/publish/bot', { token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token, telegramId };
}

async function addDestination(
  api: TestClient,
  botTelegramId: string,
  input: { chatId: string; key: string; title?: string; kind?: 'channel' | 'supergroup' },
): Promise<string> {
  const kind = input.kind ?? 'channel';
  botApi.addChat(input.key, {
    chatId: input.chatId,
    kind,
    title: input.title ?? `وجهة ${input.chatId}`,
    username: input.key.startsWith('@') ? input.key.slice(1) : null,
  });
  botApi.setMember(input.chatId, botTelegramId, {
    status: kind === 'channel' ? 'administrator' : 'member',
    canPostMessages: kind === 'channel',
    canEditMessages: false,
  });
  const res = await api.post('/api/v1/telegram/publish/destinations', { identifier: input.key });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const destination = (res.body as { destination: { id: string; status: string } }).destination;
  assert.equal(destination.status, 'active', JSON.stringify(res.body));
  return destination.id;
}

interface Harness {
  api: TestClient;
  accountId: string;
  sourceId: string;
  peerId: string;
  destinationId: string;
  destinationChatId: string;
  botTelegramId: string;
  userId: string;
}

let harnessCounter = 0;

/** مستخدم كامل: حساب مرتبط + مصدر مراقب + بوت + وجهة فعّالة. */
async function monitoredUser(options: { destinationChatId?: string } = {}): Promise<Harness> {
  const api = await newUser();
  const accountId = await linkedAccount(api);
  const { sourceId, peerId } = await addSource(api, accountId);
  const bot = await addBot(api);
  harnessCounter += 1;
  const destinationChatId = options.destinationChatId ?? String(-1009990000000 - harnessCounter);
  const destinationId = await addDestination(api, bot.telegramId, {
    chatId: destinationChatId,
    key: `@dest_${harnessCounter}`,
  });
  const row = await server.sql<{ user_id: string }>('select user_id from telegram_sources where id = $1', [sourceId]);
  return {
    api,
    accountId,
    sourceId,
    peerId,
    destinationId,
    destinationChatId,
    botTelegramId: bot.telegramId,
    userId: row.rows[0]!.user_id,
  };
}

function liveClient(accountId: string): FakeAccountClient {
  const found = gateway.created.filter((c) => c.accountId === accountId && c.subscribers.size > 0);
  assert.ok(found.length > 0, 'يجب أن يكون هناك عميل محاكاة متصل');
  return found[found.length - 1]!;
}

async function emit(h: Harness, text = 'مطلوب مبرمج بخبرة سنتين للعمل في شركة'): Promise<number> {
  messageId += 1;
  await liveClient(h.accountId).emit({
    accountId: h.accountId,
    peerKey: `channel:${h.peerId}`,
    peerKind: 'channel',
    messageId,
    text,
    caption: '',
    hasMedia: false,
  } satisfies IncomingTextMessage);
  return messageId;
}

async function identityOf(sourceId: string, telegramMessageId: number): Promise<{ id: string; state: string; publish_state: string }> {
  const res = await server.sql<{ id: string; state: string; publish_state: string }>(
    'select id, state, publish_state from message_identity where source_id = $1 and telegram_message_id = $2',
    [sourceId, telegramMessageId],
  );
  assert.equal(res.rows.length, 1, 'يجب أن يكون صف هوية واحد');
  return res.rows[0]!;
}

async function matchedFilterIds(identityId: string): Promise<string[]> {
  const res = await server.sql<{ filter_id: string }>('select filter_id from message_matches where identity_id = $1', [
    identityId,
  ]);
  return res.rows.map((row) => row.filter_id);
}

async function createRoute(
  api: TestClient,
  input: {
    name: string;
    destinationId: string;
    scopes: { kind: 'source' | 'filter' | 'classification'; targetId: string }[];
    templateId?: string | null;
    publishMode?: 'auto' | 'review';
  },
) {
  const res = await api.post('/api/v1/telegram/publish/routes', input);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return (res.body as { route: { id: string; status: string } }).route;
}

async function deliveriesFor(identityId: string) {
  const res = await server.sql<{
    id: string;
    destination_id: string;
    status: string;
    review: string;
    review_reason: string | null;
    template_id: string | null;
    route_id: string | null;
  }>('select id, destination_id, status, review, review_reason, template_id, route_id from deliveries where identity_id = $1', [
    identityId,
  ]);
  return res.rows;
}

describe('محرك التوجيه: إنشاء التسليمات', () => {
  it('ينشئ تسليماً واحداً عند اكتمال المعالجة عبر الخط الكامل', async () => {
    const h = await monitoredUser();
    const first = await emit(h);
    const identity = await identityOf(h.sourceId, first);
    assert.equal(identity.state, 'processed');

    const filterIds = await matchedFilterIds(identity.id);
    assert.ok(filterIds.length >= 1, 'يجب أن تُطابق الرسالة فلتراً مبدئياً على الأقل');

    const route = await createRoute(h.api, {
      name: 'مسار الوظائف',
      destinationId: h.destinationId,
      scopes: [{ kind: 'filter', targetId: filterIds[0]! }],
    });
    assert.equal(route.status, 'draft');

    // لا توجيه قبل التفعيل.
    const beforeActivation = await routing.routeMessage({
      userId: h.userId,
      identityId: identity.id,
      sourceId: h.sourceId,
      matchedFilterIds: filterIds,
    });
    assert.equal(beforeActivation.deliveries, 0, 'المسار غير الفعّال لا ينشئ تسليماً');

    const activated = await h.api.post(`/api/v1/telegram/publish/routes/${route.id}/activate`);
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    const activatedRoute = (activated.body as { route: { status: string; edgeCount: number } }).route;
    assert.equal(activatedRoute.status, 'active');
    assert.equal(activatedRoute.edgeCount, 1, 'حافة واحدة للمصدر الوحيد');

    const second = await emit(h);
    const secondIdentity = await identityOf(h.sourceId, second);
    const deliveries = await deliveriesFor(secondIdentity.id);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.destination_id, h.destinationId);
    assert.notEqual(secondIdentity.publish_state, 'not_routed', 'الرسالة موسومة بأنها دخلت التوجيه');

    const list = await h.api.get('/api/v1/telegram/publish/deliveries');
    assert.equal(list.status, 200);
    const listed = (list.body as { deliveries: { destinationTitle: string }[] }).deliveries;
    assert.equal(listed.length, 1);

    const audit = await server.sql(
      "select count(*)::int as c from audit_events where action = 'publishing.route_activated' and target_id = $1",
      [route.id],
    );
    assert.equal(audit.rows[0]?.c, 1);
  });

  it('ينشئ تسليماً بانتظار الإرسال (queued) للرسالة المؤكدة في مسار تلقائي', async () => {
    const h = await monitoredUser();
    const message = await emit(h);
    const identity = await identityOf(h.sourceId, message);
    // نُزيل وسم الغموض لقياس المسار التلقائي وحده (مسار Q4 مُختبَر في الحالة التالية).
    await server.sql("update message_identity set review_state = 'none' where id = $1", [identity.id]);
    const filterIds = await matchedFilterIds(identity.id);

    const route = await createRoute(h.api, {
      name: 'مسار تلقائي',
      destinationId: h.destinationId,
      scopes: [{ kind: 'filter', targetId: filterIds[0]! }],
    });
    const activation = await h.api.post(`/api/v1/telegram/publish/routes/${route.id}/activate`);
    assert.equal(activation.status, 200, JSON.stringify(activation.body));

    const outcome = await routing.routeMessage({
      userId: h.userId,
      identityId: identity.id,
      sourceId: h.sourceId,
      matchedFilterIds: filterIds,
    });
    assert.equal(outcome.deliveries, 1);
    assert.equal(outcome.publishState, 'routed');

    const deliveries = await deliveriesFor(identity.id);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, 'queued');
    assert.equal(deliveries[0]?.review, 'not_required');
    const state = await identityOf(h.sourceId, message);
    assert.equal(state.publish_state, 'routed');
  });

  it('ينشئ تسليماً واحداً فقط مهما تعددت المسارات إلى الوجهة نفسها (D05)', async () => {
    const h = await monitoredUser();
    const first = await emit(h);
    const identity = await identityOf(h.sourceId, first);
    const filterIds = await matchedFilterIds(identity.id);

    const byFilter = await createRoute(h.api, {
      name: 'مسار بالفلتر',
      destinationId: h.destinationId,
      scopes: [{ kind: 'filter', targetId: filterIds[0]! }],
    });
    const bySource = await createRoute(h.api, {
      name: 'مسار بالمصدر',
      destinationId: h.destinationId,
      scopes: [{ kind: 'source', targetId: h.sourceId }],
    });
    for (const route of [byFilter, bySource]) {
      const res = await h.api.post(`/api/v1/telegram/publish/routes/${route.id}/activate`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }

    const message = await emit(h);
    const messageIdentity = await identityOf(h.sourceId, message);
    const messageFilterIds = await matchedFilterIds(messageIdentity.id);
    const deliveries = await deliveriesFor(messageIdentity.id);
    assert.equal(deliveries.length, 1, 'تسليم منطقي واحد لكل (رسالة، وجهة)');

    // إعادة التوجيه (محاكاة إعادة معالجة) لا تُنشئ صفاً ثانياً.
    const again = await routing.routeMessage({
      userId: h.userId,
      identityId: messageIdentity.id,
      sourceId: h.sourceId,
      matchedFilterIds: messageFilterIds,
    });
    assert.equal(again.deliveries, 0);
    assert.equal(again.destinations, 1);
    const after = await deliveriesFor(messageIdentity.id);
    assert.equal(after.length, 1);
  });

  it('يطلب المراجعة عند غموض المعالجة أو سياسة المسار ويوسم الهوية بانتظار المراجعة', async () => {
    const h = await monitoredUser();
    // نص غامض حقيقي (يطابق «عقارات» و«وظائف وفرص عمل») — الطلب الواضح لم يبقَ موسوماً بعد تحسين البذور.
    const first = await emit(h, 'مطلوب شقة للإيجار لشركة');
    const identity = await identityOf(h.sourceId, first);
    const reviewState = await server.sql<{ review_state: string }>(
      'select review_state from message_identity where id = $1',
      [identity.id],
    );
    assert.equal(reviewState.rows[0]?.review_state, 'needs_review', 'الرسالة موسومة للمراجعة (Q4)');
    const filterIds = await matchedFilterIds(identity.id);

    const route = await createRoute(h.api, {
      name: 'مسار بمراجعة',
      destinationId: h.destinationId,
      scopes: [{ kind: 'filter', targetId: filterIds[0]! }],
      publishMode: 'review',
    });
    const activated = await h.api.post(`/api/v1/telegram/publish/routes/${route.id}/activate`);
    assert.equal(activated.status, 200, JSON.stringify(activated.body));

    // غموض المعالجة يتقدّم على سياسة المسار ⇒ سبب المراجعة 'message' لا 'route'.
    const message = await emit(h, 'مطلوب شقة للإيجار لشركة');
    const messageIdentity = await identityOf(h.sourceId, message);
    const deliveries = await deliveriesFor(messageIdentity.id);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, 'awaiting_review');
    assert.equal(deliveries[0]?.review, 'pending');
    // سبب المراجعة: غموض المعالجة (Q4) يتقدّم على طلب المسار، وكلاهما يوقف النشر.
    assert.equal(deliveries[0]?.review_reason, 'message');
    assert.equal(messageIdentity.publish_state, 'awaiting_review');

    const status = await h.api.get('/api/v1/telegram/publish/status');
    assert.equal((status.body as { deliveries: { awaitingReview: number } }).deliveries.awaitingReview, 1);
  });

  it('قالب المسار يتقدّم على قالب المعالجة (O02)', async () => {
    const h = await monitoredUser();
    const first = await emit(h);
    const identity = await identityOf(h.sourceId, first);
    const filterIds = await matchedFilterIds(identity.id);

    const template = await server.sql<{ id: string }>(
      "insert into templates (user_id, name) values ($1, 'قالب المسار') returning id",
      [h.userId],
    );
    const templateId = template.rows[0]!.id;

    const route = await createRoute(h.api, {
      name: 'مسار بقالب',
      destinationId: h.destinationId,
      scopes: [{ kind: 'filter', targetId: filterIds[0]! }],
      templateId,
    });
    const activated = await h.api.post(`/api/v1/telegram/publish/routes/${route.id}/activate`);
    assert.equal(activated.status, 200, JSON.stringify(activated.body));

    const message = await emit(h);
    const messageIdentity = await identityOf(h.sourceId, message);
    const deliveries = await deliveriesFor(messageIdentity.id);
    assert.equal(deliveries[0]?.template_id, templateId);
  });

  it('لا يوجّه إلى وجهة غير فعّالة ولا يفعّل مسارها', async () => {
    const h = await monitoredUser();
    const paused = await h.api.post(`/api/v1/telegram/publish/destinations/${h.destinationId}/pause`);
    assert.equal((paused.body as { destination: { status: string } }).destination.status, 'paused');

    const first = await emit(h);
    const identity = await identityOf(h.sourceId, first);
    const filterIds = await matchedFilterIds(identity.id);
    const route = await createRoute(h.api, {
      name: 'مسار وجهة موقوفة',
      destinationId: h.destinationId,
      scopes: [{ kind: 'filter', targetId: filterIds[0]! }],
    });
    const activation = await h.api.post(`/api/v1/telegram/publish/routes/${route.id}/activate`);
    assert.equal(activation.status, 409);
    assert.equal((activation.body as { error: { code: string } }).error.code, 'destination_not_active');

    const message = await emit(h);
    const messageIdentity = await identityOf(h.sourceId, message);
    assert.equal((await deliveriesFor(messageIdentity.id)).length, 0);
    assert.equal(messageIdentity.publish_state, 'not_routed');
  });

  it('يرفض مساراً بلا شروط ووجهة أو شرطاً غير مملوك', async () => {
    const h = await monitoredUser();
    const empty = await h.api.post('/api/v1/telegram/publish/routes', {
      name: 'بلا شروط',
      destinationId: h.destinationId,
      scopes: [],
    });
    assert.equal(empty.status, 400);

    const stranger = await monitoredUser();
    const strangerSource = await server.sql<{ id: string }>(
      'select id from telegram_sources where user_id = $1',
      [stranger.userId],
    );
    const notMine = await h.api.post('/api/v1/telegram/publish/routes', {
      name: 'شرط الغير',
      destinationId: h.destinationId,
      scopes: [{ kind: 'source', targetId: strangerSource.rows[0]!.id }],
    });
    assert.equal(notMine.status, 404);
  });

  it('يعطّل مسارات الوجهة عند حذفها', async () => {
    const h = await monitoredUser();
    const first = await emit(h);
    const identity = await identityOf(h.sourceId, first);
    const filterIds = await matchedFilterIds(identity.id);
    const route = await createRoute(h.api, {
      name: 'مسار يُعطّل بالحذف',
      destinationId: h.destinationId,
      scopes: [{ kind: 'filter', targetId: filterIds[0]! }],
    });
    const activated = await h.api.post(`/api/v1/telegram/publish/routes/${route.id}/activate`);
    assert.equal(activated.status, 200);

    const removed = await h.api.del(`/api/v1/telegram/publish/destinations/${h.destinationId}`);
    assert.equal(removed.status, 204);

    const row = await server.sql<{ status: string }>('select status from publish_routes where id = $1', [route.id]);
    assert.equal(row.rows[0]?.status, 'paused');
    const edges = await server.sql('select 1 from routing_edges where route_id = $1', [route.id]);
    assert.equal(edges.rowCount, 0, 'تُحذف حواف المسار عند تعطيله');
  });
});

describe('منع الحلقات (O05)', () => {
  it('يرفض الدورة المباشرة: النشر إلى قناة نقرأ منها', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api);
    const { sourceId, peerId } = await addSource(api, accountId);
    const bot = await addBot(api);
    const chatId = chatIdOfPeer(peerId);
    const destinationId = await addDestination(api, bot.telegramId, { chatId, key: '@self_loop' });
    const userId = (await server.sql<{ user_id: string }>('select user_id from telegram_sources where id = $1', [sourceId]))
      .rows[0]!.user_id;

    const route = await createRoute(api, {
      name: 'مسار دائري مباشر',
      destinationId,
      scopes: [{ kind: 'source', targetId: sourceId }],
    });
    const activation = await api.post(`/api/v1/telegram/publish/routes/${route.id}/activate`);
    assert.equal(activation.status, 409);
    const error = (activation.body as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'routing_cycle_detected');
    assert.equal(error.message.includes('حلقة'), true);

    const state = await server.sql<{ status: string }>('select status from publish_routes where id = $1', [route.id]);
    assert.equal(state.rows[0]?.status, 'draft', 'الرفض لا يترك المسار فعّالاً');
    const edges = await server.sql('select 1 from routing_edges where user_id = $1', [userId]);
    assert.equal(edges.rowCount, 0, 'لا تُترك حواف بعد رفض الدورة');
  });

  it('يرفض الدورة غير المباشرة داخل مساحة المستخدم نفسه', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api);
    const a = await addSource(api, accountId);
    const b = await addSource(api, accountId);
    const bot = await addBot(api);
    const destB = await addDestination(api, bot.telegramId, { chatId: chatIdOfPeer(b.peerId), key: '@dest_b' });
    const destA = await addDestination(api, bot.telegramId, { chatId: chatIdOfPeer(a.peerId), key: '@dest_a' });

    // A → B : مسموح.
    const first = await createRoute(api, {
      name: 'A إلى B',
      destinationId: destB,
      scopes: [{ kind: 'source', targetId: a.sourceId }],
    });
    const firstActivation = await api.post(`/api/v1/telegram/publish/routes/${first.id}/activate`);
    assert.equal(firstActivation.status, 200, JSON.stringify(firstActivation.body));

    // B → A : يُغلق دورة A → B → A.
    const second = await createRoute(api, {
      name: 'B إلى A',
      destinationId: destA,
      scopes: [{ kind: 'source', targetId: b.sourceId }],
    });
    const secondActivation = await api.post(`/api/v1/telegram/publish/routes/${second.id}/activate`);
    assert.equal(secondActivation.status, 409);
    assert.equal((secondActivation.body as { error: { code: string } }).error.code, 'routing_cycle_detected');
  });

  it('يرفض الدورة عبر مستخدمين آخرين دون كشف مسارهم', async () => {
    const owner = await newUser();
    const ownerAccount = await linkedAccount(owner);
    const ownerSource = await addSource(owner, ownerAccount);
    const ownerBot = await addBot(owner);
    const ownerDestination = await addDestination(owner, ownerBot.telegramId, {
      chatId: '-1008880000001',
      key: '@cross_dest',
      title: 'قناة الغير السرية',
    });

    // مالك: مصدره → وجهة خاصة.
    const ownerRoute = await createRoute(owner, {
      name: 'مسار المالك',
      destinationId: ownerDestination,
      scopes: [{ kind: 'source', targetId: ownerSource.sourceId }],
    });
    const ownerActivation = await owner.post(`/api/v1/telegram/publish/routes/${ownerRoute.id}/activate`);
    assert.equal(ownerActivation.status, 200, JSON.stringify(ownerActivation.body));

    // مستخدم آخر يراقب وجهة المالك ويحاول النشر إلى مصدر المالك ⇒ دورة عبر المستخدمين.
    const other = await newUser();
    const otherAccount = await linkedAccount(other);
    // المستخدم الآخر يراقب نفس محادثة وجهة المالك (معرّفها الفني 8880000001).
    const otherSource = await addSource(other, otherAccount, '8880000001');
    const otherBot = await addBot(other);
    const otherDestinationId = await addDestination(other, otherBot.telegramId, {
      chatId: chatIdOfPeer(ownerSource.peerId),
      key: '@victim_source',
      title: 'قناة مصدر المالك',
    });
    const otherRoute = await createRoute(other, {
      name: 'مسار المستخدم الآخر',
      destinationId: otherDestinationId,
      scopes: [{ kind: 'source', targetId: otherSource.sourceId }],
    });
    const otherActivation = await other.post(`/api/v1/telegram/publish/routes/${otherRoute.id}/activate`);
    assert.equal(otherActivation.status, 409);
    const error = (otherActivation.body as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'routing_cycle_detected');
    // الرفض محايد: لا يكشف عنوان قناة المالك ولا اسم مساره.
    assert.equal(error.message.includes('قناة الغير السرية'), false);
    assert.equal(error.message.includes('مسار المالك'), false);
  });

  it('يحذف الحواف عند تعطيل المسار ويعيد بناءها عند التفعيل', async () => {
    const h = await monitoredUser();
    const first = await emit(h);
    const identity = await identityOf(h.sourceId, first);
    const filterIds = await matchedFilterIds(identity.id);
    const route = await createRoute(h.api, {
      name: 'مسار للحواف',
      destinationId: h.destinationId,
      scopes: [{ kind: 'filter', targetId: filterIds[0]! }],
    });
    await h.api.post(`/api/v1/telegram/publish/routes/${route.id}/activate`);
    const before = await server.sql('select 1 from routing_edges where route_id = $1', [route.id]);
    assert.equal(before.rowCount, 1);

    const deactivated = await h.api.post(`/api/v1/telegram/publish/routes/${route.id}/deactivate`);
    assert.equal((deactivated.body as { route: { status: string } }).route.status, 'paused');
    const afterDeactivate = await server.sql('select 1 from routing_edges where route_id = $1', [route.id]);
    assert.equal(afterDeactivate.rowCount, 0);

    const reactivated = await h.api.post(`/api/v1/telegram/publish/routes/${route.id}/activate`);
    assert.equal(reactivated.status, 200, JSON.stringify(reactivated.body));
    const afterReactivate = await server.sql('select 1 from routing_edges where route_id = $1', [route.id]);
    assert.equal(afterReactivate.rowCount, 1);
  });
});
