/** اختبارات وحدة لخريطة فهارس التطبيع (الخطوة 5-ج): الأساس الذي يجعل المواضع (spans) صحيحة. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArabic, normalizeWithMapping } from '../src/modules/processing/normalization.js';

const SAMPLES = [
  'مطلوب مبرمج',
  'مَطــلُوبُ مبرمجٌ بخبرة',
  'الراتب ١٢٣ دولار',
  'مسافات   متعددة\n\nوأسطر',
  'React Developer 2026',
  '',
  '   ',
  'شقة للإيجار ۱۲۳ متر',
];

describe('خريطة فهارس التطبيع', () => {
  it('تُنتج خريطة بطول النص المطبَّع نفسه', () => {
    for (const sample of SAMPLES) {
      const { text, map } = normalizeWithMapping(sample);
      assert.equal(map.length, text.length, `طول الخريطة لا يطابق النص: ${sample}`);
      assert.equal(text, normalizeArabic(sample), 'النتيجة مطابقة لدالة التطبيع العامة');
    }
  });

  it('كل فهرس داخل حدود النص الأصلي وغير متناقص', () => {
    for (const sample of SAMPLES) {
      const { map } = normalizeWithMapping(sample);
      let previous = -1;
      for (const index of map) {
        assert.ok(index >= 0 && index < Math.max(1, sample.length), 'فهرس خارج النص');
        assert.ok(index >= previous, 'الخريطة يجب أن تكون تصاعدية');
        previous = index;
      }
    }
  });

  it('يحافظ على المواضع عند حذف التشكيل والتطويل', () => {
    const original = 'مَطلوبُ مبرمج';
    const { text, map } = normalizeWithMapping(original);
    const at = text.indexOf('مبرمج');
    assert.ok(at > 0);
    // بداية «مبرمج» في النص الأصلي = الموضع الذي تشير إليه الخريطة.
    assert.equal(original.slice(map[at]!, map[at]! + 6), 'مبرمج');
  });

  it('يوحّد الأرقام العربية-الهندية بطول ثابت فلا تتغيّر المواضع', () => {
    const original = 'السعر ١٢٣ ريال';
    const { text, map } = normalizeWithMapping(original);
    assert.equal(text, 'السعر 123 ريال');
    const digitsAt = text.indexOf('123');
    assert.equal(original.slice(map[digitsAt]!, map[digitsAt]! + 3), '١٢٣');
    assert.equal(map.length, original.length);
  });

  it('يقصّ المسافات الطرفية مع إبقاء الخريطة متوازية', () => {
    const { text, map } = normalizeWithMapping('   نص   ');
    assert.equal(text, 'نص');
    assert.equal(map.length, text.length);
    assert.equal(map[0], 3, 'أول محرف مطبَّع يشير إلى أول محرف غير مسافة');
  });
});
