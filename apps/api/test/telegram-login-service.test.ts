/**
 * اختبارات وحدة لخدمة الربط بلا قاعدة بيانات وبلا شبكة:
 * التركيز على التهيئة الغائبة، وصلاحية المحاولة، وفصل مجالات التشفير.
 */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramLoginService, TelegramNotConfiguredError, type LoginServiceDeps } from '../src/modules/telegram/loginService.js';
import type { LoginChallengeStore, LoginChallenge, LoginChallengePayload } from '../src/modules/telegram/loginChallengeStore.js';
import type { TelegramAccountStore } from '../src/modules/telegram/accountRepository.js';
import { hashPhoneNumber, normalizePhoneNumber, InvalidPhoneNumberError } from '../src/modules/telegram/phone.js';
import { openPayload, sealPayload } from '../src/modules/telegram/sessionCipher.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

function stubAccounts(): TelegramAccountStore {
  return {
    findOwned: async () => ({
      id: ACCOUNT_ID,
      userId: USER_ID,
      label: 'حساب اختبار',
      status: 'active',
      telegramUserId: '777',
      telegramUsername: null,
    }),
    listByUser: async () => [],
    createPendingAccount: async () => {
      throw new Error('غير متوقع في هذا الاختبار');
    },
    setPhoneHash: async () => undefined,
    findByPhoneHash: async () => null,
    markActive: async () => undefined,
    markRevoked: async () => undefined,
    deletePendingAccount: async () => undefined,
    listAccountsForRestore: async () => [],
  };
}

function stubChallenges(challenge: LoginChallenge | null): LoginChallengeStore {
  return {
    start: async () => {
      throw new Error('غير متوقع في هذا الاختبار');
    },
    findActive: async () => challenge,
    update: async () => undefined,
    registerAttempt: async () => 1,
    registerResend: async () => 1,
    consume: async () => undefined,
    closeAll: async () => undefined,
  };
}

function service(overrides: Partial<LoginServiceDeps> = {}): TelegramLoginService {
  return new TelegramLoginService({
    gateway: null,
    accounts: stubAccounts(),
    challenges: stubChallenges(null),
    connections: null,
    limits: {
      ttlMinutes: 10,
      maxCodeAttempts: 5,
      maxPasswordAttempts: 3,
      maxResends: 3,
      resendIntervalSeconds: 30,
    },
    ...overrides,
  });
}

describe('خدمة ربط الحسابات (وحدة)', () => {
  it('ترفض بدء الربط عندما يكون التكامل غير مهيأ', async () => {
    await assert.rejects(
      () => service().startLink({ userId: USER_ID, phoneNumber: '+967771234567' }),
      (err: unknown) => err instanceof TelegramNotConfiguredError && err.status === 503,
    );
  });

  it('ترفض الأرقام غير الدولية قبل أي اتصال', async () => {
    assert.throws(() => normalizePhoneNumber('0771234567'), InvalidPhoneNumberError);
    assert.equal(normalizePhoneNumber('+967 77 123 4567'), '+967771234567');
  });

  it('تنتج بصمة ثابتة لا تكشف الرقم', () => {
    const normalized = normalizePhoneNumber('+967771234567');
    const first = hashPhoneNumber(normalized);
    const second = hashPhoneNumber(normalized);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first.includes('967'), false);
    assert.notEqual(first, hashPhoneNumber(normalizePhoneNumber('+967771234568')));
  });

  it('تعامل المحاولة المنتهية كمنتهية حتى لو بقيت في القاعدة', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const challenge: LoginChallenge = {
      id: '33333333-3333-4333-8333-333333333333',
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      stage: 'code',
      payload: { phoneNumber: '+967771234567', phoneCodeHash: 'hash', tempSession: '' },
      codeAttempts: 0,
      passwordAttempts: 0,
      resendCount: 0,
      lastSentAt: new Date(now - 60_000),
      expiresAt: new Date(now - 1_000),
    };
    const svc = service({ challenges: stubChallenges(challenge), now: () => now });
    await assert.rejects(
      () => svc.verifyCode({ userId: USER_ID, accountId: ACCOUNT_ID, code: '12345' }),
      (err: unknown) => (err as { code?: string }).code === 'challenge_expired',
    );
  });

  it('يمنع فك مغلّف محاولة الربط كجلسة MTProto (فصل AAD)', () => {
    const payload: LoginChallengePayload = {
      phoneNumber: '+967771234567',
      phoneCodeHash: 'secret-hash',
      tempSession: 'temp-session',
    };
    const sealed = sealPayload('login', ACCOUNT_ID, payload);
    const opened = openPayload<LoginChallengePayload>('login', ACCOUNT_ID, sealed.ciphertext);
    assert.equal(opened.value.phoneCodeHash, 'secret-hash');
    assert.throws(() => openPayload('session', ACCOUNT_ID, sealed.ciphertext));
    assert.throws(() => openPayload('login', USER_ID, sealed.ciphertext));
    assert.equal(sealed.ciphertext.includes(Buffer.from('secret-hash', 'utf8')), false);
  });
});
