/**
 * اختبارات وحدة لحرس نقطة الاستئناف (الخطوة الرابعة، قرار 1).
 * الهدف: إثبات أن النقطة المحفوظة لا تتقدّم إلا بعد حسم المعاملة، وأن فشل الحفظ يثبّتها،
 * وأنها لا تتقدّم كذلك بينما ما زالت المكتبة تُفرّغ تحديثات لم يبدأ معالجنا معالجتها.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointGuard } from '../src/modules/telegram/checkpointGuard.js';

interface State {
  pts: number;
}

function makeGuard(options: { initial?: State; busy?: () => boolean } = {}) {
  let live: State | undefined = { pts: 10 };
  const guard = new CheckpointGuard<State>(
    () => live,
    options.busy ?? (() => false),
    options.initial,
  );
  return {
    guard,
    advanceLive: (pts: number) => {
      live = { pts };
    },
    clearLive: () => {
      live = undefined;
    },
  };
}

describe('حرس نقطة الاستئناف', () => {
  it('لا يقرأ اللقطة الحيّة عند الإنشاء (كان ذلك يُسقط إنشاء العميل قبل تهيئة الجلسة)', () => {
    let reads = 0;
    const guard = new CheckpointGuard<State>(() => {
      reads += 1;
      throw new Error('يجب ألا تُقرأ اللقطة الحيّة في المُنشئ');
    });
    assert.equal(reads, 0);
    assert.equal(guard.pending, 0);
    assert.equal(guard.isPinned, false);
  });

  it('يبدأ من اللقطة الحيّة عند الخمول', () => {
    const { guard } = makeGuard();
    assert.deepEqual(guard.snapshot(), { pts: 10 });
    assert.equal(guard.pending, 0);
  });

  it('يبدأ من النقطة المحفوظة المستعادة (floor) قبل أي حسم', () => {
    const { guard, advanceLive } = makeGuard({ initial: { pts: 7 } });
    advanceLive(8);
    guard.begin();
    assert.deepEqual(guard.snapshot(), { pts: 7 }, 'لا يرتفع فوق النقطة المستعادة قبل الحسم');
  });

  it('لا يتقدّم المحفوظ أثناء وجود رسالة قيد المعالجة ولو تقدّمت اللقطة الحيّة', () => {
    const { guard, advanceLive } = makeGuard({ initial: { pts: 10 } });
    guard.begin();
    advanceLive(11); // المكتبة تُقدّم pts قبل التسليم
    assert.deepEqual(guard.snapshot(), { pts: 10 }, 'المحفوظ يجب أن يبقى عند ما قبل الرسالة');
    assert.equal(guard.pending, 1);
  });

  it('لا يتقدّم ما دامت المكتبة تُفرّغ تحديثات لم تُسلَّم للمعالج بعد', () => {
    let busy = true;
    const { guard, advanceLive } = makeGuard({ initial: { pts: 10 }, busy: () => busy });
    // المكتبة قدّمت pts لكن المعالج لم يبدأ (انتظار داخلي في مسار المكتبة): لا تثبيت ولا عدّاد قيد المعالجة.
    advanceLive(11);
    assert.deepEqual(guard.snapshot(), { pts: 10 }, 'الانشغال يمنع التقدّم حتى لو كان قيد المعالجة صفراً');
    busy = false;
    assert.deepEqual(guard.snapshot(), { pts: 11 }, 'بعد خمول المكتبة يجوز التقدّم');
  });

  it('فشل فحص الانشغال يُعامل كـ«منشغل» (تجمّد آمن لا فقدان)', () => {
    const { guard, advanceLive } = makeGuard({
      initial: { pts: 10 },
      busy: () => {
        throw new Error('probe failed');
      },
    });
    advanceLive(12);
    assert.deepEqual(guard.snapshot(), { pts: 10 });
  });

  it('يتقدّم بعد النجاح فقط، وعند الخمول', () => {
    const { guard, advanceLive } = makeGuard({ initial: { pts: 10 } });
    guard.begin();
    advanceLive(11);
    guard.settle(true);
    assert.equal(guard.pending, 0);
    assert.deepEqual(guard.snapshot(), { pts: 11 });
  });

  it('يبقى مثبَّتاً بعد فشل الحفظ حتى لو نجحت رسائل لاحقة (لا تخطّي صامت)', () => {
    const { guard, advanceLive } = makeGuard({ initial: { pts: 10 } });
    guard.begin();
    advanceLive(11);
    guard.settle(false);
    assert.equal(guard.isPinned, true);
    assert.deepEqual(guard.snapshot(), { pts: 10 });

    // رسالة تالية تنجح: لا يجوز أن ترفع النقطة فوق الرسالة الفاشلة.
    guard.begin();
    advanceLive(12);
    guard.settle(true);
    assert.deepEqual(guard.snapshot(), { pts: 10 });
    assert.equal(guard.failureCount, 1);
  });

  it('يتعامل مع أكثر من رسالة متزامنة دون تقدّم مبكر', () => {
    const { guard, advanceLive } = makeGuard({ initial: { pts: 10 } });
    guard.begin();
    advanceLive(11);
    guard.begin();
    advanceLive(12);
    guard.settle(true); // انتهت الأولى فقط
    assert.deepEqual(guard.snapshot(), { pts: 10 }, 'لا تقدّم قبل حسم الأخيرة');
    guard.settle(true);
    assert.deepEqual(guard.snapshot(), { pts: 12 });
  });

  it('لا ينزل تحت النقطة المستعادة عند غياب لقطة حيّة', () => {
    const { guard, clearLive } = makeGuard({ initial: { pts: 10 } });
    clearLive();
    assert.deepEqual(guard.snapshot(), { pts: 10 }, 'لا تُمحى نقطة الاستئناف إذا غابت اللقطة الحيّة');
  });

  it('حالة جديدة (إعادة تشغيل) تُلغي التثبيت وتبدأ من اللقطة المحفوظة', () => {
    const restored: State = { pts: 10 };
    const before = new CheckpointGuard<State>(() => ({ pts: 11 }), () => false, restored);
    before.begin();
    before.settle(false);
    assert.deepEqual(before.snapshot(), { pts: 10 }, 'اللقطة المحفوظة هي السقف بعد الفشل');

    const afterRestart = new CheckpointGuard<State>(() => restored, () => false, restored);
    assert.deepEqual(afterRestart.snapshot(), { pts: 10 });
    assert.equal(afterRestart.isPinned, false);
    assert.equal(afterRestart.failureCount, 0);
  });
});
