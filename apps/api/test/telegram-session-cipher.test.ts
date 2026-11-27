/** اختبارات وحدة لتشفير جلسات MTProto — بلا قاعدة بيانات وبلا اتصال بشبكة. */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { containsPlaintext, decryptSession, encryptSession, isSessionCipherConfigured, SessionCipherError } from '../src/modules/telegram/sessionCipher.js';

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const SECRET_SESSION = '1BQANOTEuMTA4Ljg3LjE3OQBrZXktc2VjcmV0LXN0cmluZy1mb3ItdGVzdA==';
const PAYLOAD = {
  session: SECRET_SESSION,
  updateState: { pts: 1234, qts: 0, date: 1700000000, seq: 12, channels: { '123456': 77 } },
};

function freshEnv(
  overrides: { TG_SESSION_ENC_KEY?: string; TG_SESSION_ENC_KEY_PREVIOUS?: string; TG_SESSION_ENC_KEY_VERSION?: number } = {},
) {
  return {
    TG_SESSION_ENC_KEY: randomBytes(32).toString('base64'),
    TG_SESSION_ENC_KEY_PREVIOUS: undefined,
    TG_SESSION_ENC_KEY_VERSION: 1,
    ...overrides,
  } as never;
}

describe('تشفير جلسات تيليجرام', () => {
  it('يعيد الجلسة وحالة التحديثات كما هي بعد الفك', () => {
    const source = freshEnv();
    assert.equal(isSessionCipherConfigured(source as never), true);
    const { ciphertext, keyVersion } = encryptSession(ACCOUNT_A, PAYLOAD, source as never);
    const decrypted = decryptSession(ACCOUNT_A, ciphertext, source as never);
    assert.equal(decrypted.session, SECRET_SESSION);
    assert.deepEqual(decrypted.updateState, PAYLOAD.updateState);
    assert.equal(keyVersion, 1);
    assert.equal(decrypted.keyVersion, 1);
  });

  it('لا يحتوي النص المشفّر على الجلسة أو مقاطع منها', () => {
    const source = freshEnv();
    const { ciphertext } = encryptSession(ACCOUNT_A, PAYLOAD, source as never);
    assert.equal(containsPlaintext(ciphertext, SECRET_SESSION), false);
    assert.equal(containsPlaintext(ciphertext, 'key-secret-string'), false);
    assert.equal(ciphertext.includes(Buffer.from('pts')), false);
  });

  it('ينتج نصاً مشفّراً مختلفاً في كل مرة (IV عشوائي)', () => {
    const source = freshEnv();
    const a = encryptSession(ACCOUNT_A, PAYLOAD, source as never).ciphertext;
    const b = encryptSession(ACCOUNT_A, PAYLOAD, source as never).ciphertext;
    assert.notEqual(a.toString('base64'), b.toString('base64'));
    assert.equal(a.length, b.length);
  });

  it('يرفض فك الجلسة لحساب آخر (AAD مرتبط بمعرّف الحساب)', () => {
    const source = freshEnv();
    const { ciphertext } = encryptSession(ACCOUNT_A, PAYLOAD, source as never);
    assert.throws(
      () => decryptSession(ACCOUNT_B, ciphertext, source as never),
      (err: unknown) => err instanceof SessionCipherError && err.code === 'auth_failed',
    );
  });

  it('يكشف تعديل بايت واحد في المغلّف', () => {
    const source = freshEnv();
    const { ciphertext } = encryptSession(ACCOUNT_A, PAYLOAD, source as never);
    const tampered = Buffer.from(ciphertext);
    const target = tampered.length - 20;
    tampered[target] = tampered[target]! ^ 0xff;
    assert.throws(
      () => decryptSession(ACCOUNT_A, tampered, source as never),
      (err: unknown) => err instanceof SessionCipherError && err.code === 'auth_failed',
    );
  });

  it('يفك بمفتاح سابق أثناء تدوير المفاتيح', () => {
    const oldKey = randomBytes(32).toString('base64');
    const oldSource = freshEnv({ TG_SESSION_ENC_KEY: oldKey, TG_SESSION_ENC_KEY_VERSION: 1 });
    const { ciphertext, keyVersion } = encryptSession(ACCOUNT_A, PAYLOAD, oldSource);
    assert.equal(keyVersion, 1);

    const rotated = freshEnv({
      TG_SESSION_ENC_KEY: randomBytes(32).toString('base64'),
      TG_SESSION_ENC_KEY_VERSION: 2,
      TG_SESSION_ENC_KEY_PREVIOUS: oldKey,
    });
    const decrypted = decryptSession(ACCOUNT_A, ciphertext, rotated);
    assert.equal(decrypted.session, SECRET_SESSION);
    assert.equal(decrypted.keyVersion, 1);
  });

  it('يرفض العمل دون مفتاح تشفير', () => {
    const empty = { TG_SESSION_ENC_KEY: undefined, TG_SESSION_ENC_KEY_PREVIOUS: undefined, TG_SESSION_ENC_KEY_VERSION: 1 };
    assert.equal(isSessionCipherConfigured(empty as never), false);
    assert.throws(
      () => encryptSession(ACCOUNT_A, PAYLOAD, empty as never),
      (err: unknown) => err instanceof SessionCipherError && err.code === 'not_configured',
    );
  });

  it('يرفض مغلّفاً مقطوعاً أو بنسخة غير معروفة', () => {
    const source = freshEnv();
    const { ciphertext } = encryptSession(ACCOUNT_A, PAYLOAD, source as never);
    assert.throws(
      () => decryptSession(ACCOUNT_A, ciphertext.subarray(0, 20), source as never),
      (err: unknown) => err instanceof SessionCipherError && err.code === 'malformed',
    );
    const badVersion = Buffer.from(ciphertext);
    badVersion[0] = 9;
    assert.throws(
      () => decryptSession(ACCOUNT_A, badVersion, source as never),
      (err: unknown) => err instanceof SessionCipherError && err.code === 'malformed',
    );
  });
});
