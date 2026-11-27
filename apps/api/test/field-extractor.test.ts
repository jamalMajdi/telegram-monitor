/**
 * اختبارات وحدة لمستخرج الحقول المقيَّد بالقرائن (الخطوة 5-ج، F05).
 * الثابت الأهم: **كل قيمة هي مقتطع حرفي من النص الأصلي** — لا اختراع ولا تلخيص.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRACTION_VERSION,
  extractFields,
  extractFieldsFromText,
  hasDigit,
  needsReview,
} from '../src/modules/processing/extraction/fieldExtractor.js';

function fieldOf(fields: ReturnType<typeof extractFields>, key: string) {
  return fields.find((field) => field.fieldKey === key);
}

describe('مستخرج الحقول: الالتزام بالقرائن', () => {
  it('يستخرج الحقل عند وجود قرينته ويُسند الموضع بدقة', () => {
    const text = 'مطلوب مبرمج بخبرة سنتين';
    const fields = extractFieldsFromText('text', text);
    const role = fieldOf(fields, 'role');
    assert.ok(role);
    assert.equal(role!.value, text.slice(role!.spanStart, role!.spanEnd), 'القيمة مقتطع حرفي');
    assert.equal(role!.cue, 'مطلوب');
  });

  it('لا يستخرج شيئاً بلا قرينة صريحة (لا تخمين من الكلمات)', () => {
    const text = 'مبرمج متاح للعمل، جاهز للتعاون، يرغب بمشاريع صغيرة';
    const fields = extractFieldsFromText('text', text);
    assert.deepEqual(fields.map((field) => field.fieldKey), []);
  });

  it('كل قيمة في كل الحقول مقتطع حرفي من المصدر ومن مصدره المعلن', () => {
    const text = [
      'مطلوب مصمم جرافيك',
      'المادة: الرياضيات',
      'الموقع: صنعاء',
      'الراتب: 400 دولار',
      'الموعد النهائي: 30 نوفمبر',
      'التقنيات: Photoshop',
    ].join('\n');
    const caption = 'المساحة: 120 متر';
    const fields = extractFields({ text, caption });
    assert.ok(fields.length >= 6);
    for (const field of fields) {
      const source = field.source === 'text' ? text : caption;
      assert.equal(field.value, source.slice(field.spanStart, field.spanEnd), `انحراف في ${field.fieldKey}`);
      assert.ok(field.value.trim().length > 0);
      assert.ok(field.confidence > 0 && field.confidence <= 0.95);
    }
  });

  it('يحذف الحقول الغائبة بدل ملئها بقيم افتراضية (§7.4)', () => {
    const fields = extractFieldsFromText('text', 'الموقع: عدن');
    assert.deepEqual(
      fields.map((field) => field.fieldKey),
      ['location'],
    );
  });

  it('يرفض قيمة بلا أرقام في حقل رقمي (لا اختراع رقم)', () => {
    const fields = extractFieldsFromText('text', 'الراتب: حسب الخبرة');
    assert.equal(fieldOf(fields, 'budget'), undefined);
  });

  it('يرفض موعداً بلا دلالة زمنية', () => {
    const fields = extractFieldsFromText('text', 'الموعد النهائي: قريباً جداً');
    assert.equal(fieldOf(fields, 'deadline'), undefined);
  });

  it('يقبل الحقل الرقمي عند وجود أرقام عربية-هندية', () => {
    const fields = extractFieldsFromText('text', 'عدد الأسئلة: ١٢ سؤال');
    const count = fieldOf(fields, 'question_count');
    assert.ok(count);
    assert.equal(count!.value, '١٢ سؤال', 'القيمة تُحفظ كما وردت');
    assert.ok(hasDigit(count!.value));
  });

  it('يوقف القيمة عند نهاية السطر ولا يعبر إلى سطر آخر', () => {
    const text = 'المادة: الرياضيات\nالموقع: صنعاء';
    const fields = extractFieldsFromText('text', text);
    assert.equal(fieldOf(fields, 'subject')!.value, 'الرياضيات');
    assert.equal(fieldOf(fields, 'location')!.value, 'صنعاء');
  });

  it('يوقف القيمة عند علامة ترقيم', () => {
    const fields = extractFieldsFromText('text', 'الموقع: صنعاء، والراتب: 500');
    assert.equal(fieldOf(fields, 'location')!.value, 'صنعاء');
  });

  it('يفضّل القرينة الأكثر تحديداً ولا يكرّر الحقل نفسه', () => {
    const fields = extractFieldsFromText('text', 'الموعد النهائي: 30 نوفمبر');
    const deadlines = fields.filter((field) => field.fieldKey === 'deadline');
    assert.equal(deadlines.length, 1);
    assert.equal(deadlines[0]!.cue, 'الموعد النهائي');
    assert.equal(deadlines[0]!.ambiguous, false);
  });

  it('يعلّم الغموض عند تعدّد قيم الحقل نفسه', () => {
    const fields = extractFieldsFromText('text', 'الموقع: صنعاء\nالموقع: عدن');
    const locations = fields.filter((field) => field.fieldKey === 'location');
    assert.equal(locations.length, 2);
    assert.ok(locations.every((location) => location.ambiguous), 'التعارض يُعلَن لا يُحسم صامتاً');
    assert.equal(needsReview(fields), true);
  });

  it('لا يستخرج قيمة هي قرينة حقل آخر', () => {
    const fields = extractFieldsFromText('text', 'مطلوب: الموقع');
    assert.equal(fieldOf(fields, 'role'), undefined);
  });

  it('يتعامل مع النص الفارغ بلا أخطاء', () => {
    assert.deepEqual(extractFields({ text: '', caption: '' }), []);
  });

  it('النتيجة حتمية عند تكرار التقييم', () => {
    const text = 'مطلوب مهندس مدني\nالراتب: 700 دولار';
    assert.deepEqual(extractFieldsFromText('text', text), extractFieldsFromText('text', text));
  });

  it('يحمل إصداراً رقمياً للاستخراج', () => {
    assert.equal(EXTRACTION_VERSION, 1);
  });
});
