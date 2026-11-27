/** اختبارات وحدة لحدود المحتوى وبصمته (الخطوة 5-ب، Q3/Q11/Q6). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_LIMITS, charLength, contentHash, prepareContent } from '../src/modules/processing/contentTypes.js';

describe('حدود المحتوى', () => {
  it('يقبل نصاً عادياً ويحفظه كما ورد تماماً', () => {
    const original = '  مطلوب  مبرمج\nبخبرة سنتين  ';
    const result = prepareContent({ text: original, caption: '' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, original, 'لا اقتطاع ولا تطبيع للنص المحفوظ (D04)');
    assert.equal(result.caption, '');
    assert.equal(result.textLength, charLength(original));
  });

  it('يعتبر الرسالة بلا نص ولا تعليق فارغة (وسائط فقط، Q3)', () => {
    assert.deepEqual(prepareContent({ text: '', caption: '' }), { ok: false, reason: 'no_text' });
    assert.deepEqual(prepareContent({ text: '   ', caption: '\n\t' }), { ok: false, reason: 'no_text' });
  });

  it('يقبل تعليقاً وحده (D06: التعليق يُعامل كنص)', () => {
    const result = prepareContent({ text: '', caption: 'شقة للإيجار' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.caption, 'شقة للإيجار');
    assert.equal(result.text, '');
  });

  it('يرفض تجاوز حد النص بلا اقتطاع (Q11)', () => {
    const result = prepareContent({ text: 'ا'.repeat(CONTENT_LIMITS.text + 1), caption: '' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'too_long');
  });

  it('يرفض تجاوز حد التعليق', () => {
    const result = prepareContent({ text: '', caption: 'ا'.repeat(CONTENT_LIMITS.caption + 1) });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'too_long');
  });

  it('يقبل الحد الأقصى بالضبط ويرفض ما فوقه', () => {
    const atLimit = prepareContent({ text: 'ا'.repeat(CONTENT_LIMITS.text), caption: 'ب'.repeat(CONTENT_LIMITS.caption) });
    assert.equal(atLimit.ok, true);
    const above = prepareContent({ text: 'ا'.repeat(CONTENT_LIMITS.text + 1), caption: '' });
    assert.equal(above.ok, false);
  });

  it('يحسب الطول بوحدات Unicode لا بوحدات UTF-16', () => {
    const emoji = '🙂'.repeat(3);
    assert.equal(charLength(emoji), 3);
    const result = prepareContent({ text: emoji, caption: '' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.textLength, 3);
  });

  it('يبني بصمة مستقرة تتجاهل التشكيل والمسافات الزائدة', () => {
    const a = contentHash('مطلوب مبرمج', '');
    const b = contentHash('مَطلوب   مبرمج', '');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('يفصل بين النص والتعليق في البصمة', () => {
    assert.notEqual(contentHash('أ ب', ''), contentHash('أ', 'ب'));
  });
});
