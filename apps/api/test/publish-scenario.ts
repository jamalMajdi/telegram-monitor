/**
 * سيناريو نشر جاهز لاختبارات 7-ج/7-د: مستخدم + حساب محاكاة + مصدر + بوت + وجهة + مسار.
 *
 * قاعدة PostgreSQL حقيقية + بوابة محاكاة + عميل Bot API مزيّف: لا شبكة ولا رموز حقيقية.
 * الغرض: إزالة تكرار التهيئة بين اختبارات التخطيط والإرسال والمراجعة.
 */
import assert from 'node:assert/strict';
import { client, type TestClient, type TestServer } from './harness.js';
import { fakeSource, type FakeAccountClient, type FakeGateway } from './telegram-fakes.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { IncomingTextMessage } from '../src/modules/telegram/gateway.js';

export interface ScenarioHarness {
  api: TestClient;
  accountId: string;
  sourceId: string;
  peerId: string;
  destinationId: string;
  destinationChatId: string;
  botTelegramId: string;
  userId: string;
  email: string;
}

export interface ScenarioContext {
  server: TestServer;
  gateway: FakeGateway;
  botApi: FakeBotApiClient;
  makeToken: (seed: number) => string;
  password?: string;
}

export class PublishScenario {
  private counter = 0;
  private messageId = 4000;
  private readonly password: string;
  /**
   * بصمة عشوائية لكل مثيل سيناريو: الملفات تعمل بالتوازي على نفس قاعدة البيانات،
   * فالبريد/الهاتف/معرّفات تيليجرام المشتركة كانت تتصادم (409) بين ملفات الاختبار.
   */
  private readonly salt: number;

  constructor(private readonly ctx: ScenarioContext) {
    this.password = ctx.password ?? 'CorrectHorse123';
    this.salt = Math.floor(Math.random() * 9000);
  }

  /** مستخدم كامل: حساب مرتبط + مصدر مراقب + بوت + وجهة فعّالة. */
  async create(): Promise<ScenarioHarness> {
    const { server, gateway, botApi, makeToken } = this.ctx;
    this.counter += 1;
    const counter = this.counter;

    const api = client(server.baseUrl);
    const email = `publish${this.salt}_${counter}@example.test`;
    const registered = await api.post('/api/v1/auth/register', {
      email,
      displayName: `مستخدم نشر ${counter}`,
      password: this.password,
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));

    const telegramUserId = String(430000 + this.salt * 10 + counter);
    gateway.outcomeSelf = { id: telegramUserId, username: `publish_${telegramUserId}` };
    gateway.loginBehaviours.push({ submitCode: () => ({ status: 'authorized', self: { id: telegramUserId } }) });
    const started = await api.post('/api/v1/telegram/accounts', { phoneNumber: `+9677${telegramUserId}` });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const accountId = (started.body as { account: { id: string } }).account.id;
    const verified = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: '12345' });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));

    const peerId = String(8800000 + this.salt * 10 + counter);
    gateway.sourceConfig.resolved.set(
      peerId,
      fakeSource({ peerId, title: `قناة ${peerId}`, username: `pub_src_${peerId}` }),
    );
    const source = await api.post('/api/v1/telegram/sources', { accountId, peerId });
    assert.equal(source.status, 201, JSON.stringify(source.body));
    const sourceId = (source.body as { source: { id: string } }).source.id;

    const token = makeToken(900 + this.salt * 10 + counter);
    const botTelegramId = String(9600000 + this.salt * 10 + counter);
    botApi.addBot(token, { telegramId: botTelegramId, username: `pub_bot_${counter}`, firstName: 'ناشر' });
    const bot = await api.post('/api/v1/telegram/publish/bot', { token });
    assert.equal(bot.status, 201, JSON.stringify(bot.body));

    const destinationChatId = String(-1008880000000 - counter);
    const key = `@pub_dest_${counter}`;
    botApi.addChat(key, {
      chatId: destinationChatId,
      kind: 'channel',
      title: `وجهة ${counter}`,
      username: key.slice(1),
    });
    botApi.setMember(destinationChatId, botTelegramId, {
      status: 'administrator',
      canPostMessages: true,
      canEditMessages: false,
    });
    const destination = await api.post('/api/v1/telegram/publish/destinations', { identifier: key });
    assert.equal(destination.status, 201, JSON.stringify(destination.body));
    const destinationId = (destination.body as { destination: { id: string } }).destination.id;

    const row = await server.sql<{ user_id: string }>('select user_id from telegram_sources where id = $1', [
      sourceId,
    ]);
    return {
      api,
      accountId,
      sourceId,
      peerId,
      destinationId,
      destinationChatId,
      botTelegramId,
      userId: row.rows[0]!.user_id,
      email,
    };
  }

  private liveClient(accountId: string): FakeAccountClient {
    const found = this.ctx.gateway.created.filter((c) => c.accountId === accountId && c.subscribers.size > 0);
    assert.ok(found.length > 0, 'يجب أن يكون هناك عميل محاكاة متصل');
    return found[found.length - 1]!;
  }

  /**
   * يبثّ رسالة من المصدر وينتظر ظهور هويتها في قاعدة البيانات.
   * `sender` اختياري: هوية المرسل كما تصل من MTProto (تُستخدم لاختبار تذييل الهوية).
   */
  async emit(h: ScenarioHarness, text: string, sender?: IncomingTextMessage['sender']): Promise<string> {
    this.messageId += 1;
    const telegramMessageId = this.messageId;
    await this.liveClient(h.accountId).emit({
      accountId: h.accountId,
      peerKey: `channel:${h.peerId}`,
      peerKind: 'channel',
      messageId: telegramMessageId,
      text,
      caption: '',
      hasMedia: false,
      ...(sender ? { sender } : {}),
    } satisfies IncomingTextMessage);
    const res = await this.ctx.server.sql<{ id: string }>(
      'select id from message_identity where source_id = $1 and telegram_message_id = $2',
      [h.sourceId, telegramMessageId],
    );
    assert.equal(res.rows.length, 1, 'يجب أن تُسجَّل هوية الرسالة');
    return res.rows[0]!.id;
  }

  async route(
    h: ScenarioHarness,
    options: {
      lengthPolicy?: 'split' | 'reject';
      maxParts?: number;
      publishMode?: 'auto' | 'review';
      attributionMode?: 'off' | 'source' | 'sender' | 'both' | null;
    } = {},
  ): Promise<string> {
    const res = await h.api.post('/api/v1/telegram/publish/routes', {
      name: `مسار ${h.email}`,
      destinationId: h.destinationId,
      scopes: [{ kind: 'source', targetId: h.sourceId }],
      ...(options.lengthPolicy ? { lengthPolicy: options.lengthPolicy } : {}),
      ...(options.maxParts ? { maxParts: options.maxParts } : {}),
      ...(options.publishMode ? { publishMode: options.publishMode } : {}),
      ...(options.attributionMode !== undefined ? { attributionMode: options.attributionMode } : {}),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const route = (res.body as { route: { id: string } }).route;
    const activated = await h.api.post(`/api/v1/telegram/publish/routes/${route.id}/activate`);
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    return route.id;
  }
}
