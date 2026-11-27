/**
 * منع الحلقات (O05) — الأدوات النقية وهوية المحادثة الفنية.
 *
 * المبدأ: الرسالة تنتقل من قناة مصدر إلى قناة وجهة. إن أمكن الوصول من الوجهة عائدةً إلى المصدر
 * عبر مسارات فعّالة (لأي مستخدم)، فإن إضافة الحافة (مصدر ← وجهة) تُغلق دورة نشر.
 *
 * - الهوية المقارنة هي `chat_id` الفني (سالب للقنوات والمجموعات العظمى)، لا الأسماء.
 * - الفحص نفسه في قاعدة البيانات داخل معاملة التفعيل (`publishRepository.findCyclePath`),
 *   لأن الذرّية شرط O05؛ أما هنا فالأدوات التي تُبنى بها الحواف وتُختبر وحدها.
 * - لا تُعرض تفاصيل حواف مستخدم آخر في أي رسالة رفض.
 */
import type { SourcePeerType } from '../telegram/gateway.js';

/** بادئة معرّفات القنوات والمجموعات العظمى في واجهة Bot API. */
const CHANNEL_ID_OFFSET = 1_000_000_000_000n;

/**
 * معرّف المحادثة الفني لمصدر مراقب.
 * المصادر المدعومة في النظام هي القنوات والمجموعات العظمى فقط (كيان Channel في MTProto)،
 * وكلاهما يظهر في Bot API بالصيغة `-100<المعرّف الرقمي>` — ولهذا المعرّفان يتساويان.
 */
export function sourceChatId(peerType: SourcePeerType, peerId: string): string {
  const raw = BigInt(peerId);
  if (raw <= 0n) throw new RangeError('معرّف المصدر يجب أن يكون موجباً.');
  void peerType; // النوع محفوظ للتوضيح؛ الصيغة الفنية واحدة للقنوات والمجموعات العظمى.
  return (-(CHANNEL_ID_OFFSET + raw)).toString();
}

/** يتحقق أن قيمة الوجهة معرّف محادثة سالب صالح (كما يعيده getChat). */
export function isDestinationChatId(value: string): boolean {
  return /^-\d{5,20}$/.test(value);
}

/** يوحّد معرّف المحادثة في شكل نصي للمقارنة (بلا أصفار أو علامات زائدة). */
export function normalizeChatId(value: string | number | bigint): string {
  const asString = typeof value === 'string' ? value.trim() : String(value);
  if (!/^-?\d{1,20}$/.test(asString)) {
    throw new RangeError('معرّف المحادثة غير صالح.');
  }
  return BigInt(asString).toString();
}

/** رسالة الرفض الموحّدة: محايدة تماماً ولا تكشف أي مسار لمستخدم آخر. */
export const CYCLE_REJECTION_MESSAGE =
  'سيُنشئ هذا الربط حلقة نشر (رسائل تنتقل من وجهة عائدةً إلى مصدر). عدّل المصادر أو الوجهة ثم أعد المحاولة.';
