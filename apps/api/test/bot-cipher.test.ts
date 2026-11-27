/**
 * اختبارات وحدة لمغلّف رموز بوتات النشر (Q1) — بلا قاعدة بيانات وبلا شبكة.
 *
 * تغطي: الذهاب والعودة، عدم ظهور الرمز في النص المشفّر، فصل المفتاح عن مفتاح الجلسات،
 * ربط AAD بمعرّف الصف، كشف التعديل، وبصمة الرمز، وتدوير المفاتيح، وغياب الإعداد.
 */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { containsPlaintext } from '../src/modules/telegram/sessionCipher.js';
import {
  BotCipherError,
  fingerprintBotToken,
  isBotCipherConfigured,
  openBotToken,
  readBotKeyring,
  sealBotToken,
} from '../src/modules/publishing/botCipher.js';

const BOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_BOT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN = '123456789:AAHfakeTokenForTestsOnly_0123456789abc';

function freshEnv(
  overrides: { TG_BOT_ENC_KEY?: string; TG_BOT_ENC_KEY_PREVIOUS?: string; TG_BOT_ENC_KEY_VERSION?: number } = {},
) {
  return {
    TG_BOT_ENC_KEY: randomBytes(32).toString('base64'),
    TG_BOT_ENC_KEY_PREVIOUS: undefined,
    TG_BOT_ENC_KEY_VERSION: 1,
    ...overrides,
  } as never;
}

describe('تشفير رموز بوتات النشر', () => {
  it('يعيد الرمز كما هو بعد الفك', () => {
    const source = freshEnv();
    const sealed = sealBotToken(BOT_ID, TOKEN, source);
    assert.equal(sealed.keyVersion, 1);
    const opened = openBotToken(BOT_ID, sealed.ciphertext, source);
    assert.equal(opened.token, TOKEN);
    assert.equal(opened.keyVersion, 1);
  });

  it('لا يحتوي النص المشفّر على الرمز أو مقاطع منه', () => {
    const source = freshEnv();
    const { ciphertext } = sealBotToken(BOT_ID, TOKEN, source);
    assert.equal(containsPlaintext(ciphertext, TOKEN), false);
    assert.equal(containsPlaintext(ciphertext, TOKEN.split(':')[1]!), false);
  });

  it('يرفض فك المغلّف بمعرّف صف آخر (ربط AAD)', () => {
    const source = freshEnv();
    const { ciphertext } = sealBotToken(BOT_ID, TOKEN, source);
    assert.throws(
      () => openBotToken(OTHER_BOT_ID, ciphertext, source),
      (err: unknown) => err instanceof BotCipherError && err.code === 'auth_failed',
    );
  });

  it('يكشف تعديل بايت واحد في المغلّف', () => {
    const source = freshEnv();
    const { ciphertext } = sealBotToken(BOT_ID, TOKEN, source);
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 20] ^= 0xff;
    assert.throws(
      () => openBotToken(BOT_ID, tampered, source),
      (err: unknown) => err instanceof BotCipherError && err.code === 'auth_failed',
    );
  });

  it('لا يفتح مغلّف بوت بمفتاح جلسات مختلف (مفتاح مستقل)', () => {
    const botSource = freshEnv();
    const { ciphertext } = sealBotToken(BOT_ID, TOKEN, botSource);
    const otherSource = freshEnv();
    assert.throws(
      () => openBotToken(BOT_ID, ciphertext, otherSource),
      (err: unknown) => err instanceof BotCipherError && err.code === 'auth_failed',
    );
  });

  it('يفك المغلّف القديم بعد تدوير المفتاح (مفتاح سابق للفك فقط)', () => {
    const oldKey = randomBytes(32).toString('base64');
    const sealed = sealBotToken(BOT_ID, TOKEN, freshEnv({ TG_BOT_ENC_KEY: oldKey, TG_BOT_ENC_KEY_VERSION: 1 }));
    const rotated = freshEnv({
      TG_BOT_ENC_KEY: randomBytes(32).toString('base64'),
      TG_BOT_ENC_KEY_PREVIOUS: oldKey,
      TG_BOT_ENC_KEY_VERSION: 2,
    });
    const opened = openBotToken(BOT_ID, sealed.ciphertext, rotated);
    assert.equal(opened.token, TOKEN);
    // المغلّف الجديد يستخدم النسخة 2.
    const fresh = sealBotToken(BOT_ID, TOKEN, rotated);
    assert.equal(fresh.keyVersion, 2);
  });

  it('يرفض مفتاحاً سابقاً مع النسخة 1 ويرفض مفتاحاً بطول خاطئ', () => {
    assert.throws(
      () => readBotKeyring(freshEnv({ TG_BOT_ENC_KEY_PREVIOUS: randomBytes(32).toString('base64') })),
      (err: unknown) => err instanceof BotCipherError && err.code === 'not_configured',
    );
    assert.throws(
      () => readBotKeyring({ TG_BOT_ENC_KEY: randomBytes(16).toString('base64'), TG_BOT_ENC_KEY_VERSION: 1 } as never),
      (err: unknown) => err instanceof BotCipherError && err.code === 'not_configured',
    );
  });

  it('يعلن عدم الإعداد عند غياب المفتاح ولا يخمّن', () => {
    const empty = { TG_BOT_ENC_KEY: undefined, TG_BOT_ENC_KEY_PREVIOUS: undefined, TG_BOT_ENC_KEY_VERSION: 1 } as never;
    assert.equal(isBotCipherConfigured(empty), false);
    assert.deepEqual(readBotKeyring(empty), []);
    assert.throws(
      () => sealBotToken(BOT_ID, TOKEN, empty),
      (err: unknown) => err instanceof BotCipherError && err.code === 'not_configured',
    );
  });

  it('بصمة الرمز ثابتة بحسب المحتوى ولا تكشفه', () => {
    const first = fingerprintBotToken(TOKEN);
    const second = fingerprintBotToken(TOKEN);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.notEqual(first, fingerprintBotToken(`${TOKEN}x`));
    assert.equal(first.includes(TOKEN), false);
  });
});
