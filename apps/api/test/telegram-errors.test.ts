/** اختبارات وحدة لتصنيف أخطاء Telegram والتأخير الأسّي. */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FloodWaitError } from 'teleproto/errors';
import { backoffDelayMs, classifyTelegramError } from '../src/modules/telegram/errors.js';

function rpcError(code: number, name: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(name), { name, code, ...extra });
}

describe('تصنيف أخطاء Telegram', () => {
  it('يصنّف FloodWaitError الحقيقي من المكتبة ويقرأ الثواني', () => {
    const err = new FloodWaitError({ request: {} as never, capture: 42 });
    const classified = classifyTelegramError(err);
    assert.equal(classified.kind, 'flood_wait');
    assert.equal(classified.code, 'FLOOD_WAIT');
    assert.equal(classified.waitSeconds, 42);
    assert.equal(classified.retryable, false);
  });

  it('يصنّف خطأ 420 المحاكى كاننتظار إجباري', () => {
    const classified = classifyTelegramError(rpcError(420, 'FloodWaitError', { seconds: 90 }));
    assert.equal(classified.kind, 'flood_wait');
    assert.equal(classified.waitSeconds, 90);
  });

  it('يصنّف إبطال الجلسة كحاجة لإعادة دخول دون إعادة محاولة', () => {
    for (const code of ['SESSION_REVOKED', 'AUTH_KEY_UNREGISTERED']) {
      const err = Object.assign(new Error(code), { name: code === 'SESSION_REVOKED' ? 'SessionRevokedError' : 'AuthKeyUnregisteredError', code: 401 });
      const classified = classifyTelegramError(err);
      assert.equal(classified.kind, 'auth_revoked');
      assert.equal(classified.retryable, false);
      assert.equal(classified.needsUserAction, true);
    }
  });

  it('يصنّف أخطاء الشبكة كقابلة لإعادة المحاولة', () => {
    for (const err of [
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('Connection closed'), { name: 'ConnectionError' }),
    ]) {
      const classified = classifyTelegramError(err);
      assert.equal(classified.kind, 'network');
      assert.equal(classified.retryable, true);
    }
  });

  it('يصنّف رفض RPC 4xx كغير قابل لإعادة المحاولة', () => {
    const classified = classifyTelegramError(rpcError(400, 'ChatIdInvalidError'));
    assert.equal(classified.kind, 'rpc');
    assert.equal(classified.retryable, false);
  });

  it('يصنّف الخطأ المجهول بأمان دون إعادة محاولة', () => {
    const classified = classifyTelegramError(new Error('something odd'));
    assert.equal(classified.kind, 'unknown');
    assert.equal(classified.retryable, false);
  });
});

describe('التأخير الأسّي', () => {
  it('ينمو ويبقى ضمن السقف', () => {
    const first = backoffDelayMs(1, 1000);
    const second = backoffDelayMs(2, 1000);
    const capped = backoffDelayMs(20, 1000);
    assert.ok(first >= 1000 && first <= 1200);
    assert.ok(second >= 2000 && second <= 2400);
    assert.equal(capped <= 60_000, true);
  });
});
