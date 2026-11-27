/** اختبارات وحدة للتطبيع العربي المحافظ (الخطوة 5-أ، §6.6). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArabic, NORMALIZATION_VERSION } from '../src/modules/processing/normalization.js';

describe('التطبيع العربي المحافظ', () => {
  it('يترك النص العربي السليم كما هو (بلا تغيير دلالي)', () => {
    assert.equal(normalizeArabic('مطلوب مبرمج'), 'مطلوب مبرمج');
  });

  it('يزيل التشكيل والتطويل', () => {
    assert.equal(normalizeArabic('مَطــلُوب'), 'مطلوب');
  });

  it('يوحّد الألف والياء والهمزات', () => {
    assert.equal(normalizeArabic('أبحث عن أحمد'), normalizeArabic('ابحث عن احمد'));
    assert.equal(normalizeArabic('مصطفى'), normalizeArabic('مصطفي'));
    assert.equal(normalizeArabic('مسؤول'), normalizeArabic('مسوول'));
  });

  it('يحوّل الأرقام العربية والفارسية إلى لاتينية', () => {
    assert.equal(normalizeArabic('سعر ١٢٣'), 'سعر 123');
    assert.equal(normalizeArabic('سعر ۱۲۳'), 'سعر 123');
  });

  it('يوحّد المسافات والمحارف غير المرئية', () => {
    assert.equal(normalizeArabic('مطلوب   مبرمج\n\tعاجل'), 'مطلوب مبرمج عاجل');
    assert.equal(normalizeArabic('مطلوب\u200bمبرمج'), 'مطلوبمبرمج');
  });

  it('لا يطوي التاء المربوطة افتراضياً، ويطويها عند الطلب', () => {
    assert.equal(normalizeArabic('شقة'), 'شقة');
    assert.equal(normalizeArabic('شقة', { foldTaMarbuta: true }), 'شقه');
  });

  it('لا ينفّذ تجذيعاً ولا حذف سوابق افتراضياً', () => {
    assert.equal(normalizeArabic('والمطلوب'), 'والمطلوب');
    assert.equal(normalizeArabic('والمطلوب', { stripPrefixes: true }), 'مطلوب');
  });

  it('يحافظ على اللاتينية ويوحّد حالتها', () => {
    assert.equal(normalizeArabic('Python Developer'), 'python developer');
  });

  it('يتعامل مع النص الفارغ والمسافات فقط', () => {
    assert.equal(normalizeArabic(''), '');
    assert.equal(normalizeArabic('   '), '');
  });

  it('يحمل إصداراً رقمياً لتتبّع قابلية إعادة الإنتاج', () => {
    assert.equal(NORMALIZATION_VERSION, 1);
  });
});
