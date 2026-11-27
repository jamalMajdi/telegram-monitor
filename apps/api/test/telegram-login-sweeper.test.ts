/**
 * تدقيق 2026-11-26 — تسرّب ذاكرة في مسار الربط (Login).
 *
 * **الخلل الذي كان قائماً:** كل محاولة ربط تُنشئ عميل MTProto مستقلاً في `clients`،
 * ولا يُفصل إلا عند النجاح أو الفشل أو الإلغاء أو إيقاف الخادم. من يبدأ الربط ويغلق
 * الصفحة (أو تنتهي صلاحية محاولته) كان يترك اتصالاً حيّاً في الذاكرة إلى الأبد ⇒
 * نموّ لا نهائي بعدد المحاولات المهجورة.
 *
 * **الإصلاح:** `sweepIdleClients()` يُفصل كل عميل تجاوز (مدة صلاحية المحاولة + دقيقة)،
 * ومُشغّل دوري (دقيقة) يستدعيه. كما صار `KeyedLock` يُحرّر مفاتيحه عند انتهاء السلسلة.
 */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedLock, TelegramLoginService, type LoginServiceDeps } from '../src/modules/telegram/loginService.js';
import type { LoginChallengeStore, LoginChallenge } from '../src/modules/telegram/loginChallengeStore.js';
import type { TelegramAccountStore } from '../src/modules/telegram/accountRepository.js';
import { FakeGateway } from './telegram-fakes.js';

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
    createPendingAccount: async (input: { userId: string; label: string }) => ({
      id: ACCOUNT_ID,
      userId: input.userId,
      label: input.label,
      status: 'pending' as const,
      telegramUserId: null,
      telegramUsername: null,
    }),
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
    start: async (input) => ({ ...challengeAt(input.expiresAt), id: '44444444-4444-4444-8444-444444444444' }),
    findActive: async () => challenge,
    update: async () => undefined,
    registerAttempt: async () => 1,
    registerResend: async () => 1,
    consume: async () => undefined,
    closeAll: async () => undefined,
  };
}

function challengeAt(expiresAt: Date): LoginChallenge {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    accountId: ACCOUNT_ID,
    userId: USER_ID,
    stage: 'code',
    codeAttempts: 0,
    passwordAttempts: 0,
    resends: 0,
    expiresAt,
    createdAt: new Date(expiresAt.getTime() - 600_000),
    payload: { tempSession: '', phone: '+967000000000' },
  } as unknown as LoginChallenge;
}

function makeService(options: { now?: () => number } = {}) {
  const gateway = new FakeGateway();
  const service = new TelegramLoginService({
    gateway,
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
    ...(options.now ? { now: options.now } : {}),
  } as Partial<LoginServiceDeps> as LoginServiceDeps);
  return { service, gateway };
}

/** يُسجّل عميل مصادقة كما يفعل مسار الربط (getClient داخلي، نستخدمه مباشرة في الاختبار). */
async function registerClient(service: TelegramLoginService) {
  const internals = service as unknown as { getClient(accountId: string, session: string): Promise<unknown> };
  return internals.getClient(ACCOUNT_ID, '');
}

describe('تنظيف عملاء المصادقة المهجورين', () => {
  it('عميل حديث لا يُفصل', async () => {
    let clock = 1_000_000;
    const { service, gateway } = makeService({ now: () => clock });
    await registerClient(service);
    assert.equal(service.openClients, 1, 'العميل مُسجَّل');

    clock += 2 * 60_000; // داخل الصلاحية (10 دقائق)
    assert.equal(await service.sweepIdleClients(), 0, 'لا تنظيف داخل الصلاحية');
    assert.equal(gateway.loginCreated[0]!.disconnectCalls, 0);
    assert.equal(service.openClients, 1);
  });

  it('عميل مهجور يتجاوز الصلاحية + دقيقة يُفصل ويُزاح من الذاكرة', async () => {
    let clock = 5_000_000;
    const { service, gateway } = makeService({ now: () => clock });
    await registerClient(service);
    assert.equal(service.openClients, 1);

    const client = gateway.loginCreated[0]!;
    clock += 11 * 60_000 + 30_000; // تجاوز 10 دقائق + دقيقة سماح
    assert.equal(await service.sweepIdleClients(), 1, 'عميل واحد مهجور');
    assert.equal(client.disconnectCalls, 1, 'الاتصال أُغلق فعلاً');
    assert.equal(service.openClients, 0, 'أُزيح من الذاكرة');
    // التنظيف الثاني لا يجد شيئاً (لا عمليات متكررة).
    assert.equal(await service.sweepIdleClients(), 0);
  });

  it('عميل يُستخدم باستمرار لا يُفصل ولو طال الزمن', async () => {
    let clock = 9_000_000;
    const { service, gateway } = makeService({ now: () => clock });
    // أول تسجيل ثم استخدام متكرر (كل استخدام يُحدّث الطابع الزمني عبر getClient).
    await registerClient(service);
    for (let i = 0; i < 5; i += 1) {
      clock += 5 * 60_000;
      await registerClient(service); // عميل موجود ⇒ يُعاد نفسه ويُحدَّث استخدامه
      assert.equal(await service.sweepIdleClients(), 0, 'لا فصل لعميل قيد الاستخدام');
    }
    assert.equal(service.openClients, 1);
    assert.equal(gateway.loginCreated.length, 1, 'لا عملاء مكررون للحساب نفسه');
  });

  it('المُشغّل الدوري يبدأ ويتوقف بلا مؤقّتات باقية', async () => {
    const { service } = makeService();
    service.startSweeper(20);
    const first = (service as unknown as { sweeperTimer: NodeJS.Timeout | null }).sweeperTimer;
    assert.ok(first, 'المؤقّت بدأ');
    service.startSweeper(20);
    assert.equal(
      (service as unknown as { sweeperTimer: NodeJS.Timeout | null }).sweeperTimer,
      first,
      'بدء ثانٍ لا يُنشئ مؤقّتاً ثانياً',
    );
    service.stopSweeper();
    assert.equal((service as unknown as { sweeperTimer: NodeJS.Timeout | null }).sweeperTimer, null);
  });
});

describe('KeyedLock — لا نموّ لا نهائي', () => {
  it('يحرّر المفتاح بعد انتهاء السلسلة', async () => {
    const lock = new KeyedLock();
    await lock.run('a', async () => 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(lock.activeKeys, 0, 'لا مفاتيح معلّقة بعد الانتهاء');
  });

  it('يبقي التسلسل صحيحاً ولا يخلط المفاتيح', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    await Promise.all([
      lock.run('x', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('x1');
      }),
      lock.run('x', async () => {
        order.push('x2');
      }),
      lock.run('y', async () => {
        order.push('y1');
      }),
    ]);
    assert.deepEqual(order.slice(0, 1), ['y1'], 'مفتاح آخر لا ينتظر مفتاح x');
    assert.deepEqual(order.filter((v) => v.startsWith('x')), ['x1', 'x2'], 'ترتيب نفس المفتاح محفوظ');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(lock.activeKeys, 0);
  });
});
