/**
 * باني المنشور النهائي (الدفعة 7-ج): تنسيق HTML آمن ← حجب نهائي ← تقسيم إلى أجزاء ≤ 4096.
 *
 * المبادئ المنفَّذة (كلها قرارات معتمدة):
 * - **الطول يُقاس بعد تحليل الكيانات** لا بعدد المحارف الخام: وسوم HTML لا تُحتسب، والكيان `&amp;`
 *   يُحتسب محرفاً واحداً — تماماً كما تحسبه تيليجرام (§10.5، Q11 المرحلة الثانية).
 * - **حجب مزدوج (O03):** القيم تصل محجوبة من طبقة الاستخراج، ثم يُعاد فحص النص المجمَّع بحثاً عن أي
 *   فئة تواصل غير محجوبة؛ وأي فشل في الفحص ⇒ **رفض آمن** (`masking_failed`) بدل إرسال محتوى مكشوف.
 * - **لا اقتطاع صامت (D10/Q11):** تجاوز الحد يُحلّ بالتقسيم (سياسة `split`) أو بالرفض الصريح (`reject`)،
 *   ولا يُحذف أي محرف من المحتوى.
 * - **القطع لا يقع داخل** كيان HTML أو وسم أو محرف مركّب (surrogate pair) أو قيمة تواصل محجوبة.
 */
import { detectContacts } from '../processing/extraction/contactDetector.js';
import { maskContact } from '../processing/extraction/contactDetector.js';

/** حد تيليجرام للنص بعد تحليل الكيانات. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** فاصل بصري بين العنوان والحقول (لا يُحتسب إلا بطوله الفعلي). */
const SEPARATOR = 'ــــــــــــــــــــــ';
/** أيقونة العنوان الثابتة — لا إيموجي داخل قيم المستخدم. */
const TITLE_EMOJI = '📌';
/** فاصل خفيف بين المحتوى وهوية المصدر/المرسل. */
export const FOOTER_SEPARATOR = '· · ·';

export interface PostField {
  label: string;
  value: string;
}

/** سطر تذييل جاهز (HTML المُهرَّب + طوله المرئي) — يُبنى في طبقة الهوية لا هنا. */
export interface FooterLine {
  html: string;
  visibleLength: number;
}

export interface PostSource {
  /** اسم القالب (يُستخدم عنواناً)، أو اسم التصنيف عند غيابه. */
  title: string | null;
  fields: PostField[];
}

export type PlanFailureReason = 'too_long' | 'masking_failed' | 'empty';

export interface PlannedPart {
  index: number;
  html: string;
  /** الطول كما تحسبه تيليجرام (بلا وسوم). */
  visibleLength: number;
}

export type PlanResult =
  | { ok: true; parts: PlannedPart[]; charsTotal: number; maskingRewrites: number }
  | { ok: false; reason: PlanFailureReason; parts: []; charsTotal: 0 };

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** يحوّل HTML إلى النص الذي تراه تيليجرام: بلا وسوم، والكيانات مفكوكة. */
export function htmlVisibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function htmlVisibleLength(html: string): number {
  // Array.from يحسب الأزواج المركّبة (surrogate pairs) محرفاً واحداً كما تفعل تيليجرام.
  return Array.from(htmlVisibleText(html)).length;
}

/**
 * الفحص النهائي للحجب: يمرّ على النص المجمَّع ويستبدل كل فئة تواصل بكيانها المحجوب.
 * يُرجع النص الآمن وعدد الاستبدالات؛ ويُعلن الفشل عند أي استثناء بدل المتابعة.
 */
export type ContactDetector = typeof detectContacts;

export function enforceMasking(
  text: string,
  detect: ContactDetector = detectContacts,
): { ok: true; text: string; rewrites: number } | { ok: false } {
  try {
    const detected = detect({ text, caption: '' });
    if (detected.length === 0) return { ok: true, text, rewrites: 0 };
    let output = text;
    let rewrites = 0;
    // من النهاية إلى البداية كي تبقى المواضع صحيحة.
    const ordered = [...detected].sort((a, b) => b.spanStart - a.spanStart);
    for (const contact of ordered) {
      if (contact.source !== 'text') continue;
      const raw = output.slice(contact.spanStart, contact.spanEnd);
      if (!raw) continue;
      const masked = maskContact(contact.kind, contact.normalized, contact.raw);
      if (masked === raw) continue;
      output = `${output.slice(0, contact.spanStart)}${masked}${output.slice(contact.spanEnd)}`;
      rewrites += 1;
    }
    return { ok: true, text: output, rewrites };
  } catch {
    return { ok: false };
  }
}

interface Line {
  /** الأسطر الجاهزة (HTML) — الوحدة الذرّية في التقسيم. */
  html: string;
  visibleLength: number;
}

function boldLine(label: string | null, value: string): Line {
  const html = label ? `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}` : escapeHtml(value);
  return { html, visibleLength: htmlVisibleLength(html) };
}

/**
 * يحوّل الحقول إلى أسطر منسّقة؛ يحذف الحقول الغائبة والفارغة (§7.4).
 *
 * **حارس المنشور الفارغ (إصلاح خلل 2026-11-25):** العنوان والفاصل ليسا محتوى. كان الفحص القديم
 * يعتبر «عنواناً + فاصلاً» منشوراً صالحاً فيُرسل هيكل فارغ إلى القناة. الآن تُبنى أسطر المحتوى أولاً،
 * وإن لم يوجد سطر محتوى واحد ⇒ `empty` صريح ولا يُضاف عنوان أصلاً.
 */
export function buildLines(
  source: PostSource,
  limit: number,
  footer: FooterLine[] = [],
): { ok: true; lines: Line[] } | { ok: false; reason: PlanFailureReason } {
  const contentLines: Line[] = [];

  for (const field of source.fields) {
    const value = field.value.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const whole = boldLine(field.label, value);
    if (whole.visibleLength <= limit) {
      contentLines.push(whole);
      continue;
    }
    // قيمة تتجاوز حد الجزء وحده: تُقسَّم عند حدود الجملة ثم الكلمة (لا اقتطاع).
    const pieces = splitValue(value, Math.max(1, limit - visibleLengthOfLabel(field.label)));
    pieces.forEach((piece, index) => {
      contentLines.push(boldLine(index === 0 ? field.label : null, piece));
    });
  }

  // لا محتوى حقيقياً ⇒ لا منشور: العنوان والفاصل لا يُرسلان وحدهما أبداً،
  // وهوية المصدر/المرسل **لا تُنقذ** منشوراً فارغاً (ليست محتوى دلالياً).
  const hasContent = contentLines.some((line) => line.visibleLength > 0);
  if (!hasContent) return { ok: false, reason: 'empty' };

  const lines: Line[] = [];
  const title = source.title?.trim();
  if (title) {
    lines.push(boldLine(null, `${TITLE_EMOJI} ${title}`));
    lines.push({ html: SEPARATOR, visibleLength: htmlVisibleLength(SEPARATOR) });
  }
  lines.push(...contentLines);
  const usableFooter = footer.filter((line) => line.visibleLength > 0);
  if (usableFooter.length > 0) {
    // فاصل خفيف يفصل المحتوى عن هوية المصدر/المرسل (لا يُضاف بلا تذييل).
    lines.push({ html: FOOTER_SEPARATOR, visibleLength: htmlVisibleLength(FOOTER_SEPARATOR) });
    lines.push(...usableFooter);
  }
  return { ok: true, lines };
}

function visibleLengthOfLabel(label: string): number {
  return htmlVisibleLength(`<b>${escapeHtml(label)}:</b> `);
}

/**
 * تقسيم قيمة طويلة عند حدود آمنة: جملة ← كلمة ← قطع اضطرارى على حدود المحارف المركّبة.
 * لا يُقطع أبداً داخل زوج مركّب (Array.from يحفظ المحارف كاملة).
 */
export function splitValue(value: string, budget: number): string[] {
  if (budget <= 0) return [value];
  const pieces: string[] = [];
  let rest = value;
  while (Array.from(rest).length > budget) {
    const window = Array.from(rest).slice(0, budget).join('');
    const sentenceCut = lastSentenceBoundary(window);
    const spaceCut = window.lastIndexOf(' ');
    const cut = sentenceCut > 0 ? sentenceCut : spaceCut;
    const take = cut > 0 ? window.slice(0, cut).trimEnd() : window;
    if (!take) break;
    pieces.push(take);
    rest = rest.slice(take.length).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function lastSentenceBoundary(window: string): number {
  const match = /[.!؟?،,;؛]\s/g;
  let index = -1;
  let found: RegExpExecArray | null;
  while ((found = match.exec(window)) !== null) index = found.index + 1;
  return index;
}

/**
 * يبني خطة الأجزاء كاملة.
 * `policy='reject'` يعني: تجاوز حد الجزء أو عدد الأجزاء ⇒ رفض صريح (`too_long`) بلا إرسال.
 */
export function planPost(input: {
  source: PostSource;
  limit?: number;
  maxParts: number;
  policy: 'split' | 'reject';
  /** حقن كاشف التواصل في الاختبارات (الافتراضي الكاشف الحقيقي). */
  detect?: ContactDetector;
  /**
   * تذييل المنشور (هوية المصدر/المرسل): أسطر HTML جاهزة ومحتسبة الطول.
   * لا يمرّ على كاشف التواصل لأنه بيانات هوية صريحة مبنية من @username صالح ومعرّف رقمي
   * (والأسماء/العناوين حُجبت مسبقاً في طبقة الهوية).
   */
  footer?: FooterLine[];
}): PlanResult {
  const limit = input.limit ?? TELEGRAM_TEXT_LIMIT;
  const sanitizedFields: PostField[] = [];
  let rewrites = 0;
  const detect = input.detect ?? detectContacts;
  for (const field of input.source.fields) {
    const masked = enforceMasking(field.value, detect);
    if (!masked.ok) return { ok: false, reason: 'masking_failed', parts: [], charsTotal: 0 };
    rewrites += masked.rewrites;
    sanitizedFields.push({ label: field.label, value: masked.text });
  }
  const sanitizedTitle = input.source.title ? input.source.title : null;
  if (sanitizedTitle) {
    const maskedTitle = enforceMasking(sanitizedTitle, detect);
    if (!maskedTitle.ok) return { ok: false, reason: 'masking_failed', parts: [], charsTotal: 0 };
    rewrites += maskedTitle.rewrites;
  }

  const built = buildLines({ title: sanitizedTitle, fields: sanitizedFields }, limit, input.footer ?? []);
  if (!built.ok) return { ok: false, reason: built.reason, parts: [], charsTotal: 0 };

  const parts: PlannedPart[] = [];
  let current: Line[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length === 0) return;
    parts.push({
      index: parts.length + 1,
      html: current.map((line) => line.html).join('\n'),
      visibleLength: currentLength,
    });
    current = [];
    currentLength = 0;
  };

  for (const line of built.lines) {
    if (line.visibleLength > limit) {
      // لا يحدث بعد تقسيم القيم، لكنه رفض آمن بدل إرسال جزء متجاوز.
      return { ok: false, reason: 'too_long', parts: [], charsTotal: 0 };
    }
    const separatorCost = current.length === 0 ? 0 : 1; // محرف السطر الجديد
    if (current.length > 0 && currentLength + separatorCost + line.visibleLength > limit) {
      flush();
    }
    current.push(line);
    currentLength += (current.length === 1 ? 0 : 1) + line.visibleLength;
  }
  flush();

  if (parts.length === 0) return { ok: false, reason: 'empty', parts: [], charsTotal: 0 };
  if (parts.length > input.maxParts) {
    // سياسة `split` أيضاً لا تتجاوز سقف الأجزاء: الرفض الصريح أفضل من سيل منشورات.
    return { ok: false, reason: 'too_long', parts: [], charsTotal: 0 };
  }
  if (parts.some((part) => part.visibleLength > limit)) {
    return { ok: false, reason: 'too_long', parts: [], charsTotal: 0 };
  }
  if (input.policy === 'reject' && parts.length > 1) {
    return { ok: false, reason: 'too_long', parts: [], charsTotal: 0 };
  }

  return {
    ok: true,
    parts,
    charsTotal: parts.reduce((sum, part) => sum + part.visibleLength, 0),
    maskingRewrites: rewrites,
  };
}
