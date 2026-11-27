/**
 * اختبارات وحدة لباني المنشور (الدفعة 7-ج) — بلا قاعدة بيانات وبلا شبكة.
 *
 * تغطي: قياس الطول بعد تحليل الكيانات (لا بعدد المحارف الخام)، الترميز الآمن، حذف الحقول الغائبة،
 * التقسيم عند حدود الجملة/الكلمة دون اقتطاع، سقف الأجزاء وسياسة الرفض، والحجب النهائي مع الرفض الآمن.
 */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLines,
  enforceMasking,
  escapeHtml,
  htmlVisibleLength,
  htmlVisibleText,
  planPost,
  splitValue,
  TELEGRAM_TEXT_LIMIT,
} from '../src/modules/publishing/publisher.js';
import { detectContacts } from '../src/modules/processing/extraction/contactDetector.js';

function plan(source: { title?: string | null; fields: { label: string; value: string }[] }, extra: Partial<{
  limit: number;
  maxParts: number;
  policy: 'split' | 'reject';
  detect: typeof detectContacts;
}> = {}) {
  return planPost({
    source: { title: source.title ?? null, fields: source.fields },
    maxParts: extra.maxParts ?? 10,
    policy: extra.policy ?? 'split',
    ...(extra.limit ? { limit: extra.limit } : {}),
    ...(extra.detect ? { detect: extra.detect } : {}),
  });
}

describe('قياس الطول بعد تحليل الكيانات', () => {
  it('لا يحتسب وسوم HTML ويعدّ الكيان محرفاً واحداً', () => {
    assert.equal(htmlVisibleLength('<b>عنوان</b>'), 5);
    assert.equal(htmlVisibleLength('A &amp; B'), 5);
    assert.equal(htmlVisibleLength('<b>a</b> &lt;b&gt;'), 5);
    assert.equal(htmlVisibleText('<b>x</b> &amp; <i>y</i>'), 'x & y');
  });

  it('يعدّ المحرف المركّب (surrogate) محرفاً واحداً', () => {
    assert.equal(htmlVisibleLength('📌'), 1);
    assert.equal(htmlVisibleText('<b>📌</b>'), '📌');
  });

  it('يرمّز المحارف الخاصة فقط', () => {
    assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
    assert.equal(escapeHtml('نص عربي عادي'), 'نص عربي عادي');
  });
});

describe('بناء الأسطر', () => {
  it('يجمع العنوان والفاصل والحقول ويحذف القيم الفارغة', () => {
    const built = buildLines(
      {
        title: 'قالب الوظائف',
        fields: [
          { label: 'المسمى', value: 'مطور' },
          { label: 'الموقع', value: '   ' },
          { label: 'التفاصيل', value: 'خبرة سنتين' },
        ],
      },
      TELEGRAM_TEXT_LIMIT,
    );
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const visible = htmlVisibleText(built.lines.map((line) => line.html).join('\n'));
    assert.ok(visible.includes('قالب الوظائف'));
    assert.ok(visible.includes('المسمى: مطور'));
    assert.ok(visible.includes('التفاصيل: خبرة سنتين'));
    assert.equal(visible.includes('الموقع'), false, 'الحقل الفارغ يُحذف ولا يُملأ');
  });

  it('يرفض المحتوى الفارغ بدل إرسال رسالة بيضاء', () => {
    const built = buildLines({ title: null, fields: [{ label: 'x', value: '  ' }] }, TELEGRAM_TEXT_LIMIT);
    assert.equal(built.ok, false);
  });
});

describe('التقسيم إلى أجزاء', () => {
  it('يبقي المنشور القصير في جزء واحد', () => {
    const result = plan({ title: 'فرصة', fields: [{ label: 'المسمى', value: 'مطور' }] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.parts.length, 1);
    assert.equal(result.parts[0]?.visibleLength, htmlVisibleLength(result.parts[0]!.html));
    assert.ok(result.parts[0]!.visibleLength <= TELEGRAM_TEXT_LIMIT);
  });

  it('يقسّم النص الطويل دون فقدان أي محرف ودون تجاوز الحد', () => {
    const paragraph = 'هذا نص تفصيلي طويل يشرح متطلبات الوظيفة وشروط التقديم والمواعيد النهائية. ';
    const longValue = paragraph.repeat(120).trim();
    const result = plan({ title: 'تفاصيل', fields: [{ label: 'الوصف', value: longValue }] }, { maxParts: 20 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.parts.length > 1, 'النص الطويل يجب أن يُقسَّم');
    for (const part of result.parts) {
      assert.ok(part.visibleLength <= TELEGRAM_TEXT_LIMIT, `الجزء ${part.index} تجاوز الحد: ${part.visibleLength}`);
      assert.equal(part.visibleLength, htmlVisibleLength(part.html));
      assert.ok(part.visibleLength > 0, 'لا أجزاء فارغة');
    }
    // كل كلمات القيمة موجودة في مجموع الأجزاء (لا اقتطاع صامت).
    const joined = result.parts.map((part) => htmlVisibleText(part.html)).join(' ');
    const words = new Set(longValue.split(/\s+/));
    for (const word of words) {
      if (!word) continue;
      assert.ok(joined.includes(word), `كلمة مفقودة بعد التقسيم: ${word}`);
    }
  });

  it('لا يقطع داخل كيان HTML', () => {
    // القيمة الخام تحمل محرف & فقط؛ الترميز يحوّله إلى &amp; داخل كل جزء.
    const value = 'A & B '.repeat(400);
    const result = plan({ title: null, fields: [{ label: 'قيمة', value }] }, { maxParts: 20 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    for (const part of result.parts) {
      assert.match(part.html, /&amp;/, 'الكيان محفوظ كاملاً داخل الجزء');
      assert.equal(/&[a-z]*$/.test(part.html), false, 'لا ينتهي الجزء بكيان مقطوع');
      assert.equal(/&(?![a-z]+;)/.test(part.html.replace(/<!--.*?-->/g, '')), false, 'لا كيان ناقص داخل الجزء');
    }
  });

  it('يرفض تجاوز سقف الأجزاء بدل إغراق القناة', () => {
    const value = 'كلمة '.repeat(3000);
    const result = plan({ title: null, fields: [{ label: 'قيمة', value }] }, { maxParts: 2 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'too_long');
  });

  it('سياسة الرفض تمنع أي منشور متعدد الأجزاء', () => {
    const value = 'نص طويل '.repeat(1200);
    const split = plan({ title: null, fields: [{ label: 'قيمة', value }] }, { maxParts: 10 });
    assert.equal(split.ok, true);
    const rejected = plan({ title: null, fields: [{ label: 'قيمة', value }] }, { maxParts: 10, policy: 'reject' });
    assert.equal(rejected.ok, false);
    if (rejected.ok) return;
    assert.equal(rejected.reason, 'too_long');
  });

  it('يقسّم القيمة عند حد الجملة ثم الكلمة', () => {
    const pieces = splitValue('جملة أولى. جملة ثانية. جملة ثالثة.', 20);
    assert.ok(pieces.length >= 2);
    assert.equal(pieces.join(' ').replace(/\s+/g, ' '), 'جملة أولى. جملة ثانية. جملة ثالثة.');
  });
});

describe('الحجب النهائي (O03)', () => {
  it('يحجب رقم هاتف ظهر في قيمة خامة', () => {
    const result = plan({ title: 'تواصل', fields: [{ label: 'الجوال', value: 'اتصل على 0770123456' }] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const visible = htmlVisibleText(result.parts.map((part) => part.html).join('\n'));
    assert.equal(/0770123456/.test(visible), false, 'الرقم الخام يجب ألا يظهر');
    assert.ok(result.maskingRewrites >= 1);
  });

  it('يحجب البريد والاسم والمعرّف والرابط', () => {
    const value = 'راسلني على user@example.com أو @contact_me أو https://t.me/someone';
    const masked = enforceMasking(value);
    assert.equal(masked.ok, true);
    if (!masked.ok) return;
    assert.equal(masked.text.includes('user@example.com'), false);
    assert.equal(masked.text.includes('@contact_me'), false);
    assert.equal(masked.text.includes('https://t.me/someone'), false);
    assert.ok(masked.rewrites >= 2);
  });

  it('لا يغيّر نصاً نظيفاً', () => {
    const masked = enforceMasking('مطلوب مطور بخبرة سنتين في عدن');
    assert.equal(masked.ok, true);
    if (!masked.ok) return;
    assert.equal(masked.rewrites, 0);
    assert.equal(masked.text, 'مطلوب مطور بخبرة سنتين في عدن');
  });

  it('يرفض المنشور كاملاً إذا فشل فحص الحجب (رفض آمن)', () => {
    const failing = (() => {
      throw new Error('detector exploded');
    }) as unknown as typeof detectContacts;
    const result = plan({ title: 'x', fields: [{ label: 'y', value: 'z' }] }, { detect: failing });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'masking_failed');
    assert.deepEqual(result.parts, []);
  });
});
