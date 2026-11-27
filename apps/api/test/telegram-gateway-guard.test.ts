/**
 * اختبارات مباشرة على عميل الحساب الإنتاجي (`TeleprotoAccountClient`) بلا شبكة:
 * إنشاء العميل، استعادة نقطة الاستئناف المحفوظة، وربط الحارس بحالة موزّع التحديثات في المكتبة.
 *
 * لا يُنشأ أي اتصال: `new TelegramClient` لا يتصل قبل `connect()`، ولا نستدعي `connect()` هنا.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredUpdateState } from 'teleproto/sessions';

// لا تُلمس قاعدة البيانات في هذا الملف؛ القيمة تمنع فقط فشل تحقّق البيئة عند الاستيراد.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.LOG_LEVEL ||= 'silent';

const SAVED = { pts: 77, qts: 3, date: 1_700_000_000, seq: 9, channels: new Map() } as unknown as StoredUpdateState;

async function makeClient(savedUpdateState?: StoredUpdateState) {
  const { TeleprotoGateway } = await import('../src/modules/telegram/teleprotoGateway.js');
  const gateway = new TeleprotoGateway({
    apiId: 1,
    apiHash: '0'.repeat(32),
    testServers: true,
    catchUp: true,
    connectionRetries: 0,
    floodSleepThreshold: 0,
  });
  const client = gateway.createAccountClient({
    accountId: 'acc-guard-test',
    savedSession: '',
    updateState: savedUpdateState,
  });
  // الوصول إلى عميل المكتبة الداخلي ضروري لفحص إشارة الانشغال؛ لا يُستخدم في الإنتاج.
  const inner = (client as unknown as { client: { _updateDispatcher?: Record<string, unknown> } }).client;
  return { client, inner };
}

describe('عميل الحساب الإنتاجي — نقطة الاستئناف والحارس', () => {
  it('يُنشأ بلا استثناء (كان الإنشاء يُسقط بسبب قراءة الجلسة قبل تهيئتها)', async () => {
    const { client } = await makeClient(SAVED);
    const info = client.getCheckpointInfo?.();
    assert.deepEqual(info, { pending: 0, pinned: false, failures: 0, busy: false });
  });

  it('نقطة الاستئناف المحفوظة تصل إلى الجلسة وتُصدَّر كما هي', async () => {
    const { client } = await makeClient(SAVED);
    const exported = client.exportSession();
    assert.equal((exported.updateState as { pts?: number } | undefined)?.pts, 77);
    assert.equal((exported.updateState as { qts?: number } | undefined)?.qts, 3);
  });

  it('موزّع التحديثات الداخلي موجود في نسخة المكتبة المثبتة (حرس ترقية)', async () => {
    const { inner } = await makeClient(SAVED);
    assert.ok(inner._updateDispatcher, 'تغيّر اسم الحقل في المكتبة: يجب إعادة تقييم إشارة الانشغال');
  });

  it('لا تتقدّم اللقطة المحفوظة ما دام الموزّع يُفرّغ تحديثات', async () => {
    const { client, inner } = await makeClient(SAVED);
    const dispatcher = inner._updateDispatcher as { draining: boolean };
    const session = (client as unknown as { session: { setUpdateState(s: unknown): void } }).session;

    // المكتبة قدّمت pts إلى 90 (قبل تسليم التحديث) وما زال الموزّع يعمل.
    session.setUpdateState({ pts: 90, qts: 0, date: 0, seq: 0, channels: new Map() });
    dispatcher.draining = true;
    assert.equal(
      (client.exportSession().updateState as { pts?: number } | undefined)?.pts,
      77,
      'الحفظ أثناء الانشغال يجب أن يبقى عند النقطة الآمنة',
    );
    assert.equal(client.getCheckpointInfo?.().busy, true);

    dispatcher.draining = false;
    assert.equal((client.exportSession().updateState as { pts?: number } | undefined)?.pts, 90);
  });
});
