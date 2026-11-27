/**
 * اختبارات وحدة لعميل Bot API — بلا شبكة حقيقية (fetch محقون).
 *
 * تغطي: ترجمة الاستجابات الناجحة، تصنيف الأخطاء (401/400/403/429/5xx/شبكة/مهلة)،
 * احترام retry_after، ومنع تسريب الرمز في أي رسالة خطأ.
 */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BotApiError,
  classifyBotApiFailure,
  HttpBotApiClient,
  redactToken,
} from '../src/modules/publishing/botApiClient.js';

const TOKEN = '987654321:AAFakeTokenForClientTests_0123456789';

interface Captured {
  url: string;
  body: unknown;
}

function clientWith(
  handler: (captured: Captured) => { status: number; payload: unknown } | Promise<never>,
  options: { timeoutMs?: number } = {},
): { client: HttpBotApiClient; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const item: Captured = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
    captured.push(item);
    const outcome = await handler(item);
    return new Response(JSON.stringify(outcome.payload), {
      status: outcome.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    client: new HttpBotApiClient({
      baseUrl: 'https://bot.test.local/',
      timeoutMs: options.timeoutMs ?? 1000,
      fetchImpl,
    }),
    captured,
  };
}

describe('عميل Bot API', () => {
  it('يقرأ هوية البوت من getMe ويستدعي المسار الصحيح', async () => {
    const { client, captured } = clientWith(() => ({
      status: 200,
      payload: { ok: true, result: { id: 123456789, username: 'publish_bot', first_name: 'ناشر' } },
    }));
    const identity = await client.getMe(TOKEN);
    assert.equal(identity.telegramId, '123456789');
    assert.equal(identity.username, 'publish_bot');
    assert.equal(captured[0]?.url, `https://bot.test.local/bot${TOKEN}/getMe`);
  });

  it('يصنّف القناة والمجموعة العظمى والمحادثة الخاصة', async () => {
    const cases: [string, string][] = [
      ['channel', 'channel'],
      ['supergroup', 'supergroup'],
      ['group', 'group'],
      ['private', 'private'],
    ];
    for (const [type, expected] of cases) {
      const { client } = clientWith(() => ({
        status: 200,
        payload: { ok: true, result: { id: -1001, type, title: 'قناة', username: 'ch' } },
      }));
      const chat = await client.getChat(TOKEN, '@ch');
      assert.equal(chat.kind, expected);
      assert.equal(chat.chatId, '-1001');
    }
  });

  it('يقرأ صلاحيات البوت من getChatMember', async () => {
    const { client, captured } = clientWith(() => ({
      status: 200,
      payload: {
        ok: true,
        result: { status: 'administrator', can_post_messages: true, can_edit_messages: false },
      },
    }));
    const member = await client.getChatMember(TOKEN, '-1001', '123456789');
    assert.deepEqual(member, { status: 'administrator', canPostMessages: true, canEditMessages: false });
    assert.deepEqual(captured[0]?.body, { chat_id: '-1001', user_id: '123456789' });
  });

  it('يحوّل 401 إلى invalid token بلا كشف الرمز', async () => {
    const { client } = clientWith(() => ({ status: 401, payload: { ok: false, error_code: 401, description: 'Unauthorized' } }));
    await assert.rejects(
      () => client.getMe(TOKEN),
      (err: unknown) => {
        assert.ok(err instanceof BotApiError);
        assert.equal(err.code, 'unauthorized');
        assert.equal(err.message.includes(TOKEN), false);
        return true;
      },
    );
  });

  it('ينقّي الرمز حتى لو ظهر في وصف الخطأ', async () => {
    const { client } = clientWith(() => ({
      status: 400,
      payload: { ok: false, error_code: 400, description: `Bad Request: invalid token ${TOKEN}` },
    }));
    await assert.rejects(
      () => client.getMe(TOKEN),
      (err: unknown) => {
        assert.ok(err instanceof BotApiError);
        assert.equal(err.message.includes(TOKEN), false);
        assert.ok(err.message.includes('[redacted]'));
        return true;
      },
    );
  });

  it('يحترم retry_after عند 429', async () => {
    const { client } = clientWith(() => ({
      status: 429,
      payload: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 17 } },
    }));
    await assert.rejects(
      () => client.getChat(TOKEN, '-1001'),
      (err: unknown) => {
        assert.ok(err instanceof BotApiError);
        assert.equal(err.code, 'flood_wait');
        assert.equal(err.retryAfterSeconds, 17);
        return true;
      },
    );
  });

  it('يصنّف 5xx كخطأ خادم و«chat not found» كوجهة غير موجودة', async () => {
    const server = clientWith(() => ({ status: 502, payload: { ok: false, description: 'Bad Gateway' } }));
    await assert.rejects(
      () => server.client.getChat(TOKEN, '-1001'),
      (err: unknown) => err instanceof BotApiError && err.code === 'server',
    );

    const notFound = clientWith(() => ({
      status: 400,
      payload: { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
    }));
    await assert.rejects(
      () => notFound.client.getChat(TOKEN, '-1001'),
      (err: unknown) => err instanceof BotApiError && err.code === 'chat_not_found',
    );
  });

  it('يصنّف فشل الاتصال والمهلة دون ادعاء نتيجة', async () => {
    const failing = new HttpBotApiClient({
      baseUrl: 'https://bot.test.local',
      timeoutMs: 50,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await assert.rejects(
      () => failing.getMe(TOKEN),
      (err: unknown) => err instanceof BotApiError && err.code === 'network' && err.httpStatus === null,
    );

    const timingOut = new HttpBotApiClient({
      baseUrl: 'https://bot.test.local',
      timeoutMs: 50,
      fetchImpl: (async () => {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }) as unknown as typeof fetch,
    });
    await assert.rejects(
      () => timingOut.getMe(TOKEN),
      (err: unknown) => err instanceof BotApiError && err.code === 'timeout',
    );
  });

  it('يرفض استجابة ناجحة بلا نتيجة بدل تخمينها', async () => {
    const { client } = clientWith(() => ({ status: 200, payload: { ok: true } }));
    await assert.rejects(
      () => client.getMe(TOKEN),
      (err: unknown) => err instanceof BotApiError && err.code === 'unknown',
    );
  });

  it('تصنيف الحالات ثابت ومستقل عن الشبكة', () => {
    assert.equal(classifyBotApiFailure(401, 'Unauthorized'), 'unauthorized');
    assert.equal(classifyBotApiFailure(429, 'Too Many Requests'), 'flood_wait');
    assert.equal(classifyBotApiFailure(503, 'Service Unavailable'), 'server');
    assert.equal(classifyBotApiFailure(400, 'Bad Request: not enough rights to send text messages'), 'forbidden');
    assert.equal(classifyBotApiFailure(403, 'Forbidden: bot is not a member of the channel chat'), 'forbidden');
    // 7-ج: «too long» تُصنَّف بنوعها لأنها تخصّ سياسة الطول لا طلباً مشوهاً.
    assert.equal(classifyBotApiFailure(400, 'Bad Request: message is too long'), 'too_long');
    assert.equal(redactToken(`token ${TOKEN} leaked`, TOKEN).includes(TOKEN), false);
  });
});
