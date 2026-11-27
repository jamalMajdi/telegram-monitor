/**
 * قوالب البريد الصادرة (P0) — اختبارات وحدة.
 *
 * المحاور: كل قالب مغلق يُبنى نصاً عربياً كاملاً، والرمز السرّي لا يُدرَج إلا من كبسولة
 * صالحة، وقالب مجهول يُعيد null صراحةً (لا رسالة مشوّهة)، ومفتاح `destination_failures`
 * الجديد له عنوان عربي (لا عنوان فارغ كما كان قبل الإصلاح).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildMail, alertTitle, openResetToken } from '../src/modules/notifications/mailTemplates.js';
import { sealPayload } from '../src/modules/telegram/sessionCipher.js';

const env = {
  TG_SESSION_ENC_KEY: randomBytes(32).toString('base64'),
  TG_SESSION_ENC_KEY_PREVIOUS: undefined,
  TG_SESSION_ENC_KEY_VERSION: '1',
} as never;

const context = { appUrl: 'https://app.example.test/', now: new Date('2026-11-24T09:30:00Z') };
const subjectId = '11111111-2222-4333-8444-555555555555';

function seal(token: string): string {
  // نفس حلقة المفاتيح التي يفكّ بها القالب (وإلا فشل الفكّ بحق — وهذه عزلة اختبار لا خلل إنتاج).
  return sealPayload('login', subjectId, { token }, env).ciphertext.toString('base64');
}

describe('قالب استعادة كلمة المرور', () => {
  it('يبني رابطاً بالرمز المفكوك من الكبسولة', () => {
    const token = 'reset_token_value_1234567890';
    const mail = buildMail({
      template: 'auth.password_reset',
      payload: { expiresAt: '2026-11-24T10:00:00.000Z', sealed: seal(token) },
      subjectId,
      env,
      context,
    });
    assert.ok(mail);
    assert.equal(mail.subject, 'استعادة كلمة المرور — منصة الرصد والنشر');
    assert.ok(mail.text.includes(`https://app.example.test/reset-password?token=${token}`), 'الرابط بلا شرطة زائدة');
    assert.ok(mail.text.includes('صلاحية الرابط حتى'), 'الصلاحية مذكورة');
    assert.ok(!mail.text.includes('sealed'), 'المغلّف الخام لا يظهر في النص');
  });

  it('لا يبني رابطاً عند تلف الكبسولة — بل قالب «تواصل مع المدير»', () => {
    const mail = buildMail({
      template: 'auth.password_reset',
      payload: { expiresAt: '2026-11-24T10:00:00.000Z', sealed: seal('another_token_value_0987654321').slice(0, -8) + 'AAAAAAAA' },
      subjectId,
      env,
      context,
    });
    assert.ok(mail);
    assert.ok(!mail.text.includes('/reset-password?token='), 'لا رابط معطوب');
    assert.ok(mail.text.includes('مدير النظام'), 'يُوجَّه المستخدم للمدير');
  });

  it('يعيد null إذا كان المغلّف لمعرّف مستخدم آخر (AAD)', () => {
    const mail = buildMail({
      template: 'auth.password_reset',
      payload: { sealed: seal('token_for_other_user_1234') },
      subjectId: '99999999-8888-4777-8666-555555555555',
      env,
      context,
    });
    assert.ok(mail);
    assert.ok(!mail.text.includes('/reset-password?token='), 'الكبسولة لا تُفكّ لغير صاحبها');
  });

  it('openResetToken يرفض القيم غير النصية والقصيرة', () => {
    assert.equal(openResetToken({ sealed: null, subjectId, env }), null);
    assert.equal(openResetToken({ sealed: 'short', subjectId, env }), null);
    assert.equal(openResetToken({ sealed: 42, subjectId, env }), null);
  });
});

describe('قوالب التنبيهات', () => {
  it('alerts.raised يحمل عنواناً عربياً وخطورةً ورابط المركز', () => {
    const mail = buildMail({
      template: 'alerts.raised',
      payload: { alertKey: 'destination_failures', severity: 'critical', count: 2 },
      subjectId: null,
      env,
      context,
    });
    assert.ok(mail);
    assert.equal(mail.subject, '[حرج] وجهة نشر تتعرض لإخفاقات متكررة');
    assert.ok(mail.text.includes('العدد المرصود: 2'));
    assert.ok(mail.text.includes('https://app.example.test/notifications'));
  });

  it('alerts.cleared يُعلم بعودة الحالة لطبيعتها', () => {
    const mail = buildMail({
      template: 'alerts.cleared',
      payload: { alertKey: 'needs_reauth' },
      subjectId: null,
      env,
      context,
    });
    assert.ok(mail);
    assert.ok(mail.subject.includes('عاد لطبيعته'));
    assert.ok(mail.text.includes('حساب تيليجرام يحتاج إعادة دخول'));
  });

  it('كل مفاتيح التنبيه المعروفة لها عنوان عربي غير افتراضي', () => {
    const keys = [
      'publish_worker_stale',
      'uncertain_delivery',
      'needs_reauth',
      'awaiting_review',
      'no_source',
      'no_destination',
      'destination_failures',
    ];
    for (const key of keys) {
      assert.notEqual(alertTitle(key), 'تنبيه من المنصة', `المفتاح ${key} له عنوان`);
    }
    assert.equal(alertTitle('something_unknown'), 'تنبيه من المنصة');
  });

  it('قالب مجهول ⇒ null (لا رسالة مشوّهة)', () => {
    assert.equal(
      buildMail({ template: 'x.unknown', payload: {}, subjectId: null, env, context }),
      null,
    );
  });
});
