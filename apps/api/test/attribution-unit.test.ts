/**
 * اختبارات وحدة لهوية المصدر والمرسل (متطلب تجاري: «إرفاق هوية المصدر والمرسل»).
 *
 * ما تثبّته هذه المجموعة:
 *   1) ترتيب الحسم: تجاوز المسار يتقدّم على إعداد المستخدم، و«مفعّل افتراضياً» يعني Opt-out.
 *   2) التنقية: @username لا يُقبل إلا بنمط تيليجرام، والمعرّف أرقام فقط، والاسم يُحجب إن حمل جهة تواصل.
 *   3) النشر: الأسطر تأتي **أسفل** المحتوى بعد فاصل رقيق، ولا تُنقذ منشوراً فارغاً،
 *      وتُحتسب ضمن سقف 4096 حرفاً (فلا يُقطع جزء بلا حسابها).
 *   4) تحويل التحديث: هوية المرسل تُقرأ من التحديث نفسه بلا طلب شبكة إضافي.
 */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ATTRIBUTION_CONFIG,
  effectiveAttributionMode,
  renderAttribution,
  sanitizeNumericId,
  sanitizeUsername,
  type AttributionInput,
} from '../src/modules/publishing/attribution.js';
import { FOOTER_SEPARATOR, buildLines, htmlVisibleText, planPost } from '../src/modules/publishing/publisher.js';
import { mapIncomingText } from '../src/modules/telegram/messageMapper.js';

const ACC = '11111111-1111-4111-8111-111111111111';

function input(overrides: Partial<AttributionInput> = {}): AttributionInput {
  return {
    routeMode: null,
    config: { ...DEFAULT_ATTRIBUTION_CONFIG },
    source: { title: 'قناة السوق العام', username: 'public_market', peerId: '1001234567890' },
    sender: { id: '782139465', username: 'mohammed_a', displayName: 'محمد عبدالله', postAuthor: null },
    ...overrides,
  };
}

const visible = (lines: { html: string }[]) => lines.map((line) => htmlVisibleText(line.html));

describe('هوية المصدر والمرسل — ترتيب الحسم', () => {
  it('مفعّلة افتراضياً: بلا إعداد صريح يظهر المصدر والمرسل', () => {
    const mode = effectiveAttributionMode({ routeMode: null, config: DEFAULT_ATTRIBUTION_CONFIG });
    assert.equal(mode.mode, 'both');
    assert.equal(mode.reason, null);
  });

  it('إيقاف المستخدم يخفي الهوية ويسجّل السبب user_disabled', () => {
    const mode = effectiveAttributionMode({
      routeMode: null,
      config: { ...DEFAULT_ATTRIBUTION_CONFIG, enabled: false },
    });
    assert.deepEqual(mode, { mode: 'off', reason: 'user_disabled' });
  });

  it('تجاوز المسار يتقدّم على الإعداد العام في الحالتين', () => {
    const overridden = effectiveAttributionMode({
      routeMode: 'source',
      config: { ...DEFAULT_ATTRIBUTION_CONFIG, mode: 'both' },
    });
    assert.equal(overridden.mode, 'source');

    // الإيقاف العام لا يمنع تجاوزاً صريحاً للمسار — القرار للمسار وحده.
    const forced = effectiveAttributionMode({
      routeMode: 'sender',
      config: { ...DEFAULT_ATTRIBUTION_CONFIG, enabled: false },
    });
    assert.equal(forced.mode, 'sender');
  });

  it("تجاوز المسار بـ off يوقف الهوية لهذا المسار فقط بلا مساس بالإعداد العام", () => {
    const config = { ...DEFAULT_ATTRIBUTION_CONFIG };
    const result = renderAttribution(input({ routeMode: 'off', config }));
    assert.equal(result.mode, 'off');
    assert.equal(result.reason, 'route_off');
    assert.deepEqual(result.lines, []);
    // الدالة نقية: الإعداد العام لم يتغيّر بعد تجاوز مسار واحد.
    assert.deepEqual(config, DEFAULT_ATTRIBUTION_CONFIG);
    assert.equal(effectiveAttributionMode({ routeMode: null, config }).mode, 'both');
  });
});

describe('هوية المصدر والمرسل — العناصر والتنقية', () => {
  it('يعرض سطرَي المصدر والمرسل أسفل المنشور بوسم واضح', () => {
    const result = renderAttribution(input());
    const lines = visible(result.lines);
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.startsWith('📣 المصدر:'));
    assert.ok(lines[0]!.includes('قناة السوق العام'));
    assert.ok(lines[0]!.includes('@public_market'));
    assert.ok(lines[1]!.startsWith('👤 المرسل:'));
    assert.ok(lines[1]!.includes('محمد عبدالله'));
    assert.ok(lines[1]!.includes('@mohammed_a'));
    // المعرّف الرقمي مخفي افتراضياً.
    assert.ok(!lines.join(' ').includes('782139465'));
    assert.ok(!lines.join(' ').includes('1001234567890'));
  });

  it('«المصدر فقط» و«المرسل فقط» ينتجان سطراً واحداً', () => {
    assert.deepEqual(
      visible(renderAttribution(input({ config: { ...DEFAULT_ATTRIBUTION_CONFIG, mode: 'source' } })).lines),
      visible(renderAttribution(input()).lines).slice(0, 1),
    );
    const senderOnly = visible(
      renderAttribution(input({ config: { ...DEFAULT_ATTRIBUTION_CONFIG, mode: 'sender' } })).lines,
    );
    assert.equal(senderOnly.length, 1);
    assert.ok(senderOnly[0]!.startsWith('👤 المرسل:'));
  });

  it('@username اختياري، والمعرّف الرقمي يظهر عند طلبه فقط', () => {
    const withoutUsername = visible(
      renderAttribution(input({ config: { ...DEFAULT_ATTRIBUTION_CONFIG, showUsername: false } })).lines,
    );
    assert.ok(!withoutUsername.join(' ').includes('@'));

    const withId = visible(
      renderAttribution(input({ config: { ...DEFAULT_ATTRIBUTION_CONFIG, showId: true } })).lines,
    );
    assert.ok(withId[0]!.includes('1001234567890'));
    assert.ok(withId[1]!.includes('782139465'));
  });

  it('يسقط ما لا يطابق نمط تيليجرام: يوزر معطوب أو معرّف غير رقمي', () => {
    assert.equal(sanitizeUsername('@valid_user'), 'valid_user');
    assert.equal(sanitizeUsername('+967777000111'), null);
    assert.equal(sanitizeUsername('ab'), null);
    assert.equal(sanitizeUsername('bad name'), null);
    assert.equal(sanitizeUsername('_leading'), null);
    assert.equal(sanitizeNumericId('12345'), '12345');
    assert.equal(sanitizeNumericId('12a45'), null);
    assert.equal(sanitizeNumericId(''), null);

    const result = visible(
      renderAttribution(
        input({
          source: { title: 'قناة', username: '+967777000111', peerId: '-100' },
          sender: { id: '77a', username: 'x', displayName: 'سالم', postAuthor: null },
          config: { ...DEFAULT_ATTRIBUTION_CONFIG, showId: true },
        }),
      ).lines,
    );
    assert.deepEqual(result, ['📣 المصدر: قناة', '👤 المرسل: سالم']);
  });

  it('لا يخترع شيئاً: البيانات الغائبة تُحذف ولا تُكتب «غير معروف»', () => {
    const result = renderAttribution({
      routeMode: null,
      config: DEFAULT_ATTRIBUTION_CONFIG,
      source: { title: null, username: null, peerId: null },
      sender: { id: null, username: null, displayName: null, postAuthor: null },
    });
    assert.deepEqual(result.lines, []);
  });

  it('يستخدم توقيع المنشور (postAuthor) كاسم مرسل بديل، ويمرّر الاسم على الحجب', () => {
    const signed = visible(
      renderAttribution(
        input({
          sender: { id: null, username: null, displayName: null, postAuthor: 'إدارة القناة' },
          config: { ...DEFAULT_ATTRIBUTION_CONFIG, mode: 'sender' },
        }),
      ).lines,
    );
    assert.deepEqual(signed, ['👤 المرسل: إدارة القناة']);

    const masked = visible(
      renderAttribution(input(), { maskName: (value) => value.replace('محمد عبدالله', '[محجوب]') }).lines,
    );
    assert.ok(masked[1]!.includes('[محجوب]'));
    assert.ok(!masked[1]!.includes('محمد عبدالله'));
  });
});

describe('هوية المصدر والمرسل — الموضع والتنسيق داخل المنشور', () => {
  const footer = renderAttribution(input()).lines;

  it('تأتي بعد المحتوى وبعد فاصل رقيق، لا قبله', () => {
    const built = buildLines(
      { title: 'الوظائف', fields: [{ label: 'المسمى', value: 'مبرمج' }] },
      4096,
      footer,
    );
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const lines = visible(built.lines);
    const title = lines.findIndex((line) => line.includes('الوظائف'));
    const content = lines.findIndex((line) => line.includes('مبرمج'));
    const separator = lines.findIndex((line) => line.includes(FOOTER_SEPARATOR));
    const source = lines.findIndex((line) => line.includes('📣 المصدر:'));
    const sender = lines.findIndex((line) => line.includes('👤 المرسل:'));
    assert.ok(title < content, 'العنوان قبل المحتوى');
    assert.ok(content < separator, 'الفاصل بعد المحتوى');
    assert.ok(separator < source && source < sender, 'الهوية أسفل كل شيء');
    assert.equal(lines.length, content + 4, 'لا أسطر زائدة');
  });

  it('لا تُنقذ منشوراً فارغاً: محتوى فارغ + هوية ⇒ لا نشر', () => {
    const built = buildLines({ title: 'الخدمات والطلبات العامة', fields: [] }, 4096, footer);
    assert.equal(built.ok, false);
    assert.equal(built.ok === false && built.reason, 'empty');
  });

  it('تُحتسب ضمن سقف الجزء: المحتوى وحده يدخل جزءاً واحداً، ومعه الهوية يحتاج جزءين', () => {
    const source = { title: 'الوظائف', fields: [{ label: 'الوصف', value: 'ب'.repeat(600) }] };
    const free = planPost({ source, maxParts: 10, policy: 'split', limit: 4096 });
    assert.equal(free.ok, true);
    if (!free.ok) return;
    assert.equal(free.parts.length, 1);

    // سقف مساوٍ لطول المحتوى بالضبط: بلا هوية يبقى جزءاً واحداً، ومعها لا بدّ من جزء ثانٍ.
    const limit = free.parts[0]!.visibleLength;
    const withoutFooter = planPost({ source, maxParts: 10, policy: 'split', limit });
    const withFooter = planPost({ source, maxParts: 10, policy: 'split', limit, footer });
    assert.equal(withoutFooter.ok && withoutFooter.parts.length, 1);
    assert.equal(withFooter.ok && withFooter.parts.length, 2);
    if (!withFooter.ok) return;
    assert.ok(withFooter.parts[1]!.html.includes('📣 المصدر:'), 'الهوية في الجزء الأخير');
    assert.ok(!withFooter.parts[0]!.html.includes('📣 المصدر:'), 'ولا تتقدّم على المحتوى');
  });
});

describe('هوية المصدر والمرسل — التقاط المرسل من التحديث', () => {
  it('يقرأ المعرّف و@username والاسم من كيانات التحديث بلا طلب شبكة', () => {
    const mapped = mapIncomingText(
      {
        className: 'UpdateNewChannelMessage',
        message: {
          className: 'Message',
          id: 91,
          message: 'مطلوب مندوب مبيعات',
          date: 1700000100,
          peerId: { className: 'PeerChannel', channelId: 777 },
          fromId: { className: 'PeerUser', userId: 782139465 },
          _entities: new Map([
            [
              '782139465',
              { className: 'User', id: 782139465, username: 'mohammed_a', firstName: 'محمد', lastName: 'عبدالله' },
            ],
          ]),
        },
      },
      ACC,
    );
    assert.ok(mapped);
    assert.deepEqual(mapped.sender, {
      id: '782139465',
      username: 'mohammed_a',
      displayName: 'محمد عبدالله',
      postAuthor: null,
    });
  });

  it('يستخدم توقيع المنشور حين تكون القناة مجهولة المصدر', () => {
    const mapped = mapIncomingText(
      {
        message: {
          className: 'Message',
          id: 92,
          message: 'إعلان',
          date: 1700000101,
          peerId: { className: 'PeerChannel', channelId: 778 },
          postAuthor: 'إدارة القناة',
        },
      },
      ACC,
    );
    assert.deepEqual(mapped?.sender, {
      id: null,
      username: null,
      displayName: null,
      postAuthor: 'إدارة القناة',
    });
  });

  it('رسالة بلا أي بيانات مرسل ⇒ sender = null ولا حقول مخترعة', () => {
    const mapped = mapIncomingText(
      {
        message: {
          className: 'Message',
          id: 93,
          message: 'نص',
          date: 1700000102,
          peerId: { className: 'PeerChannel', channelId: 779 },
        },
      },
      ACC,
    );
    assert.equal(mapped?.sender, null);
  });

  it('لا يعتمد على مرسل من نوع قناة/مجموعة كمعرّف مستخدم', () => {
    const mapped = mapIncomingText(
      {
        message: {
          className: 'Message',
          id: 94,
          message: 'نص',
          date: 1700000103,
          peerId: { className: 'PeerChannel', channelId: 780 },
          fromId: { className: 'PeerChannel', channelId: 555 },
        },
      },
      ACC,
    );
    assert.equal(mapped?.sender, null);
  });
});
