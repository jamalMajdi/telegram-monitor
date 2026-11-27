/**
 * اختبارات اتصال **حقيقي** بـ Telegram MTProto — تتطلب بيانات اعتماد مصرحاً بها.
 * لا تُزوَّر نتائجها: إذا غابت البيانات تُعلَّم كمتجاوزة مع بيان ما ينقص.
 *
 * المتغيرات المطلوبة:
 *   TG_LIVE_API_ID, TG_LIVE_API_HASH   بيانات تطبيق من my.telegram.org
 *   TG_LIVE_SESSION                    جلسة StringSession مصرّح بها (إلزامية للاتصال)
 *   TG_LIVE_LISTEN_SECONDS             مدة الاستماع (افتراضي 15)
 */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TeleprotoGateway } from '../src/modules/telegram/teleprotoGateway.js';
import { classifyTelegramError } from '../src/modules/telegram/errors.js';
import { decryptSession, encryptSession } from '../src/modules/telegram/sessionCipher.js';
import type { IncomingTextMessage } from '../src/modules/telegram/gateway.js';

const apiId = Number(process.env.TG_LIVE_API_ID ?? '');
const apiHash = process.env.TG_LIVE_API_HASH ?? '';
const sessionString = process.env.TG_LIVE_SESSION ?? '';
const listenSeconds = Number(process.env.TG_LIVE_LISTEN_SECONDS ?? '15');

const missing: string[] = [];
if (!apiId) missing.push('TG_LIVE_API_ID');
if (!apiHash) missing.push('TG_LIVE_API_HASH');
if (!sessionString) missing.push('TG_LIVE_SESSION');
const skipReason =
  missing.length > 0
    ? `اختبار اتصال حقيقي متجاوز: لا توجد بيانات اعتماد (${missing.join(', ')}). لا يُدّعى نجاح اتصال.`
    : false;

if (skipReason) console.log(`[live] ${skipReason}`);

function makeGateway(): TeleprotoGateway {
  return new TeleprotoGateway({
    apiId,
    apiHash,
    testServers: process.env.TG_LIVE_TEST_SERVERS === 'true',
    catchUp: true,
    connectionRetries: 2,
    floodSleepThreshold: 0,
  });
}

describe('اتصال حقيقي بـ Telegram MTProto', () => {
  it('يتصل ويصادق على الجلسة ويعيد هوية الحساب', { skip: skipReason }, async () => {
    const gateway = makeGateway();
    const client = gateway.createAccountClient({ accountId: 'live-check', savedSession: sessionString });
    try {
      const outcome = await client.connect();
      assert.equal(outcome.authorized, true, 'الجلسة يجب أن تكون مصرّحة');
      assert.ok(outcome.self?.id, 'يجب أن تعود هوية الحساب');
      const self = await client.getSelf();
      assert.equal(self?.id, outcome.self?.id);
    } catch (err) {
      const classified = classifyTelegramError(err);
      assert.fail(`فشل الاتصال الحقيقي: ${classified.kind}/${classified.code}`);
    } finally {
      await client.disconnect();
    }
  });

  it('يستقبل تحديثات نصية فعلية خلال مدة الاستماع', { skip: skipReason }, async () => {
    const gateway = makeGateway();
    const client = gateway.createAccountClient({ accountId: 'live-listen', savedSession: sessionString });
    const received: IncomingTextMessage[] = [];
    try {
      const outcome = await client.connect();
      assert.equal(outcome.authorized, true);
      client.onIncomingText((message) => received.push(message));
      await new Promise((resolve) => setTimeout(resolve, listenSeconds * 1000));
      // لا يمكن ضمان وجود رسائل في أي نافذة زمنية؛ يُسجَّل العدد الفعلي دون ادعاء.
      console.log(`[live] رسائل نصية مستلمة خلال ${listenSeconds}s: ${received.length}`);
      for (const message of received) {
        assert.equal(message.accountId, 'live-listen');
        assert.ok(message.text.length > 0 || message.caption.length > 0);
        assert.ok(message.peerKey.length > 0);
      }
    } finally {
      await client.disconnect();
    }
  });

  it('يعيد الاتصال بعد قطع متعمّد ثم يستعيد الجلسة', { skip: skipReason }, async () => {
    const gateway = makeGateway();
    const client = gateway.createAccountClient({ accountId: 'live-reconnect', savedSession: sessionString });
    try {
      const first = await client.connect();
      assert.equal(first.authorized, true);
      await client.disconnect();
      const second = await client.connect();
      assert.equal(second.authorized, true, 'إعادة الاتصال بالجلسة المحفوظة يجب أن تنجح');
    } finally {
      await client.disconnect();
    }
  });

  it('يحفظ الجلسة الحقيقية ويستعيدها من المغلّف المشفّر', { skip: skipReason }, async () => {
    const gateway = makeGateway();
    const client = gateway.createAccountClient({ accountId: '11111111-1111-4111-8111-111111111111', savedSession: sessionString });
    try {
      await client.connect();
      const snapshot = client.exportSession();
      assert.ok(snapshot.session.length > 10);
      const envelope = encryptSession('11111111-1111-4111-8111-111111111111', snapshot);
      const restored = decryptSession('11111111-1111-4111-8111-111111111111', envelope.ciphertext);
      assert.equal(restored.session, snapshot.session);

      const restoredClient = gateway.createAccountClient({
        accountId: '11111111-1111-4111-8111-111111111111',
        savedSession: restored.session,
      });
      try {
        const outcome = await restoredClient.connect();
        assert.equal(outcome.authorized, true, 'الجلسة المستعادة من التشفير يجب أن تعمل');
      } finally {
        await restoredClient.disconnect();
      }
    } finally {
      await client.disconnect();
    }
  });
});
