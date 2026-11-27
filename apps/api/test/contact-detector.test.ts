/**
 * اختبارات وحدة لاكتشاف فئات التواصل والحجب (الخطوة 5-ج، O03 + D06).
 * الثابت: كل قيمة مرتبطة بموضعها في النص، ولكل قيمة صيغة عرض محجوبة لا تكشف الرقم كاملاً.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  contactsNeedReview,
  detectContacts,
  detectContactsInText,
  maskContact,
} from '../src/modules/processing/extraction/contactDetector.js';

function only<T>(items: T[]): T {
  assert.equal(items.length, 1, `متوقع عنصر واحد، وُجد ${items.length}`);
  return items[0]!;
}

describe('اكتشاف فئات التواصل', () => {
  it('يكتشف رقماً دولياً ويحجبه دون كشف كل الأرقام', () => {
    const text = 'للتواصل: +967 771 234 567';
    const contact = only(detectContactsInText('text', text));
    assert.equal(contact.kind, 'phone');
    assert.equal(contact.normalized, '967771234567');
    assert.equal(contact.raw, text.slice(contact.spanStart, contact.spanEnd), 'القيمة مقتطع حرفي');
    assert.ok(!contact.masked.includes('967771234567'), 'الحجب لا يعرض الرقم كاملاً');
    assert.ok(contact.masked.includes('•'));
    assert.ok(contact.confidence >= 0.9);
  });

  it('يقرأ الأرقام العربية-الهندية ويحولها لاتينياً', () => {
    const text = 'اتصل ٧٧١٢٣٤٥٦٧';
    const contact = only(detectContactsInText('text', text));
    assert.equal(contact.kind, 'phone');
    assert.equal(contact.normalized, '771234567');
    assert.equal(contact.raw, '٧٧١٢٣٤٥٦٧', 'الخام يبقى كما ورد');
  });

  it('يميّز رقم الجوال المحلي (7XXXXXXXX) عن الأرقام القصيرة الغامضة', () => {
    const local = only(detectContactsInText('text', 'جوال: 771234567'));
    assert.equal(local.ambiguous, false);
    assert.equal(local.confidence, 0.75);

    const short = only(detectContactsInText('text', 'رقمي 12345678'));
    assert.equal(short.ambiguous, true, 'رقم قصير قد يكون معرّف حساب');
    assert.equal(contactsNeedReview([short]), true);
  });

  it('يكتشف اسم مستخدم تيليجرام بصيغتيه (@ و رابط)', () => {
    const mention = only(detectContactsInText('text', 'راسلني على @ahmed_dev'));
    assert.equal(mention.kind, 'username');
    assert.equal(mention.normalized, 'ahmed_dev');

    const link = only(detectContactsInText('text', 'https://t.me/ahmed_dev'));
    assert.equal(link.kind, 'username');
    assert.equal(link.normalized, 'ahmed_dev');
  });

  it('يصنّف رابط الدعوة كفئة أخطر ويحجبه كاملاً', () => {
    const contact = only(detectContactsInText('text', 'انضم: https://t.me/+AbCdEf123456'));
    assert.equal(contact.kind, 'invite_link');
    assert.equal(contact.masked, 'https://t.me/•••');
    assert.ok(!contact.masked.includes('AbCdEf123456'));
  });

  it('يكتشف البريد الإلكتروني ويحجب جزأه المحلي', () => {
    const contact = only(detectContactsInText('text', 'راسلني: info@example.com'));
    assert.equal(contact.kind, 'email');
    assert.equal(contact.masked, 'i••o@example.com');
  });

  it('يكتشف رقم واتساب داخل رابط كهاتف', () => {
    const contact = only(detectContactsInText('text', 'https://wa.me/967771234567'));
    assert.equal(contact.kind, 'phone');
    assert.equal(contact.normalized, '967771234567');
  });

  it('يكتشف المعرّف الرقمي عند وجود قرينة صريحة', () => {
    const contact = only(detectContactsInText('text', 'معرفي: 123456789'));
    assert.equal(contact.kind, 'telegram_id');
    assert.equal(contact.normalized, '123456789');
    assert.equal(contact.masked, 'id:123••••89');
  });

  it('يكتشف رابطاً عاماً ويحجب مساره', () => {
    const contact = only(detectContactsInText('text', 'التفاصيل: https://example.com/path/secret'));
    assert.equal(contact.kind, 'url');
    assert.equal(contact.masked, 'https://example.com/•••');
  });

  it('لا يكرّر الفئة نفسها لرقم داخل رابط (الأكثر تحديداً يفوز)', () => {
    const contacts = detectContactsInText('text', 'https://t.me/+AbCdEf123456 و @ahmed_dev');
    assert.deepEqual(
      contacts.map((contact) => contact.kind),
      ['invite_link', 'username'],
    );
  });

  it('يجمع بين نص الرسالة وتعليقها مع إبقاء مصدر كل قيمة', () => {
    const contacts = detectContacts({ text: 'جوال +967771234567', caption: 'أو @ahmed_dev' });
    assert.equal(contacts.length, 2);
    assert.equal(contacts.find((contact) => contact.kind === 'phone')!.source, 'text');
    assert.equal(contacts.find((contact) => contact.kind === 'username')!.source, 'caption');
  });

  it('لا يكتشف شيئاً في نص بلا وسائل تواصل', () => {
    assert.deepEqual(detectContactsInText('text', 'شقة للإيجار في صنعاء، السعر مناسب'), []);
  });

  it('دالة الحجب وحدها لا تكشف القيم الحسّاسة', () => {
    assert.equal(maskContact('phone', '0771234567'), '077•••••67');
    assert.equal(maskContact('username', 'ahmed_dev'), '@a•••••••v');
    assert.equal(maskContact('email', 'someone@host.com'), 's•••••e@host.com');
  });

  it('المسافات والشرطات داخل الرقم لا تُفسد التطبيع', () => {
    const contact = only(detectContactsInText('text', 'هاتف: 0771-234-567'));
    assert.equal(contact.normalized, '0771234567');
    assert.equal(contact.raw, '0771-234-567');
  });
});
