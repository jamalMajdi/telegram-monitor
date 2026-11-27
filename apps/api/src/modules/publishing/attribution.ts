/**
 * هوية المصدر والمرسل في المنشور (متطلب تجاري).
 *
 * المبدأ: بيانات **موجودة أصلاً** في تيليجرام، تُلتقط وقت الاستقبال وتُعرض أسفل المنشور بأناقة.
 * لا يُستدعى أي طلب شبكة إضافي، ولا يُخترع شيء: ما يغيب يُحذف ولا يُكتب «غير معروف».
 *
 * ضوابط الأمان:
 * - كل قيمة نصية تُهرَّب HTML، ويُفحص الاسم/العنوان بحثاً عن جهة تواصل فيُحجب إن وُجد
 *   (قد يكون اسم المرسل نفسه رقماً أو يوزر تواصل — لا نكشف ما يجب حجبه).
 * - @username لا يُقبل إلا بنمط تيليجرام الصارم (`[A-Za-z][A-Za-z0-9_]{3,31}`) وإلا يُسقط،
 *   فلا يمكن أن يتسرّب عبره رقم هاتف أو نص حر.
 * - المعرّفات الرقمية أرقام صحيحة فقط ولا تُستخدم إلا للعرض (لا روابط chat داخلي).
 */
import { escapeHtml, htmlVisibleLength } from './publisher.js';

export type AttributionMode = 'off' | 'source' | 'sender' | 'both';
/** ما يختاره المستخدم كافتراضي (لا يشمل الإخفاء؛ الإخفاء يتم بإيقاف الميزة أو بتجاوز المسار). */
export type AttributionBaseMode = 'source' | 'sender' | 'both';

export interface AttributionConfig {
  /** افتراضي المستخدم: مفعّل (Opt-out). */
  enabled: boolean;
  mode: AttributionBaseMode;
  showUsername: boolean;
  showId: boolean;
}

export const DEFAULT_ATTRIBUTION_CONFIG: AttributionConfig = {
  enabled: true,
  mode: 'both',
  showUsername: true,
  showId: false,
};

export interface AttributionSource {
  title: string | null;
  username: string | null;
  /** معرّف النظير الرقمي (bigint كسلسلة). */
  peerId: string | null;
}

export interface AttributionSender {
  id: string | null;
  username: string | null;
  displayName: string | null;
  /** توقيع المنشور في القنوات (postAuthor). */
  postAuthor: string | null;
}

export interface AttributionInput {
  /** تجاوز المسار: null ⇒ وراثة إعداد المستخدم. */
  routeMode: AttributionMode | null;
  config: AttributionConfig;
  source: AttributionSource;
  sender: AttributionSender;
}

export interface AttributionLine {
  html: string;
  visibleLength: number;
}

export interface AttributionResult {
  /** النمط الفعّال بعد دمج إعداد المستخدم مع تجاوز المسار. */
  mode: AttributionMode;
  /** سبب الإخفاء إن كان off — يُستخدم في السجلات والتشخيص. */
  reason: 'user_disabled' | 'route_off' | null;
  lines: AttributionLine[];
}

const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const DIGITS_PATTERN = /^\d{1,20}$/;

/** نمط المستخدم كما هو في تيليجرام — أي شيء آخر يُسقط (لا نص حر داخل رابط). */
export function sanitizeUsername(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().replace(/^@/, '');
  return USERNAME_PATTERN.test(trimmed) ? trimmed : null;
}

/** معرّف رقمي فقط؛ يُعاد بصيغته النصية للعرض. */
export function sanitizeNumericId(value: string | number | null | undefined): string | null {
  const text = String(value ?? '').trim();
  return DIGITS_PATTERN.test(text) ? text : null;
}

/**
 * يحجب جهة تواصل لو كان الاسم/العنوان نفسه يحتوي رقماً أو يوزر تواصل.
 * يُحقن الكاشف في الاختبارات؛ الافتراضي هو الكاشف الحقيقي.
 */
export type NameMasker = (value: string) => string;

function safeName(value: string | null | undefined, maskName?: NameMasker): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  const masked = maskName ? maskName(trimmed) : trimmed;
  return masked.trim() || null;
}

function linkLine(parts: string[]): AttributionLine {
  const html = parts.join(' · ');
  return { html, visibleLength: htmlVisibleLength(html) };
}

/** سطر المصدر: 📣 المصدر: العنوان · @username · المعرّف. */
function sourceLine(input: AttributionInput, maskName?: NameMasker): AttributionLine | null {
  const parts: string[] = [];
  const title = safeName(input.source.title, maskName);
  if (title) parts.push(`<b>${escapeHtml(title)}</b>`);
  if (input.config.showUsername) {
    const username = sanitizeUsername(input.source.username);
    if (username) {
      parts.push(`<a href="https://t.me/${username}">@${escapeHtml(username)}</a>`);
    }
  }
  if (input.config.showId) {
    const peerId = sanitizeNumericId(input.source.peerId);
    if (peerId) parts.push(`<code>${escapeHtml(peerId)}</code>`);
  }
  if (parts.length === 0) return null;
  return linkLine([`📣 المصدر: ${parts[0]}`, ...parts.slice(1)]);
}

/** سطر المرسل: 👤 المرسل: الاسم · @username · المعرّف. */
function senderLine(input: AttributionInput, maskName?: NameMasker): AttributionLine | null {
  const parts: string[] = [];
  const displayName = safeName(input.sender.displayName ?? input.sender.postAuthor, maskName);
  if (displayName) parts.push(`<b>${escapeHtml(displayName)}</b>`);
  if (input.config.showUsername) {
    const username = sanitizeUsername(input.sender.username);
    if (username) {
      parts.push(`<a href="https://t.me/${username}">@${escapeHtml(username)}</a>`);
    }
  }
  if (input.config.showId) {
    const senderId = sanitizeNumericId(input.sender.id);
    if (senderId) parts.push(`<code>${escapeHtml(senderId)}</code>`);
  }
  if (parts.length === 0) return null;
  return linkLine([`👤 المرسل: ${parts[0]}`, ...parts.slice(1)]);
}

/**
 * يحسب النمط الفعّال: تجاوز المسار يتقدّم على إعداد المستخدم.
 * (تجاوز المسار يشمل 'off' — أي إخفاء لهذه الوجهة وحدها دون غيرها.)
 */
export function effectiveAttributionMode(input: {
  routeMode: AttributionMode | null;
  config: AttributionConfig;
}): { mode: AttributionMode; reason: AttributionResult['reason'] } {
  if (input.routeMode === 'off') return { mode: 'off', reason: 'route_off' };
  if (input.routeMode) return { mode: input.routeMode, reason: null };
  if (!input.config.enabled) return { mode: 'off', reason: 'user_disabled' };
  return { mode: input.config.mode, reason: null };
}

/**
 * يبني أسطر الهوية (بلا فاصل): المصدر و/أو المرسل حسب النمط الفعّال.
 * الفاصل البصري يُضاف في طبقة التخطيط (فهي تعرف إن كان هناك محتوى قبلها).
 */
export function renderAttribution(input: AttributionInput, options: { maskName?: NameMasker } = {}): AttributionResult {
  const { mode, reason } = effectiveAttributionMode({ routeMode: input.routeMode, config: input.config });
  if (mode === 'off') return { mode, reason, lines: [] };

  const lines: AttributionLine[] = [];
  if (mode === 'source' || mode === 'both') {
    const line = sourceLine(input, options.maskName);
    if (line) lines.push(line);
  }
  if (mode === 'sender' || mode === 'both') {
    const line = senderLine(input, options.maskName);
    if (line) lines.push(line);
  }
  return { mode, reason, lines };
}
