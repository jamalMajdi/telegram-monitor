/**
 * اكتشاف فئات التواصل (الخطوة 5-ج، O03 + D06).
 *
 * يكتشف: أرقام الهواتف، معرّفات/أسماء تيليجرام، الروابط، روابط الدعوة، البريد الإلكتروني.
 * الأرقام العربية-الهندية والفارسية تُحوَّل إلى لاتينية **بطول ثابت** فلا تتغيّر المواضع.
 *
 * سياسة الحجب (O03): كل قيمة تُخزَّن مع `masked` جاهزة للعرض، والحجب يشمل:
 * أرقام الهواتف، روابط التواصل، ومعرّفات الحساب. لا تُعاد القيمة الخام في أي واجهة.
 * عند التعارض (نفس النص يصلح لأكثر من فئة) تُرجَّح الفئة الأكثر تحديداً ويُعلَّم الغموض.
 */
import type { FieldSource } from './fieldExtractor.js';

export type ContactKind = 'phone' | 'username' | 'telegram_id' | 'email' | 'url' | 'invite_link';

export interface DetectedContact {
  kind: ContactKind;
  /** القيمة كما وردت حرفياً في النص (تُخزَّن مع المحتوى وتُحذف بمدة الاحتفاظ). */
  raw: string;
  /** صيغة مطبَّعة للمقارنة (أرقام لاتينية، بلا مسافات/رموز). */
  normalized: string;
  /** صيغة عرض آمنة افتراضية (O03). */
  masked: string;
  spanStart: number;
  spanEnd: number;
  source: FieldSource;
  confidence: number;
  /** احتمال أن الرقم معرّف حساب لا هاتف، أو تداخل فئات (Q7). */
  ambiguous: boolean;
}

/** تحويل الأرقام العربية/الفارسية إلى لاتينية مع الحفاظ على الطول والمواضع. */
export function foldDigitsKeepingLength(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (digit) => {
    const code = digit.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) return String.fromCharCode(code - 0x0660 + 48);
    return String.fromCharCode(code - 0x06f0 + 48);
  });
}

/** أرقام لاتينية فقط (للتطبيع والتخزين). */
function digitsOnly(value: string): string {
  return foldDigitsKeepingLength(value).replace(/\D+/g, '');
}

function maskDigits(digits: string): string {
  if (digits.length <= 4) return '•'.repeat(digits.length);
  const head = digits.slice(0, 3);
  const tail = digits.slice(-2);
  return `${head}${'•'.repeat(Math.max(1, digits.length - head.length - tail.length))}${tail}`;
}

function maskHandle(handle: string): string {
  if (handle.length <= 2) return '•'.repeat(handle.length);
  return `${handle.slice(0, 1)}${'•'.repeat(Math.max(1, handle.length - 2))}${handle.slice(-1)}`;
}

/** يحجب جزء المسار من رابط مع إبقاء النطاق مقروءاً. */
function maskUrl(value: string): string {
  const trimmed = value.replace(/[.,;:!?؟؛،)»"']+$/, '');
  const match = /^(?:(https?):\/\/)?([^/\s]+)(\/.*)?$/i.exec(trimmed);
  if (!match) return '•••';
  const scheme = match[1] ? `${match[1].toLowerCase()}://` : '';
  const host = match[2] ?? '';
  return match[3] ? `${scheme}${host}/•••` : `${scheme}${host}`;
}

/** يبني الصيغة المعروضة الآمنة لقيمة تواصل معيّنة. */
export function maskContact(kind: ContactKind, normalized: string, raw?: string): string {
  switch (kind) {
    case 'phone':
      return maskDigits(normalized);
    case 'username':
      return `@${maskHandle(normalized.replace(/^@/, ''))}`;
    case 'telegram_id':
      return `id:${maskDigits(normalized)}`;
    case 'email': {
      const [local = '', domain = ''] = normalized.split('@');
      return `${maskHandle(local)}@${domain}`;
    }
    case 'url':
      return maskUrl(raw ?? normalized);
    case 'invite_link':
      return maskUrl(raw ?? normalized);
  }
}

interface Pattern {
  kind: ContactKind;
  regex: RegExp;
  confidence: number;
  normalize: (raw: string) => string;
  ambiguous?: (raw: string, normalized: string) => boolean;
}

const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;

function phoneConfidence(raw: string, digits: string): number {
  if (/^\s*\+/.test(raw)) return 0.92;
  if (/^\s*00/.test(raw)) return 0.86;
  if (/^0/.test(digits)) return 0.8;
  // رقم جوال محلي بلا رمز دولة (نمط شائع في اليمن: 7XXXXXXXX).
  if (/^7\d{8}$/.test(digits)) return 0.75;
  return 0.6;
}

/** الأنماط مرتَّبة من الأكثر تحديداً إلى الأعمّ (الأولوية عند التداخل). */
const PATTERNS: Pattern[] = [
  {
    // رابط دعوة: يحمل مفتاحاً سرّياً ⇒ أخطر ما يجب حجبه.
    kind: 'invite_link',
    regex: /(?:(?:https?:\/\/)?(?:t|telegram)\.me\/\+[A-Za-z0-9_-]{8,})/gi,
    confidence: 0.85,
    normalize: (raw) => raw.trim().replace(/^https?:\/\//i, '').toLowerCase(),
  },
  {
    // بريد إلكتروني.
    kind: 'email',
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    confidence: 0.88,
    normalize: (raw) => raw.trim().toLowerCase(),
  },
  {
    // هواتف في روابط واتساب: wa.me/<رقم>.
    kind: 'phone',
    regex: /(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?\+?\d{7,15}/gi,
    confidence: 0.9,
    normalize: (raw) => digitsOnly(raw),
  },
  {
    // اسم مستخدم صريح داخل رابط تيليجرام.
    kind: 'username',
    regex: /(?:(?:https?:\/\/)?(?:t|telegram)\.me\/(?:@)?)([A-Za-z][A-Za-z0-9_]{4,31})(?![A-Za-z0-9_])/g,
    confidence: 0.9,
    normalize: (raw) => raw.trim().split('/').pop()!.replace(/^@/, '').toLowerCase(),
  },
  {
    // معرّف رقمي صريح بقرينة.
    kind: 'telegram_id',
    regex: /(?:id|ايدي|آيدي|معرفي|معرف)\s*[:=]?\s*(\d{5,12})(?!\d)/gi,
    confidence: 0.8,
    normalize: (raw) => digitsOnly(raw).replace(/^0+(?=\d)/, ''),
  },
  {
    // هواتف دولية أو محلية.
    kind: 'phone',
    regex: /(?:\+|00)?\d[\d\s\-().]{5,18}\d/g,
    confidence: 0.7,
    normalize: (raw) => digitsOnly(raw),
    // أرقام قصيرة بلا رمز دولة أو صفر بادئ قد تكون معرّف حساب لا هاتفاً ⇒ غموض معلن.
    ambiguous: (raw, normalized) =>
      !/^\s*(\+|00)/.test(raw) && normalized.length >= PHONE_MIN_DIGITS && normalized.length <= 8,

  },
  {
    // اسم مستخدم تيليجرام بصيغة @.
    kind: 'username',
    regex: /@[A-Za-z][A-Za-z0-9_]{4,31}(?![A-Za-z0-9_])/g,
    confidence: 0.85,
    normalize: (raw) => raw.trim().replace(/^@/, '').toLowerCase(),
  },
  {
    // روابط عامة.
    kind: 'url',
    regex: /(?:(?:https?:\/\/)|(?:www\.))[^\s<>"'«»]+/gi,
    confidence: 0.8,
    normalize: (raw) => raw.trim().replace(/[.,;:!?؟؛،)»"']+$/, '').toLowerCase(),
  },
];

function digitsWithinRange(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max;
}

/** يكتشف فئات التواصل في نص واحد. */
export function detectContactsInText(source: FieldSource, original: string): DetectedContact[] {
  if (!original) return [];
  // تطبيع الأرقام بطول ثابت: المواضع تبقى صحيحة بالنسبة للنص الأصلي.
  const searchable = foldDigitsKeepingLength(original);
  const claimed: { start: number; end: number }[] = [];
  const found: DetectedContact[] = [];

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(searchable)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (match[0].length === 0) {
        pattern.regex.lastIndex += 1;
        continue;
      }
      // تداخل مع فئة أكثر تحديداً سبق رصدها ⇒ تُهمل الأعمّ.
      if (claimed.some((span) => start < span.end && end > span.start)) continue;

      const raw = original.slice(start, end);
      const normalized = pattern.normalize(raw);
      if (!normalized) continue;

      if (pattern.kind === 'phone' && !digitsWithinRange(normalized, PHONE_MIN_DIGITS, PHONE_MAX_DIGITS)) continue;

      const ambiguous = pattern.ambiguous ? pattern.ambiguous(raw, normalized) : false;
      const confidence =
        pattern.kind === 'phone'
          ? Math.max(0.25, Math.min(0.95, phoneConfidence(raw, normalized)))
          : pattern.confidence;

      found.push({
        kind: pattern.kind,
        raw,
        normalized,
        masked: maskContact(pattern.kind, normalized, raw),
        spanStart: start,
        spanEnd: end,
        source,
        confidence: Number(confidence.toFixed(2)),
        ambiguous,
      });
      claimed.push({ start, end });
    }
  }

  found.sort((a, b) => a.spanStart - b.spanStart || a.kind.localeCompare(b.kind));
  return found;
}

/** يكتشف فئات التواصل في نص الرسالة وتعليقها. */
export function detectContacts(input: { text: string; caption: string }): DetectedContact[] {
  return [
    ...detectContactsInText('text', input.text),
    ...detectContactsInText('caption', input.caption),
  ];
}

/** هل تحتاج فئات التواصل المرصودة مراجعة؟ (Q7) */
export function contactsNeedReview(contacts: DetectedContact[]): boolean {
  return contacts.some((contact) => contact.ambiguous || contact.confidence < 0.6);
}
