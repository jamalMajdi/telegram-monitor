/**
 * قوالب البريد الصادرة (P0 — تدقيق ما قبل التسليم).
 *
 * المبدأ نفسه المطبَّق على التنبيهات الداخلية: **لا نص حر من بيانات المستخدم**،
 * ولا محتوى رسائل، ولا أرقام تواصل، ولا رموز في السجلات. كل قالب يُبنى من `template`
 * مغلق + `payload` أرقام/رموز مغلقة، والواجهة/الرسالة تُركَّب هنا في الخادم.
 *
 * الرمز الوحيد السرّي (استعادة كلمة المرور) يصل **مشفَّراً** في `payload.sealed`
 * ويُفكّ لحظة الإرسال فقط، ولا يُسجَّل ولا يُعاد في أي استجابة.
 */
import { openPayload } from '../telegram/sessionCipher.js';
import type { Env } from '../../config/env.js';

export type MailTemplate =
  | 'auth.password_reset'
  | 'alerts.raised'
  | 'alerts.cleared';

export interface BuiltMail {
  subject: string;
  text: string;
}

export interface TemplateContext {
  appUrl: string;
  /** وقت الحدث بصيغة نصية (يُبنى في الخادم لا في القالب). */
  now?: Date;
}

const SEVERITY_AR: Record<string, string> = {
  info: 'معلومة',
  warning: 'تحذير',
  critical: 'حرج',
};

/** أسماء مفاتيح التنبيه بالعربية — قاموس مغلق مطابق للواجهة. */
const ALERT_AR: Record<string, string> = {
  publish_worker_stale: 'عامل النشر لا يعمل',
  uncertain_delivery: 'تسليمات بنتيجة مجهولة تحتاج دقّة بشرية',
  needs_reauth: 'حساب تيليجرام يحتاج إعادة دخول',
  awaiting_review: 'تسليمات بانتظار موافقتك',
  no_source: 'لا يوجد مصدر مراقبة بعد',
  no_destination: 'لا توجد وجهة نشر نشطة',
  destination_failures: 'وجهة نشر تتعرض لإخفاقات متكررة',
};

export function alertTitle(key: string): string {
  return ALERT_AR[key] ?? 'تنبيه من المنصة';
}

function formatWhen(date: Date): string {
  return new Intl.DateTimeFormat('ar', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * يفكّ كبسولة رمز الاستعادة من حمولة الصف.
 * يعيد null عند غياب المفتاح أو تلف المغلّف — والمستهلك يقرر (يرسل قالباً بديلاً أو يؤجل).
 */
export function openResetToken(input: {
  sealed: unknown;
  subjectId: string;
  env: Pick<Env, 'TG_SESSION_ENC_KEY' | 'TG_SESSION_ENC_KEY_PREVIOUS' | 'TG_SESSION_ENC_KEY_VERSION'>;
}): string | null {
  const sealed = input.sealed;
  if (typeof sealed !== 'string' || sealed.length < 24) return null;
  try {
    const opened = openPayload<{ token: string }>('login', input.subjectId, Buffer.from(sealed, 'base64'), {
      TG_SESSION_ENC_KEY: input.env.TG_SESSION_ENC_KEY,
      TG_SESSION_ENC_KEY_PREVIOUS: input.env.TG_SESSION_ENC_KEY_PREVIOUS,
      TG_SESSION_ENC_KEY_VERSION: input.env.TG_SESSION_ENC_KEY_VERSION,
    } as never);
    const token = opened.value?.token;
    return typeof token === 'string' && token.length >= 16 ? token : null;
  } catch {
    return null;
  }
}

/**
 * يبني موضوع الرسالة ونصها من قالب مغلق.
 * يعيد null إذا كان القالب مجهولاً (رسالة تُهمَل صراحةً بدل إرسال نص مشوّه).
 */
export function buildMail(input: {
  template: string;
  payload: Record<string, unknown>;
  subjectId: string | null;
  env: Pick<Env, 'TG_SESSION_ENC_KEY' | 'TG_SESSION_ENC_KEY_PREVIOUS' | 'TG_SESSION_ENC_KEY_VERSION'>;
  context: TemplateContext;
}): BuiltMail | null {
  const { template, payload, context } = input;
  const appUrl = context.appUrl.replace(/\/+$/, '');

  if (template === 'auth.password_reset') {
    const expiresAt = typeof payload.expiresAt === 'string' ? payload.expiresAt : null;
    const sp = typeof payload.sp === 'string' ? payload.sp : '';
    const token =
      input.env.TG_SESSION_ENC_KEY && input.subjectId
        ? openResetToken({ sealed: payload.sealed, subjectId: input.subjectId, env: input.env })
        : null;
    if (!token) {
      // لا رمز ⇒ لا رسالة مضلّلة: المستخدم يُطلب منه التواصل مع المدير.
      return {
        subject: 'تعذّر إنشاء رابط استعادة كلمة المرور',
        text: [
          'طُلب إعادة تعيين كلمة المرور لحسابك في منصة الرصد والنشر، لكن تعذّر إنشاء رابط آمن الآن.',
          'يرجى التواصل مع مدير النظام لإعادة التعيين يدوياً.',
          '',
          'إن لم تطلب ذلك، تجاهل هذه الرسالة.',
        ].join('\n'),
      };
    }
    const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}${sp ? `&sp=${encodeURIComponent(sp)}` : ''}`;
    return {
      subject: 'استعادة كلمة المرور — منصة الرصد والنشر',
      text: [
        'مرحباً،',
        '',
        'وصلنا طلب لإعادة تعيين كلمة المرور لحسابك في منصة الرصد والنشر.',
        'افتح الرابط التالي لتعيين كلمة مرور جديدة:',
        '',
        link,
        '',
        expiresAt ? `صلاحية الرابط حتى: ${formatWhen(new Date(expiresAt))} (UTC).` : '',
        'إن لم تطلب ذلك، تجاهل هذه الرسالة — كلمة مرورك الحالية تبقى صالحة.',
        '',
        'لا تشارك هذا الرابط مع أي شخص.',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    };
  }

  if (template === 'alerts.raised') {
    const key = typeof payload.alertKey === 'string' ? payload.alertKey : '';
    const severity = typeof payload.severity === 'string' ? payload.severity : 'warning';
    const count = typeof payload.count === 'number' ? payload.count : 0;
    const title = alertTitle(key);
    return {
      subject: `[${SEVERITY_AR[severity] ?? 'تنبيه'}] ${title}`,
      text: [
        `تنبيه في منصة الرصد والنشر: ${title}`,
        `الخطورة: ${SEVERITY_AR[severity] ?? 'تنبيه'}`,
        count ? `العدد المرصود: ${count}` : '',
        `الوقت: ${formatWhen(context.now ?? new Date())} (UTC)`,
        '',
        `افتح مركز التنبيهات: ${appUrl}/notifications`,
        '',
        'هذه رسالة آلية؛ لا تُرسل بيانات رسائل أو أرقام تواصل.',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    };
  }

  if (template === 'alerts.cleared') {
    const key = typeof payload.alertKey === 'string' ? payload.alertKey : '';
    const title = alertTitle(key);
    return {
      subject: `[عاد لطبيعته] ${title}`,
      text: [
        `عادت الحالة إلى طبيعتها: ${title}`,
        `الوقت: ${formatWhen(context.now ?? new Date())} (UTC)`,
        '',
        `مركز التنبيهات: ${appUrl}/notifications`,
      ].join('\n'),
    };
  }

  return null;
}
