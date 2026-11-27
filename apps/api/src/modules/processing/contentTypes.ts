/**
 * حدود المحتوى وبصمته (الخطوة 5-ب، Q11 + §D06).
 *
 * - النص والتعليق (caption) كلاهما يدخل الفلترة، ويُخزَّنان **منفصلين** كما وردا (Q2، D06).
 * - تجاوز الحد ⇒ `ignored/too_long` **بلا اقتطاع** (لا اقتطاع صامت، شرط مستخدم صريح).
 * - البصمة تُحسب على النسخة المطبَّعة لأن الغرض كشف التكرار (Q6)، ولا تُخزَّن النسخة المطبَّعة نفسها.
 */
import { createHash } from 'node:crypto';
import { normalizeArabic } from './normalization.js';

/** الحدود المعتمدة في Q11، والسقف الدفاعي المشترك. */
export const CONTENT_LIMITS = {
  text: 4096,
  caption: 1024,
  defensive: 8192,
} as const;

export type ContentPreparation =
  | { ok: false; reason: 'no_text' }
  | { ok: false; reason: 'too_long'; textLength: number; captionLength: number }
  | {
      ok: true;
      text: string;
      caption: string;
      textLength: number;
      captionLength: number;
      contentHash: string;
    };

/** طول بوحدات Unicode (نفس دلالة char_length في PostgreSQL). */
export function charLength(value: string): number {
  return value ? Array.from(value).length : 0;
}

/**
 * بصمة المحتوى: sha-256 على النص المطبَّع (نص + فاصل + تعليق).
 * التطبيع هنا يجعل «مطلوب» و«مَطلوب» نفس البصمة، وهو المطلوب لكشف التكرار.
 * البصمة لا تكشف النص (لا تُخزَّن النسخة المطبَّعة، Q2).
 */
export function contentHash(text: string, caption: string): string {
  const normalized = `${normalizeArabic(text)}\u001f${normalizeArabic(caption)}`;
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** يقرّر مصير المحتوى قبل أي فلترة: فارغ / متجاوز للحد / صالح. */
export function prepareContent(input: { text: string; caption: string }): ContentPreparation {
  const text = input.text ?? '';
  const caption = input.caption ?? '';
  const textLength = charLength(text);
  const captionLength = charLength(caption);

  if ((!text || !text.trim()) && (!caption || !caption.trim())) {
    return { ok: false, reason: 'no_text' };
  }
  if (
    textLength > CONTENT_LIMITS.text ||
    captionLength > CONTENT_LIMITS.caption ||
    textLength + captionLength > CONTENT_LIMITS.defensive
  ) {
    return { ok: false, reason: 'too_long', textLength, captionLength };
  }
  return {
    ok: true,
    text,
    caption,
    textLength,
    captionLength,
    contentHash: contentHash(text, caption),
  };
}
