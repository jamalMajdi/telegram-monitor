/**
 * التطبيع العربي المحافظ (الخطوة 5-أ) — §6.6 و«نسخة عمل مطبَّعة بتحفظ» في مرجع المعمارية.
 *
 * المبدأ: نوحّد ما لا يحمل فرقاً في المعنى (تشكيل، تطويل، همزات، أرقام) فقط،
 * ولا نجذّع ولا نحذف سوابق، لأن ذلك يولّد تطابقات خاطئة. النص الأصلي لا يُحرَّف:
 * هذه الدالة تُنتج نسخة عمل في الذاكرة تُستخدم للمطابقة فقط ولا تُخزَّن.
 *
 * النسخة (NORMALIZATION_VERSION) تُخزَّن مع كل قرار معالجة حتى يعاد إنتاج نفس النتيجة.
 */
export const NORMALIZATION_VERSION = 1;

export interface NormalizeOptions {
  /** طيّ التاء المربوطة إلى هاء — مطفأ افتراضياً لأنه يخلط كلمات مختلفة (سنة/سنه). */
  foldTaMarbuta?: boolean;
  /** إزالة السوابق الشائعة من أول الكلمة (ال، و، ب، ل) — مطفأ افتراضياً. */
  stripPrefixes?: boolean;
}

const DIACRITICS_AND_TATWEEL = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const ARABIC_INDIC = /[\u0660-\u0669]/g;
const EXTENDED_ARABIC_INDIC = /[\u06F0-\u06F9]/g;
const WHITESPACE = /\s+/g;

/** يحوّل الأرقام العربية/الفارسية إلى لاتينية (لا يغيّر أي حرف). */
function foldDigits(text: string): string {
  return text
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** يوحّد الألف والياء والهمزات إلى صورة واحدة شائعة. */
function foldLetters(text: string, options: NormalizeOptions): string {
  let out = text
    .replace(/[\u0622\u0623\u0625\u0627\u0671]/g, '\u0627') // آ أ إ ٱ → ا
    .replace(/\u0649/g, '\u064A') // ى → ي
    .replace(/\u0624/g, '\u0648') // ؤ → و
    .replace(/\u0626/g, '\u064A') // ئ → ي
    .replace(/\u0643/g, '\u0643'); // لا تغيير (توضيح مقصود)
  if (options.foldTaMarbuta) out = out.replace(/\u0629/g, '\u0647');
  return out;
}

const PREFIXES = ['وال', 'بال', 'كال', 'فال', 'ال', 'و', 'ب', 'ل'];

/** إزالة سابقة واحدة فقط من كل كلمة إن وُجدت (اختياري، مطفأ افتراضياً). */
function stripPrefixesFromWords(text: string): string {
  return text
    .split(' ')
    .map((word) => {
      if (word.length <= 3) return word;
      for (const prefix of PREFIXES) {
        if (word.startsWith(prefix) && word.length - prefix.length >= 3) {
          return word.slice(prefix.length);
        }
      }
      return word;
    })
    .join(' ');
}

/**
 * يُنتج نسخة العمل المطبَّعة من نص عربي.
 * الخطوات بالترتيب: NFKC ← إزالة المحارف غير المرئية ← إزالة التشكيل والتطويل ← الأرقام ← الحروف
 * ← (اختياري) السوابق ← توحيد المسافات ← حروف لاتينية صغيرة ← trim.
 */
export function normalizeArabic(input: string, options: NormalizeOptions = {}): string {
  if (!input) return '';
  let text = input.normalize('NFKC');
  text = text.replace(ZERO_WIDTH, '');
  text = text.replace(DIACRITICS_AND_TATWEEL, '');
  text = foldDigits(text);
  text = foldLetters(text, options);
  if (options.stripPrefixes) text = stripPrefixesFromWords(text);
  text = text.replace(WHITESPACE, ' ').trim();
  // توحيد حالة اللاتينية فقط؛ العربية لا حالة لها.
  return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * نسختا النص المطبَّعتان للفلترة: محافظة، وواسعة (طي ة/ه) تُحسب فقط عند الحاجة إليها.
 * الفاصل بين النص والتعليق يمنع التصاق كلمتين (§D06: التعليق يُعامل كنص).
 */
export interface TextVariantsResult {
  strict: string;
  loose: string;
}

export function buildTextVariants(
  text: string,
  caption: string,
  appliesTo: 'any' | 'text' | 'caption',
  options: { withLoose: boolean; looseOptions?: NormalizeOptions } = { withLoose: false },
): TextVariantsResult {
  const pick = (value: string) => {
    if (appliesTo === 'text') return text;
    if (appliesTo === 'caption') return caption;
    if (!text) return caption;
    if (!caption || caption === text) return text;
    return `${text} ${caption}`;
  };
  const selected = pick(text) || '';
  void caption;
  const strict = normalizeArabic(selected, options.looseOptions ?? {});
  if (!options.withLoose) return { strict, loose: strict };
  return { strict, loose: normalizeArabic(selected, { ...(options.looseOptions ?? {}), foldTaMarbuta: true }) };
}

/**
 * نسخة مطبَّعة مع خريطة فهارس (الخطوة 5-ج).
 *
 * الاستخراج يحتاج إسناد كل قيمة إلى موضعها في **النص الأصلي** (span). التطبيع يحذف
 * التشكيل ويوحّد الأرقام فتتغيّر الأطوال، لذلك نُنتج مع كل محرف مطبَّع فهرسه في الأصل.
 *
 * الضمان: `map.length === text.length`، وكل فهرس في الخريطة داخل حدود النص الأصلي صعوداً.
 * المحارف المحذوفة (تشكيل/تطويل/عرض صفري) لا تُنتج محرفاً ولا مدخلاً في الخريطة.
 */
export interface NormalizedWithMap {
  text: string;
  map: number[];
}

const DIACRITIC_CHARS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/;
const ZERO_WIDTH_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;

export function normalizeWithMapping(input: string, options: NormalizeOptions = {}): NormalizedWithMap {
  const out: string[] = [];
  const map: number[] = [];
  let pendingSpace = -1;

  const push = (chars: string, originalIndex: number) => {
    for (const ch of chars) {
      out.push(ch);
      map.push(originalIndex);
    }
  };

  const codePoints = Array.from(input);
  let index = 0;
  for (const ch of codePoints) {
    const originalIndex = index;
    index += ch.length;

    if (ZERO_WIDTH_CHARS.test(ch) || DIACRITIC_CHARS.test(ch)) continue;

    if (/\s/.test(ch)) {
      // توحيد المسافات: مسافة واحدة مكان أي تتابع، منسوبة لأول محرف منه.
      if (pendingSpace < 0) pendingSpace = originalIndex;
      continue;
    }
    if (pendingSpace >= 0) {
      // لا نُصدر مسافة بادئة: النتيجة تُقصّ من البداية كما يفعل trim.
      if (out.length > 0) push(' ', pendingSpace);
      pendingSpace = -1;
    }

    const folded = foldLetters(foldDigits(ch.normalize('NFKC')), options);
    const lowered = /^[A-Z]+$/.test(folded) ? folded.toLowerCase() : folded;
    push(lowered, originalIndex);
  }

  // قصّ المسافة النهائية (كما يفعل trim) مع إبقاء الخريطة متوازية.
  while (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    map.pop();
  }
  return { text: out.join(''), map };
}
