/**
 * مستخرج الحقول المقيَّد بالقرائن (الخطوة 5-ج، F05 + §7.1/§7.4).
 *
 * خط الأنابيب لكل قطعة نص (نص الرسالة أو تعليقها على حدة):
 *   1) تطبيع مع خريطة فهارس (لاستعادة المواضع في النص الأصلي).
 *   2) إيجاد مواضع القرائن بحدود كلمات مع تسامح السوابق الملتصقة (نفس منطق الفلترة).
 *   3) اقتطاع القيمة من **النص الأصلي** بعد القرينة حتى حدّ طبيعي (سطر/ترقيم/طول).
 *   4) رفض القيم غير الصالحة (فارغة، قرينة أخرى، بلا أرقام في حقل رقمي…).
 *   5) حساب ثقة حتمية + علم غموض عند تعدّد مرشّحين متقاربين.
 *
 * ضمانات:
 *   - النص المُعاد (`value`) هو دائماً `source.slice(spanStart, spanEnd)` ⇒ **لا اختراع**.
 *   - لا استخراج لحقل بلا قرينة صريحة، والحقول الغائبة تُحذف ولا تُملأ بقيم افتراضية (§7.4).
 *   - الدالة نقية تماماً: بلا قاعدة بيانات، بلا شبكة، وبلا حالة داخلية.
 */
import { normalizeWithMapping } from '../normalization.js';
import { ALL_CUES, DATE_FIELDS, FIELD_CUES, NUMERIC_FIELDS, type FieldKey } from './cues.js';

export { EXTRACTION_VERSION } from './cues.js';

export type FieldSource = 'text' | 'caption';

export interface ExtractedField {
  fieldKey: FieldKey;
  /** القيمة كما وردت حرفياً في النص (بعد قصّ المسافات الطرفية). */
  value: string;
  spanStart: number;
  spanEnd: number;
  source: FieldSource;
  /** القرينة التي أثبتت الحقل (كما وردت في النص). */
  cue: string;
  confidence: number;
  /** تعدّد مرشّحين متقاربين أو قرينة متعارضة ⇒ يحتاج مراجعة (Q7). */
  ambiguous: boolean;
}

const PROCLITICS = ['وال', 'فال', 'بال', 'كال', 'ولل', 'لل', 'ال', 'و', 'ف', 'ب', 'ك', 'ل'];
const PROCLITIC_PATTERN = PROCLITICS.join('|');

/** حدّ الطول الأقصى لقيمة مستخرجة (أطول من ذلك = جملة لا قيمة). */
const MAX_VALUE_CHARS = 80;
/** حدّ الجملة: يوقف اقتطاع القيمة. */
const VALUE_STOP = /[\n\r.,;:!?؟؛،|•*()\[\]{}<>«»"'—–]/;
/** محارف تُتجاهل بين القرينة والقيمة («الراتب: 500»). */
const SEPARATORS = /[\s:：=\-–—]+/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** طول محرف Unicode في وحدات UTF-16 عند موضع معيّن. */
function codePointLengthAt(text: string, index: number): number {
  const code = text.codePointAt(index);
  if (code === undefined) return 1;
  return code > 0xffff ? 2 : 1;
}

interface CueIndex {
  field: FieldKey;
  cue: string;
  normalized: string;
  regex: RegExp;
  /** عدد كلمات القرينة (مؤشر تخصيص للثقة). */
  words: number;
}

let cueIndex: CueIndex[] | null = null;

/** فهرس القرائن المطبَّعة (يُبنى مرة واحدة). */
function getCueIndex(): CueIndex[] {
  if (cueIndex) return cueIndex;
  const entries: CueIndex[] = [];
  for (const [field, cues] of Object.entries(FIELD_CUES) as [FieldKey, { cue: string }[]][]) {
    for (const { cue } of cues) {
      const normalized = normalizeWithMapping(cue).text;
      if (!normalized) continue;
      const body = escapeRegex(normalized).replace(/\s+/g, '\\s+');
      const firstWord = normalized.split(/\s+/)[0] ?? normalized;
      const prefix = firstWord.length >= 3 ? `(?:${PROCLITIC_PATTERN})?` : '';
      entries.push({
        field,
        cue,
        normalized,
        regex: new RegExp(`(?:^|[^\\p{L}\\p{N}])${prefix}${body}(?![\\p{L}\\p{N}])`, 'gu'),
        words: normalized.split(/\s+/).length,
      });
    }
  }
  // الأطول أولاً: قرينة محدَّدة تسبق العامة عند نفس الموضع.
  entries.sort((a, b) => b.normalized.length - a.normalized.length);
  cueIndex = entries;
  return entries;
}

interface RawCandidate {
  field: FieldKey;
  cue: string;
  value: string;
  spanStart: number;
  spanEnd: number;
  cueWords: number;
  cueOffset: number;
  source: FieldSource;
  text: string;
}

/** يستخرج القيم المرشَّحة من نص واحد قبل الحساب النهائي للثقة. */
function findCandidates(source: FieldSource, original: string): RawCandidate[] {
  if (!original) return [];
  const { text: normalized, map } = normalizeWithMapping(original);
  if (!normalized) return [];

  const candidates: RawCandidate[] = [];
  /** مناطق استُهلكت (من بداية القرينة إلى نهاية القيمة) فلا تُقرأ قرينة أخرى داخلها. */
  const claimed: { start: number; end: number }[] = [];

  for (const entry of getCueIndex()) {
    entry.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = entry.regex.exec(normalized)) !== null) {
      if (match[0].length === 0) {
        entry.regex.lastIndex += 1;
        continue;
      }
      const matchStart = match.index;
      // التعبير يستهلك محرف الحدّ السابق (إن وُجد)؛ نُزيح البداية لبداية الكلمة نفسها.
      const firstChar = normalized[matchStart] ?? '';
      const cueStart = /[\p{L}\p{N}]/u.test(firstChar) ? matchStart : matchStart + 1;
      const cueEnd = matchStart + match[0].length;
      // تجاهل القرائن الواقعة داخل منطقة استُخرجت بالفعل (قرينة أطول أو قيمة سابقة).
      if (claimed.some((span) => cueStart >= span.start && cueStart < span.end)) continue;

      // موضع نهاية القرينة في النص الأصلي.
      const cueEndOriginal = map[cueEnd - 1];
      if (cueEndOriginal === undefined) continue;
      let cursor = cueEndOriginal + codePointLengthAt(original, cueEndOriginal);

      // تخطّي الفواصل بين القرينة والقيمة.
      let skipped = original.slice(cursor).match(SEPARATORS);
      while (skipped && skipped.index === 0 && skipped[0].length > 0) {
        cursor += skipped[0].length;
        skipped = original.slice(cursor).match(SEPARATORS);
      }

      // اقتطاع القيمة حتى حدّ الجملة أو الطول الأقصى.
      let end = cursor;
      let count = 0;
      while (end < original.length && count < MAX_VALUE_CHARS) {
        const ch = original.slice(end, end + codePointLengthAt(original, end));
        if (VALUE_STOP.test(ch)) break;
        end += ch.length;
        count += 1;
      }

      // قصّ المسافات الطرفية مع تصحيح المواضع.
      let start = cursor;
      while (start < end && /\s/.test(original[start]!)) start += 1;
      while (end > start && /\s/.test(original[end - 1]!)) end -= 1;
      if (end <= start) continue;

      const value = original.slice(start, end);
      const valueNormalized = normalizeWithMapping(value).text;
      if (!valueNormalized) continue;
      // قيمة هي قرينة أخرى ⇒ لا تُعدّ قيمة.
      if (getCueIndex().some((other) => other.normalized === valueNormalized)) continue;

      candidates.push({
        field: entry.field,
        cue: entry.cue,
        value,
        spanStart: start,
        spanEnd: end,
        cueWords: entry.words,
        cueOffset: cueStart,
        source,
        text: original,
      });
      claimed.push({ start: cueStart, end });
    }
  }
  return candidates;
}

/** هل يحمل النص دلالة رقمية (للحقول الرقمية)؟ */
export function hasDigit(value: string): boolean {
  return /[0-9٠-٩۰-۹]/.test(value);
}

/** دلالة زمنية مقبولة للموعد النهائي: رقم أو اسم يوم/شهر أو لفظ زمني شائع. */
function hasDateSignal(value: string): boolean {
  if (hasDigit(value)) return true;
  return /(اليوم|غدا|غداً|بكرة|الأحد|الاحد|الاثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|الجمعه|السبت|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر|الأسبوع|الاسبوع|الشهر|شهر|أسبوع|اسبوع)/.test(
    value,
  );
}

interface Scored {
  candidate: RawCandidate;
  confidence: number;
  endsLine: boolean;
}

function scoreCandidate(candidate: RawCandidate, isOnlyMatchForField: boolean): Scored {
  const length = Array.from(candidate.value).length;
  let confidence = 0.4;

  // تخصيص القرينة: قرينة من كلمتين أو أكثر أدقّ.
  confidence += candidate.cueWords >= 2 ? 0.15 : 0.05;

  // ملاءمة القيمة لنوع الحقل.
  const numericField = NUMERIC_FIELDS.has(candidate.field);
  if (numericField) {
    if (hasDigit(candidate.value)) confidence += 0.15;
    else confidence -= 0.25;
  } else if (DATE_FIELDS.has(candidate.field)) {
    if (hasDateSignal(candidate.value)) confidence += 0.13;
    else confidence -= 0.1;
  } else if (length >= 2 && length <= 40) {
    confidence += 0.12;
  }

  // القيمة تنتهي بحدّ سطر/جملة ⇒ اقتطاع نظيف.
  const after = candidate.text.slice(candidate.spanEnd, candidate.spanEnd + 1);
  const endsLine = after === '' || /[\n\r.,;:!?؟؛،|•*()]/.test(after);
  confidence += endsLine ? 0.1 : 0.02;

  // القرينة في بداية سطر/رسالة ⇒ سياق أوضح.
  const beforeCue = candidate.text.slice(Math.max(0, candidate.cueOffset - 1), candidate.cueOffset);
  if (candidate.cueOffset === 0 || beforeCue === '\n' || beforeCue === '') confidence += 0.05;

  // قيمة طويلة جداً أو مرشّح غير وحيد ⇒ خفض.
  if (length > 40) confidence -= 0.1;
  if (!isOnlyMatchForField) confidence -= 0.05;

  return { candidate, confidence: Math.max(0.25, Math.min(0.95, Number(confidence.toFixed(2)))), endsLine };
}

/**
 * يستخرج الحقول من نص واحد. لا يُكرِّر الحقل نفسه إلا إذا تعدّدت قيمه بشكل صريح،
 * وفي هذه الحالة يُعلَّم الجميع `ambiguous` (Q7) بدل اختيار صامت.
 */
export function extractFieldsFromText(source: FieldSource, original: string): ExtractedField[] {
  const candidates = findCandidates(source, original);
  if (candidates.length === 0) return [];

  const byField = new Map<FieldKey, RawCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.field;
    const existing = byField.get(key) ?? [];
    // تجاهل القيم المكرّرة تماماً (نفس الموضع).
    if (!existing.some((item) => item.spanStart === candidate.spanStart && item.spanEnd === candidate.spanEnd)) {
      existing.push(candidate);
    }
    byField.set(key, existing);
  }

  const out: ExtractedField[] = [];
  for (const [field, list] of byField) {
    const scored = list.map((candidate) => scoreCandidate(candidate, list.length === 1));
    const best = Math.max(...scored.map((item) => item.confidence));
    for (const { candidate, confidence } of scored) {
      // قيمة بلا دلالة رقمية في حقل رقمي، أو بلا دلالة زمنية في حقل موعد ⇒ تُهمَل.
      if (NUMERIC_FIELDS.has(field) && !hasDigit(candidate.value)) continue;
      if (DATE_FIELDS.has(field) && !hasDateSignal(candidate.value)) continue;
      out.push({
        fieldKey: field,
        value: candidate.value,
        spanStart: candidate.spanStart,
        spanEnd: candidate.spanEnd,
        source,
        cue: candidate.cue,
        confidence,
        ambiguous: list.length > 1 || best - confidence >= 0.15,
      });
    }
  }

  // ترتيب حتمي: موضع الظهور ثم المفتاح.
  out.sort((a, b) => a.spanStart - b.spanStart || a.fieldKey.localeCompare(b.fieldKey));
  return out;
}

/** يستخرج من نص الرسالة وتعليقها معاً (كل منهما بمواضعه الخاصة). */
export function extractFields(input: { text: string; caption: string }): ExtractedField[] {
  return [
    ...extractFieldsFromText('text', input.text),
    ...extractFieldsFromText('caption', input.caption),
  ];
}

/** هل تحتاج نتيجة الاستخراج مراجعة بشرية؟ (Q7) */
export function needsReview(fields: ExtractedField[]): boolean {
  return fields.some((field) => field.ambiguous || field.confidence < 0.6);
}

/** أدوات مساعدة للاختبارات والتحقق (لا تُخزَّن). */
export const extractionInternals = { getCueIndex, ALL_CUES };
