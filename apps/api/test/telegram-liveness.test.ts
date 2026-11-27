/**
 * تدقيق 2026-11-26 — انقطاع MTProto الصامت وإعادة الاتصال.
 *
 * **الخلل الذي كان قائماً:** المكتبة (`teleproto`) تعيد الاتصال داخلياً بلا حد
 * (`reconnectRetries: Infinity`)، لكن مدير الاتصال لم يكن يسأل عن حال النقل أبداً:
 *   - الحساب يبقى «متصل» في الواجهة والقاعدة ساعاتٍ وهو مقطوع فعلياً (حالة كاذبة).
 *   - وبعد نفاد خمس محاولات يصير «متوقف» نهائياً بلا أي محاولة لاحقة، فلو عاد النت
 *     تعود الرسائل (المكتبة تُعيد الاتصال) والحالة تبقى «متوقف» بلا استعادة منّا.
 *
 * **بعد الإصلاح:** نبضة حياة دورية تُطابق الحالة المعلنة بالنقل الحقيقي:
 *   - انقطاع مؤكَّد (نبضتان متتاليتان) ⇒ عميل جديد من آخر جلسة محفوظة + دورة اتصال محدودة.
 *   - نفاد المحاولات ⇒ «متوقف» + محاولة بطيئة واحدة عند استحقاقها (لا حلقة سريعة).
 *   - انتظار إجباري (FloodWait) أو جلسة مُبطلة ⇒ «متوقف/يحتاج دخول» **بلا** إعادة تلقائية.
 */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramConnectionManager } from '../src/modules/telegram/connectionManager.js';
import { FakeGateway, FakeRepository } from './telegram-fakes.js';
import type { ConnectOutcome } from '../src/modules/telegram/gateway.js';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACC_1 = '11111111-1111-4111-8111-111111111111';

const ok = async (): Promise<ConnectOutcome> => ({ authorized: true, self: { id: '999', username: 'fake_user' } });
const networkError = async (): Promise<ConnectOutcome> => {
  throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
};
const floodWait = async (): Promise<ConnectOutcome> => {
  throw Object.assign(new Error('FLOOD_WAIT'), { name: 'FloodWaitError', code: 420, seconds: 60 });
};
const revoked = async (): Promise<ConnectOutcome> => {
  throw Object.assign(new Error('SESSION_REVOKED'), { name: 'SessionRevokedError', code: 401 });
};

function setup(options: { behaviours?: Array<() => Promise<ConnectOutcome>>; maxReconnectAttempts?: number; livenessIntervalMs?: number; livenessMisses?: number; slowRetryMs?: number } = {}) {
  const repository = new FakeRepository();
  repository.addAccount({ id: ACC_1, userId: USER_A });
  const behaviours = options.behaviours ?? [];
  const gateway = new FakeGateway(behaviours);
  const manager = new TelegramConnectionManager({
    gateway,
    repository,
    persistDelayMs: 1,
    maxReconnectAttempts: options.maxReconnectAttempts ?? 3,
    reconnectBaseDelayMs: 1,
    // الافتراضي: نبضة معطّلة زمنياً ونقودها يدوياً عبر probeLiveness (اختبار حتمي بلا سباقات).
    livenessIntervalMs: options.livenessIntervalMs ?? 0,
    livenessMisses: options.livenessMisses ?? 2,
    slowRetryMs: options.slowRetryMs ?? 0,
    sleep: async () => undefined,
  });
  return { manager, gateway, repository, behaviours };
}

const waitFor = async (check: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('انتهت المهلة قبل تحقّق الشرط');
};

describe('انقطاع صامت — نبضة الحياة', () => {
  it('نبضة واحدة مفقودة لا تكفي: لا استعادة قبل تأكّد الانقطاع', async () => {
    const { manager, gateway } = setup({ behaviours: [ok, ok] });
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.phase, 'connected');
    const client = gateway.created[0]!;
    client.dropTransport();

    await manager.probeLiveness(ACC_1);
    // نبضة واحدة قد تكون وميضاً: الحالة لم تُغيَّر ولم يُنشأ عميل جديد.
    assert.equal(gateway.created.length, 1);
  });

  it('انقطاع مؤكَّد ⇒ استعادة تلقائية بعميل جديد ونفس نقطة الاستئناف', async () => {
    const { manager, gateway } = setup({ behaviours: [ok, ok] });
    await manager.connect(ACC_1, USER_A);
    const first = gateway.created[0]!;
    // نقطة استئناف محفوظة قبل الانقطاع (تتقدّم pts كأن رسالة وصلت).
    await first.emit({ messageId: 7, text: 'رسالة قبل الانقطاع' });
    first.dropTransport();

    await manager.probeLiveness(ACC_1);
    await manager.probeLiveness(ACC_1);

    assert.equal(gateway.created.length, 2, 'عميل جديد بدل إعادة استخدام عميل ميت');
    const second = gateway.created[1]!;
    assert.equal(first.disconnectCalls, 1, 'العميل القديم أُغلق');
    assert.ok(second.restoredPts !== undefined, 'نقطة الاستئناف مُرِّرت للعميل الجديد');
    const state = manager.getState(ACC_1, USER_A)!;
    assert.equal(state.phase, 'connected', 'الحالة عادت صادقة بعد الاستعادة');
    assert.equal(state.lastErrorCode, null, 'رمز الخطأ يُمسح بعد النجاح');

    // الاستقبال مرتبط بالعميل الجديد: رسالة جديدة تُحتسب في عدّاد الحالة.
    const before = state.receivedMessages;
    await second.emit({ messageId: 8, text: 'رسالة بعد الاستعادة' });
    assert.equal(manager.getState(ACC_1, USER_A)!.receivedMessages, before + 1, 'عميل الاستعادة مرتبط بالاستقبال');
  });

  it('توجيه الرسائل يعمل بعد الاستعادة عبر العميل الجديد وحده', async () => {
    const messages: string[] = [];
    const repository = new FakeRepository();
    repository.addAccount({ id: ACC_1, userId: USER_A });
    const gateway = new FakeGateway([ok, ok]);
    const manager = new TelegramConnectionManager({
      gateway,
      repository,
      onMessage: (m) => {
        messages.push(m.text);
      },
      persistDelayMs: 1,
      maxReconnectAttempts: 3,
      reconnectBaseDelayMs: 1,
      livenessIntervalMs: 0,
      livenessMisses: 2,
      sleep: async () => undefined,
    });
    await manager.connect(ACC_1, USER_A);
    const first = gateway.created[0]!;
    first.dropTransport();
    await manager.probeLiveness(ACC_1);
    await manager.probeLiveness(ACC_1);
    const second = gateway.created[1]!;

    await first.emit({ messageId: 9, text: 'من عميل ميت' }); // لا اشتراك بعد الإغلاق
    await second.emit({ messageId: 10, text: 'من عميل الاستعادة' });
    assert.deepEqual(messages, ['من عميل الاستعادة']);
  });

  it('نفاد المحاولات السريعة ⇒ «متوقف» ثم محاولة بطيئة تُعيد الاتصال عندما يعود النت', async () => {
    const { manager, gateway, behaviours } = setup({
      behaviours: [networkError, networkError, networkError],
      maxReconnectAttempts: 3,
    });
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.phase, 'stopped', 'نفاد المحاولات السريعة يوقف الاتصال');
    const createdAfterFailure = gateway.created.length;

    // ما زال النت مقطوعاً: المحاولة البطيئة تفشل وتُعيد «متوقف» بلا حلقات سريعة.
    behaviours.push(networkError, networkError, networkError);
    await manager.probeLiveness(ACC_1);
    assert.equal(manager.getState(ACC_1, USER_A)!.phase, 'stopped');
    assert.equal(gateway.created.length, createdAfterFailure + 1, 'عميل واحد لكل محاولة بطيئة');

    // عاد النت: المحاولة البطيئة التالية تُعيد الاتصال بلا تدخل بشري.
    behaviours.push(ok);
    await manager.probeLiveness(ACC_1);
    const recovered = manager.getState(ACC_1, USER_A)!;
    assert.equal(recovered.phase, 'connected', 'استعادة تلقائية بعد نفاد المحاولات');
    assert.ok(gateway.created.length > createdAfterFailure, 'عميل جديد للاستعادة');
  });

  it('FloodWait ⇒ لا إعادة تلقائية إطلاقاً (قرار المنتج)', async () => {
    const { manager, gateway } = setup({ behaviours: [floodWait], maxReconnectAttempts: 3 });
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.phase, 'stopped');
    const createdBefore = gateway.created.length;
    for (let i = 0; i < 4; i += 1) await manager.probeLiveness(ACC_1);
    assert.equal(gateway.created.length, createdBefore, 'لا محاولة جديدة بعد انتظار إجباري');
    assert.equal(manager.getState(ACC_1, USER_A)!.phase, 'stopped');
  });

  it('جلسة مُبطلة ⇒ «يحتاج إعادة دخول» ولا استعادة تلقائية', async () => {
    const { manager, gateway } = setup({ behaviours: [revoked], maxReconnectAttempts: 3 });
    const state = await manager.connect(ACC_1, USER_A);
    assert.equal(state.phase, 'needs_reauth');
    const createdBefore = gateway.created.length;
    for (let i = 0; i < 4; i += 1) await manager.probeLiveness(ACC_1);
    assert.equal(gateway.created.length, createdBefore);
    assert.equal(manager.getState(ACC_1, USER_A)!.phase, 'needs_reauth');
  });

  it('المؤقّت الدوري يعمل وحده (بلا probeLiveness) ويُلغى عند الفصل', async () => {
    const { manager, gateway } = setup({ behaviours: [ok, ok], livenessIntervalMs: 15, livenessMisses: 1 });
    await manager.connect(ACC_1, USER_A);
    gateway.created[0]!.dropTransport();
    await waitFor(() => manager.getState(ACC_1, USER_A)?.phase === 'reconnecting' || gateway.created.length === 2);
    await waitFor(() => gateway.created.length === 2);
    await waitFor(() => manager.getState(ACC_1, USER_A)?.phase === 'connected');

    await manager.disconnect(ACC_1, 'test');
    // بعد الفصل لا مؤقّتات تعمل: عدد العملاء لا يتغيّر مهما انتظرنا.
    const createdAfterDisconnect = gateway.created.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(gateway.created.length, createdAfterDisconnect);
  });
});
