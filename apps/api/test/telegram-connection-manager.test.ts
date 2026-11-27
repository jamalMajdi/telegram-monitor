/**
 * اختبارات مدير اتصالات تيليجرام بمحاكاة كاملة (لا اتصال حقيقي، لا قاعدة بيانات).
 * تتحقق من: دورة الحياة، حدود إعادة المحاولة، FloodWait، إبطال الجلسة،
 * عزل الحسابات، حفظ الجلسة، وتوجيه الرسائل.
 */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramConnectionManager } from '../src/modules/telegram/connectionManager.js';
import { FakeGateway, FakeRepository } from './telegram-fakes.js';
import type { IncomingTextMessage } from '../src/modules/telegram/gateway.js';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACC_1 = '11111111-1111-4111-8111-111111111111';
const ACC_2 = '22222222-2222-4222-8222-222222222222';

const ok = async () => ({ authorized: true, self: { id: '999', username: 'fake_user' } });

function floodWait(seconds: number) {
  return Object.assign(new Error('FLOOD_WAIT'), { name: 'FloodWaitError', code: 420, seconds });
}
function sessionRevoked() {
  return Object.assign(new Error('SESSION_REVOKED'), { name: 'SessionRevokedError', code: 401 });
}
function networkError() {
  return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
}

function setup(
  options: {
    behaviours?: Array<() => Promise<{ authorized: boolean; self: { id: string; username?: string } | null }>>;
    maxReconnectAttempts?: number;
    onMessage?: (m: IncomingTextMessage) => void;
    persistDelayMs?: number;
  } = {},
) {
  const repository = new FakeRepository();
  repository.addAccount({ id: ACC_1, userId: USER_A });
  repository.addAccount({ id: ACC_2, userId: USER_B });
  const gateway = new FakeGateway(options.behaviours ?? []);
  const sleeps: number[] = [];
  const manager = new TelegramConnectionManager({
    gateway,
    repository,
    onMessage: options.onMessage,
    persistDelayMs: options.persistDelayMs ?? 5,
    maxReconnectAttempts: options.maxReconnectAttempts ?? 3,
    reconnectBaseDelayMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { manager, gateway, repository, sleeps };
}

describe('مدير اتصالات تيليجرام — الاتصال الناجح', () => {
  it('يتصل ويحفظ الجلسة ويحدّث حالة الحساب', async () => {
    const { manager, gateway, repository } = setup({ behaviours: [ok] });
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.phase, 'connected');
    assert.equal(state.attempts, 1);
    assert.ok(state.connectedAt instanceof Date);
    assert.equal(repository.markConnectedCalls, 1);
    assert.equal(repository.saveSessionCalls, 1);
    assert.equal(repository.sessions.get(ACC_1)?.session, `fake-session-${ACC_1}`);
    assert.equal(gateway.created.length, 1);
    await manager.disconnectAll();
  });

  it('لا يفتح عميلاً ثانياً عند إعادة طلب الاتصال لنفس الحساب', async () => {
    const { manager, gateway } = setup();
    await manager.connect(ACC_1, USER_A);
    const again = await manager.connect(ACC_1, USER_A);
    assert.equal(again.phase, 'connected');
    assert.equal(gateway.created.length, 1);
    await manager.disconnectAll();
  });
});

describe('مدير اتصالات تيليجرام — الأخطاء والحدود', () => {
  it('يوقف المحاولات وينتقل إلى needs_reauth عند إبطال الجلسة دون إعادة محاولة', async () => {
    const { manager, gateway, repository, sleeps } = setup({
      behaviours: [async () => { throw sessionRevoked(); }],
    });
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.phase, 'needs_reauth');
    assert.equal(state.lastErrorKind, 'auth_revoked');
    assert.equal(state.attempts, 1);
    assert.equal(sleeps.length, 0);
    assert.equal(repository.markNeedsReauthCalls, 1);
    assert.equal((gateway.created[0] as unknown as { connectCalls: number }).connectCalls, 1);
    await manager.disconnectAll();
  });

  it('يتوقف فوراً عند FloodWait دون حلقات ولا انتظار داخل الطلب', async () => {
    const { manager, repository, sleeps } = setup({
      behaviours: [async () => { throw floodWait(120); }],
    });
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.phase, 'stopped');
    assert.equal(state.floodWaitSeconds, 120);
    assert.equal(state.attempts, 1);
    assert.equal(sleeps.length, 0);
    assert.ok(state.nextAttemptAt instanceof Date);
    assert.deepEqual(repository.markErrorCalls, ['FLOOD_WAIT']);
    await manager.disconnectAll();
  });

  it('يعيد المحاولة بعدد محدود عند أخطاء الشبكة ثم يتوقف', async () => {
    const { manager, gateway, sleeps } = setup({
      maxReconnectAttempts: 3,
      behaviours: [async () => { throw networkError(); }, async () => { throw networkError(); }, async () => { throw networkError(); }],
    });
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.attempts, 3);
    assert.equal(state.phase, 'stopped');
    assert.equal(sleeps.length, 2, 'تأخير واحد بين كل محاولتين فقط');
    assert.equal((gateway.created[0] as unknown as { connectCalls: number }).connectCalls, 3);
    await manager.disconnectAll();
  });

  it('ينجح بعد فشل شبكة واحد دون تجاوز الحد', async () => {
    const { manager } = setup({
      maxReconnectAttempts: 3,
      behaviours: [async () => { throw networkError(); }, ok],
    });
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.phase, 'connected');
    assert.equal(state.attempts, 2);
    await manager.disconnectAll();
  });

  it('يعيد needs_reauth عندما تكون الجلسة غير مصرّحة دون خطأ', async () => {
    const { manager, repository } = setup({
      behaviours: [async () => ({ authorized: false, self: null })],
    });
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.phase, 'needs_reauth');
    assert.equal(state.lastErrorCode, 'NOT_AUTHORIZED');
    assert.equal(repository.markNeedsReauthCalls, 1);
    await manager.disconnectAll();
  });

  it('لا يبدأ اتصالاً لحساب موقوف', async () => {
    const { manager, gateway, repository } = setup();
    const account = repository.accounts.get(ACC_1)!;
    account.status = 'suspended';
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.phase, 'stopped');
    assert.equal(state.lastErrorCode, 'ACCOUNT_SUSPENDED');
    assert.equal(gateway.created.length, 0);
  });
});

describe('مدير اتصالات تيليجرام — العزل بين المستخدمين', () => {
  it('يمنع مستخدماً من الاتصال بحساب غيره', async () => {
    const { manager, gateway } = setup();
    await assert.rejects(() => manager.connect(ACC_1, USER_B), /لا تملك صلاحية/);
    assert.equal(gateway.created.length, 0);
  });

  it('لا يعيد حالة اتصال حساب مستخدم آخر', async () => {
    const { manager } = setup();
    await manager.connect(ACC_1, USER_A);
    assert.equal(manager.getState(ACC_1, USER_B), null);
    assert.equal(manager.getState(ACC_1, USER_A)?.phase, 'connected');
    await manager.disconnectAll();
  });

  it('يعزل جلستي حسابين مستقلين ويعالج رسائلهما بشكل منفصل', async () => {
    const seen: IncomingTextMessage[] = [];
    const { manager, gateway } = setup({
      onMessage: (m) => seen.push(m),
      behaviours: [ok, ok],
    });
    const stateA = await manager.connect(ACC_1, USER_A);
    const stateB = await manager.connect(ACC_2, USER_B);
    assert.equal(stateA.phase, 'connected');
    assert.equal(stateB.phase, 'connected');
    assert.notEqual(stateA.accountId, stateB.accountId);

    const clientA = gateway.created[0]!;
    const clientB = gateway.created[1]!;
    clientA.emit({ accountId: ACC_1, text: 'رسالة الحساب الأول' });
    clientB.emit({ accountId: ACC_2, text: 'رسالة الحساب الثاني' });

    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.accountId, ACC_1);
    assert.equal(seen[1]!.accountId, ACC_2);
    assert.equal(manager.getState(ACC_1, USER_A)?.receivedMessages, 1);
    assert.equal(manager.getState(ACC_2, USER_B)?.receivedMessages, 1);
    await manager.disconnectAll();
  });
});

describe('مدير اتصالات تيليجرام — الاستقبال والحفظ والإيقاف', () => {
  it('يمرر الرسائل ويحفظ حالة التحديثات بعد الاستقبال', async () => {
    const seen: IncomingTextMessage[] = [];
    const { manager, gateway, repository } = setup({
      onMessage: (m) => seen.push(m),
      persistDelayMs: 5,
      behaviours: [ok],
    });
    await manager.connect(ACC_1, USER_A);
    const client = gateway.created[0] as unknown as { emit: (m?: Partial<IncomingTextMessage>) => void; savedUpdateState?: unknown };
    client.savedUpdateState = { pts: 10, qts: 0, date: 1, seq: 1, channels: {} };
    client.emit({ text: 'طلب مساعدة' });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.text, 'طلب مساعدة');

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(repository.saveSessionCalls, 2, 'حفظ عند الاتصال وحفظ بعد التحديث');
    assert.deepEqual(repository.sessions.get(ACC_1)?.updateState, { pts: 10, qts: 0, date: 1, seq: 1, channels: {} });
    await manager.disconnectAll();
  });

  it('يمرّر نقطة الاستئناف المحفوظة إلى عميل الحساب قبل الاتصال (شرط الاستئناف)', async () => {
    const { manager, gateway, repository } = setup({ behaviours: [ok] });
    repository.sessions.set(ACC_1, {
      session: 'stored-session',
      updateState: { pts: 55, qts: 2, date: 3, seq: 4, channels: {} } as never,
    });

    await manager.connect(ACC_1, USER_A);

    const client = gateway.created[0] as unknown as { restoredPts?: number };
    assert.equal(client.restoredPts, 55, 'العميل يجب أن يبدأ من النقطة المحفوظة لا من الصفر');
    await manager.disconnectAll();
  });

  it('ينتظر المعالج غير المتزامن قبل حفظ الجلسة (سلامة نقطة الاستئناف)', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, gateway, repository } = setup({
      onMessage: () => gate,
      persistDelayMs: 5,
      behaviours: [ok],
    });
    await manager.connect(ACC_1, USER_A);
    const savesAfterConnect = repository.saveSessionCalls;
    const client = gateway.created[0] as unknown as { emit: (m?: Partial<IncomingTextMessage>) => Promise<void> };

    void client.emit({ text: 'بانتظار الحسم' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      repository.saveSessionCalls,
      savesAfterConnect,
      'لا يُحفظ تقدّم قبل حسم معالجة الرسالة',
    );

    release!();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(repository.saveSessionCalls, savesAfterConnect + 1, 'يُحفظ بعد الحسم');
    await manager.disconnectAll();
  });

  it('ينظّف الاشتراكات ويقطع الاتصال ويحفظ الجلسة عند الإيقاف', async () => {
    const { manager, gateway, repository } = setup({ behaviours: [ok] });
    await manager.connect(ACC_1, USER_A);
    const client = gateway.created[0] as unknown as { disconnectCalls: number; subscribers: Set<unknown> };
    await manager.disconnect(ACC_1, 'اختبار');
    assert.equal(client.disconnectCalls, 1);
    assert.equal(client.subscribers.size, 0);
    assert.equal(manager.getState(ACC_1, USER_A), null);
    assert.ok(repository.saveSessionCalls >= 2);
  });

  it('يستعيد الجلسة المحفوظة عند إعادة الاتصال بعد إعادة تشغيل', async () => {
    const repository = new FakeRepository();
    repository.addAccount({ id: ACC_1, userId: USER_A });
    repository.sessions.set(ACC_1, { session: 'persisted-session', updateState: { pts: 99, qts: 0, date: 5, seq: 2, channels: {} } });
    const gateway = new FakeGateway([ok], new Map([[ACC_1, 'persisted-session']]));
    const manager = new TelegramConnectionManager({ gateway, repository, reconnectBaseDelayMs: 10, sleep: async () => {} });
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.phase, 'connected');
    assert.equal(repository.sessions.get(ACC_1)?.session, 'persisted-session');
    await manager.disconnectAll();
  });
});
