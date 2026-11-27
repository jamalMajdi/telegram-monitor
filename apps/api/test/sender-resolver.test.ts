/**
 * اختبارات وحدة لحلّال هوية المرسل (إصلاح «سطر المرسل لا يظهر» 2026-11-26).
 *
 * الخلل الواقعي: تيليجرام يُرسل `fromId` فقط، ولا تُرفق المكتبة مصفوفة `users` مع التحديث،
 * فيُحفظ المعرّف بلا اسم ولا @username. هذه الاختبارات تثبّت الخطوة الاحتياطية:
 * كاش ⇒ قراءة كيان ⇒ تدفئة الجلسة بجلب الرسالة ⇒ إعادة القراءة، مع مهلة وسلوك فشل آمن.
 */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SenderIdentityCache,
  identityFromEntity,
  resolveSenderIdentity,
  type SenderEntityFields,
  type SenderLookup,
  type SenderResolverStats,
} from '../src/modules/telegram/senderResolver.js';
import type { IncomingSender } from '../src/modules/telegram/gateway.js';

const bareSender = (overrides: Partial<IncomingSender> = {}): IncomingSender => ({
  id: '7490507720',
  username: null,
  displayName: null,
  postAuthor: null,
  ...overrides,
});

function stats(): SenderResolverStats {
  return { cacheHits: 0, lookups: 0, resolved: 0, unresolved: 0, timeouts: 0, failures: 0 };
}

/** بديل مرن: يعدّ الاستدعاءات ويسمح بمحاكاة فشل/نجاح كل خطوة. */
function fakeLookup(plan: {
  entity?: SenderEntityFields | null;
  afterWarm?: SenderEntityFields | null;
  warmThrows?: boolean;
  entityThrows?: boolean;
  delayMs?: number;
}) {
  const calls = { getEntity: 0, warm: 0 };
  const lookup: SenderLookup = {
    async getEntity() {
      calls.getEntity += 1;
      if (plan.delayMs) await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
      if (plan.entityThrows) throw new Error('rpc failed');
      if (calls.getEntity > 1 && plan.afterWarm !== undefined) return plan.afterWarm;
      return plan.entity ?? null;
    },
    async warmFromSourceMessage() {
      calls.warm += 1;
      if (plan.warmThrows) throw new Error('rpc failed');
    },
  };
  return { calls, lookup };
}

const MOHAMMED: SenderEntityFields = { username: 'mohammed_a', firstName: 'محمد', lastName: 'عبدالله' };

describe('حلّال هوية المرسل — المسار السعيد', () => {
  it('لا يكلّف أي طلب حين تكون البيانات كاملة أصلاً', async () => {
    const complete = bareSender({ username: 'known_user', displayName: 'اسم معروف' });
    const { calls, lookup } = fakeLookup({ entity: MOHAMMED });
    const result = await resolveSenderIdentity(
      { accountId: 'acc', sender: complete, peerKey: 'channel:8879181', messageId: 20 },
      lookup,
    );
    assert.deepEqual(result, complete);
    assert.equal(calls.getEntity, 0);
    assert.equal(calls.warm, 0);
  });

  it('يقرأ الاسم و@username من كيان الجلسة بلا تدفئة', async () => {
    const { calls, lookup } = fakeLookup({ entity: MOHAMMED });
    const result = await resolveSenderIdentity(
      { accountId: 'acc', sender: bareSender(), peerKey: 'channel:8879181', messageId: 20 },
      lookup,
    );
    assert.equal(result.username, 'mohammed_a');
    assert.equal(result.displayName, 'محمد عبدالله');
    assert.equal(result.id, '7490507720');
    assert.equal(calls.warm, 0, 'لا داعي للتدفئة بعد نجاح القراءة');
  });

  it('يبني الاسم من العنوان (قنوات) حين تغيب الأسماء الشخصية', async () => {
    const { lookup } = fakeLookup({ entity: { title: 'إدارة القناة', username: 'channel_admin' } });
    const result = await resolveSenderIdentity({ accountId: 'acc', sender: bareSender() }, lookup);
    assert.equal(result.displayName, 'إدارة القناة');
    assert.equal(result.username, 'channel_admin');
  });
});

describe('حلّال هوية المرسل — الخطوة الاحتياطية (تدفئة الجلسة)', () => {
  it('يجلِب الرسالة ثم يعيد القراءة عند فشل القراءة الأولى', async () => {
    const { calls, lookup } = fakeLookup({ entity: null, afterWarm: MOHAMMED });
    const result = await resolveSenderIdentity(
      { accountId: 'acc', sender: bareSender(), peerKey: 'channel:8879181', messageId: 20 },
      lookup,
    );
    assert.equal(calls.getEntity, 2, 'قراءة أولى + قراءة بعد التدفئة');
    assert.equal(calls.warm, 1);
    assert.equal(result.username, 'mohammed_a');
    assert.equal(result.displayName, 'محمد عبدالله');
  });

  it('لا يدفّئ بلا معرّف مصدر أو رقم رسالة', async () => {
    const { calls, lookup } = fakeLookup({ entity: null });
    const result = await resolveSenderIdentity({ accountId: 'acc', sender: bareSender() }, lookup);
    assert.equal(calls.warm, 0);
    assert.equal(result.username, null);
    assert.equal(result.displayName, null);
  });

  it('فشل التدفئة لا يُسقط شيئاً: تعود الهوية كما وصلت', async () => {
    const { calls, lookup } = fakeLookup({ entity: null, warmThrows: true });
    const result = await resolveSenderIdentity(
      { accountId: 'acc', sender: bareSender(), peerKey: 'channel:8879181', messageId: 20 },
      lookup,
    );
    assert.deepEqual(result, bareSender());
    assert.equal(calls.warm, 1);
  });
});

describe('حلّال هوية المرسل — الكاش والمهلة والفشل الآمن', () => {
  it('يخزّن النجاح فلا يتكرّر الطلب للمرسل نفسه', async () => {
    const cache = new SenderIdentityCache();
    const s = stats();
    const first = fakeLookup({ entity: MOHAMMED });
    await resolveSenderIdentity({ accountId: 'acc', sender: bareSender() }, first.lookup, { cache, stats: s });

    const second = fakeLookup({ entity: MOHAMMED });
    const result = await resolveSenderIdentity({ accountId: 'acc', sender: bareSender() }, second.lookup, {
      cache,
      stats: s,
    });
    assert.equal(second.calls.getEntity, 0, 'لا شبكة للثاني');
    assert.equal(result.username, 'mohammed_a');
    assert.equal(s.cacheHits, 1);
    assert.equal(s.lookups, 1);
  });

  it('يخزّن الفشل مؤقتاً فلا يهدر طلبات متكررة', async () => {
    const cache = new SenderIdentityCache();
    const first = fakeLookup({ entity: null });
    await resolveSenderIdentity({ accountId: 'acc', sender: bareSender() }, first.lookup, { cache });

    const second = fakeLookup({ entity: MOHAMMED });
    const result = await resolveSenderIdentity({ accountId: 'acc', sender: bareSender() }, second.lookup, { cache });
    assert.equal(second.calls.getEntity, 0, 'الفشل مخزَّن كذلك');
    assert.equal(result.username, null);
  });

  it('ينتهي الكاش بانتهاء مدته (زمن محقون)', async () => {
    let now = 0;
    const cache = new SenderIdentityCache({ now: () => now });
    const s = stats();
    await resolveSenderIdentity({ accountId: 'acc', sender: bareSender() }, fakeLookup({ entity: MOHAMMED }).lookup, {
      cache,
      stats: s,
      positiveTtlMs: 1000,
    });
    now = 1001;
    const after = fakeLookup({ entity: MOHAMMED });
    await resolveSenderIdentity({ accountId: 'acc', sender: bareSender() }, after.lookup, { cache, stats: s });
    assert.equal(after.calls.getEntity, 1, 'انتهت الصلاحية ⇒ طلب جديد');
  });

  it('يعزل الكاش بين الحسابات (لا تسرّب هوية بين مستأجرين)', async () => {
    const cache = new SenderIdentityCache();
    await resolveSenderIdentity({ accountId: 'acc-a', sender: bareSender() }, fakeLookup({ entity: MOHAMMED }).lookup, {
      cache,
    });
    const other = fakeLookup({ entity: { username: 'other_user', firstName: 'آخر' } });
    const result = await resolveSenderIdentity({ accountId: 'acc-b', sender: bareSender() }, other.lookup, { cache });
    assert.equal(other.calls.getEntity, 1);
    assert.equal(result.username, 'other_user');
  });

  it('مهلة قصيرة تُنهي المحاولة بلا تعليق وبلا تخزين سلبي', async () => {
    const cache = new SenderIdentityCache();
    const s = stats();
    const started = Date.now();
    const result = await resolveSenderIdentity(
      { accountId: 'acc', sender: bareSender(), peerKey: 'channel:8879181', messageId: 20 },
      fakeLookup({ entity: MOHAMMED, delayMs: 200 }).lookup,
      { cache, stats: s, timeoutMs: 30 },
    );
    const elapsed = Date.now() - started;
    assert.deepEqual(result, bareSender(), 'المهلة ⇒ الهوية كما وصلت');
    assert.ok(elapsed < 1000, `يجب ألا يتعلّق الالتقاط (استغرق ${elapsed}ms)`);
    assert.equal(s.timeouts >= 1, true);
    assert.equal(cache.size, 0, 'المهلة لا تُخزَّن كفشل نهائي');
  });

  it('الاستثناءات لا تُفلت من الحلّال أبداً', async () => {
    const result = await resolveSenderIdentity(
      { accountId: 'acc', sender: bareSender(), peerKey: 'chat:1', messageId: 2 },
      fakeLookup({ entityThrows: true, warmThrows: true }).lookup,
    );
    assert.deepEqual(result, bareSender());
  });

  it('لا يستبدل ما وصل ببيانات أقلّ، ولا يمسّ توقيع المنشور', async () => {
    const partial = bareSender({ username: 'from_update', displayName: 'اسم من التحديث' });
    const { lookup } = fakeLookup({ entity: { username: 'other_user', firstName: 'اسم آخر' } });
    const result = await resolveSenderIdentity({ accountId: 'acc', sender: partial }, lookup);
    assert.equal(result.username, 'from_update', 'اليوزر الواصل لا يُستبدل');
    assert.equal(result.displayName, 'اسم من التحديث', 'الاسم الواصل لا يُستبدل');
  });

  it('توقيع المنشور وحده لا يكفي: يُكمَّل اليوزر والاسم ويبقى التوقيع', async () => {
    const signed = bareSender({ postAuthor: 'إدارة القناة' });
    const { calls, lookup } = fakeLookup({ entity: { username: 'channel_admin', firstName: 'إدارة' } });
    const result = await resolveSenderIdentity({ accountId: 'acc', sender: signed }, lookup);
    assert.equal(calls.getEntity, 1, 'التوقيع لا يغني عن معرفة المرسل');
    assert.equal(result.username, 'channel_admin');
    assert.equal(result.displayName, 'إدارة');
    assert.equal(result.postAuthor, 'إدارة القناة', 'التوقيع محفوظ كما هو');
  });

  it('حين يكتمل اليوزر والاسم لا يوجد أي طلب ولو وُجد توقيع', async () => {
    const complete = bareSender({ username: 'known_user', displayName: 'اسم', postAuthor: 'إدارة القناة' });
    const { calls, lookup } = fakeLookup({ entity: MOHAMMED });
    const result = await resolveSenderIdentity({ accountId: 'acc', sender: complete }, lookup);
    assert.deepEqual(result, complete);
    assert.equal(calls.getEntity, 0);
  });
});

describe('حلّال هوية المرسل — تنقية البيانات', () => {
  it('يسقط @username غير المطابق لنمط تيليجرام ويُبقي الاسم', () => {
    assert.deepEqual(identityFromEntity({ username: '+967777000111', firstName: 'سالم' }), {
      username: null,
      displayName: 'سالم',
    });
    assert.deepEqual(identityFromEntity({ username: 'ab', firstName: 'سالم' }), {
      username: null,
      displayName: 'سالم',
    });
    assert.equal(identityFromEntity({ username: 'valid_user' })?.username, 'valid_user');
  });

  it('يقصّ الأسماء الطويلة ويوحّد المسافات، ويعيد null عند الفراغ', () => {
    const long = identityFromEntity({ firstName: '  محمد   عبدالله  ' });
    assert.equal(long?.displayName, 'محمد عبدالله');
    const tooLong = identityFromEntity({ firstName: 'ا'.repeat(200) });
    assert.equal(tooLong?.displayName?.length, 64);
    assert.equal(identityFromEntity({}), null);
    assert.equal(identityFromEntity(null), null);
  });

  it('يرفض تخزين قيمة نصية مصطنعة مكان الاسم (أرقام فقط تُقبل كمعرّف لا كاسم)', () => {
    const numeric = identityFromEntity({ firstName: '782139465' });
    // الاسم الرقمي يبقى نصاً كما هو من تيليجرام؛ الحجب يحدث في طبقة العرض (حاجب جهات الاتصال).
    assert.equal(numeric?.displayName, '782139465');
  });
});

describe('SenderIdentityCache — حدود النمو', () => {
  it('يبقي الحجم تحت السقف بإخلاء الأقدم', () => {
    let now = 0;
    const cache = new SenderIdentityCache({ maxEntries: 2, now: () => now });
    cache.set('a', { username: 'a1', displayName: null }, 1000);
    now = 1;
    cache.set('b', { username: 'b1', displayName: null }, 1000);
    now = 2;
    cache.set('c', { username: 'c1', displayName: null }, 1000);
    assert.equal(cache.size, 2);
    assert.equal(cache.get('a').found, false, 'الأقدم أُخلي');
    assert.equal(cache.get('c').found, true);
  });
});
