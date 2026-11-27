/**
 * تحويل تحديثات teleproto إلى نطاق المشروع: نص أو نص مصاحب فقط.
 * لا يُنزَّل أي وسيط ولا تُقرأ حقول الوسائط إلا للتحقق من وجود نص مصاحب (D06، §5).
 * الدالة نقية وقابلة للاختبار دون اتصال.
 */
import type { IncomingTextMessage } from './gateway.js';

interface PeerLike {
  className?: string;
  channelId?: unknown;
  chatId?: unknown;
  userId?: unknown;
}

interface EntityLike {
  username?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  title?: unknown;
}

interface MessageLike {
  className?: string;
  id?: unknown;
  message?: unknown;
  date?: unknown;
  out?: unknown;
  peerId?: PeerLike;
  media?: { caption?: unknown } | null;
  /** مرسل الرسالة: PeerUser للمستخدمين، أو قناة/جروب للمنشورات المجهولة. */
  fromId?: PeerLike;
  /** توقيع المنشور في القنوات. */
  postAuthor?: unknown;
  /** كيانات التحديث المرفقة (تُستخدم لمعرفة @username بلا طلب شبكة). */
  _entities?: Map<string, EntityLike> | { get?: (key: string) => EntityLike | undefined };
}

export interface RawUpdateLike {
  className?: string;
  message?: MessageLike;
  missed?: boolean;
}

function peerOf(peer: PeerLike | undefined): { key: string; kind: IncomingTextMessage['peerKind'] } {
  switch (peer?.className) {
    case 'PeerChannel':
      return { key: `channel:${String(peer.channelId)}`, kind: 'channel' };
    case 'PeerChat':
      return { key: `chat:${String(peer.chatId)}`, kind: 'group' };
    case 'PeerUser':
      return { key: `user:${String(peer.userId)}`, kind: 'user' };
    default:
      return { key: 'unknown:0', kind: 'unknown' };
  }
}

/**
 * تنقية النص الوارد من محارف لا تقبلها قاعدة البيانات أو تُفسد العرض.
 *
 * **خلل حقيقي (تدقيق 2026-11-26):** PostgreSQL يرفض المحرف NUL (`0x00`) في `text`
 * (`invalid byte sequence for encoding "UTF8": 0x00`). رسالة واحدة تحمل هذا المحرف كانت
 * تُفشِل حفظ المحتوى ⇒ تُثبَّت نقطة الاستئناف ⇒ تُعاد الرسالة نفسها إلى ما لا نهاية
 * (**رسالة سامّة تُوقف التقاط الحساب كله**). تُزال هنا قبل أي كتابة في القاعدة.
 *
 * تُزال أيضاً محارف التحكم C0/C1 (عدا السطر الجديد والجدولة) لأنها تُفسد العرض والسجلات،
 * بينما تُحفظ علامات الاتجاه (RTL/LTR) وZWJ لأنها لازمة للعربية والإيموجي المركّب.
 */
export function sanitizeInboundText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

/**
 * يعيد null عند: رسالة خدمة، رسالة بلا نص ولا نص مصاحب، أو شكل غير معروف.
 * الرسالة الوسائطية بنص مصاحب تُقبل بنصها المصاحب فقط دون أي تنزيل.
 */
export function mapIncomingText(update: RawUpdateLike, accountId: string): IncomingTextMessage | null {
  const message = update.message;
  if (!message) return null;
  if (message.className !== undefined && message.className !== 'Message') return null;

  const text = sanitizeInboundText(typeof message.message === 'string' ? message.message : '');
  const caption = sanitizeInboundText(typeof message.media?.caption === 'string' ? message.media.caption : '');
  if (text.trim().length === 0 && caption.trim().length === 0) return null;

  const peer = peerOf(message.peerId);
  const sender = senderOf(message);
  const id = Number(message.id);
  const date = Number(message.date);
  return {
    accountId,
    peerKey: peer.key,
    peerKind: peer.kind,
    messageId: Number.isFinite(id) ? id : 0,
    text,
    caption,
    hasMedia: Boolean(message.media),
    outgoing: Boolean(message.out),
    sentAt: new Date((Number.isFinite(date) ? date : 0) * 1000),
    missed: Boolean(update.missed),
    sender,
  };
}

/**
 * يبني هوية المرسل من `fromId` + كيانات التحديث `_entities` + `postAuthor`.
 *
 * لماذا `_entities`: تحديثات تيليجرام تحمل المرسل كمعرّف فقط؛ لكن العميل يرفق كيانات التحديث
 * (اسم/@username) بلا أي طلب شبكة إضافي. ما لا يوجد يُترك `null` ولا يُخمَّن.
 */
function senderOf(message: MessageLike): IncomingTextMessage['sender'] {
  const from = message.fromId;
  const isUser = from?.className === 'PeerUser';
  const rawId = isUser ? String(from?.userId ?? '') : '';
  const id = /^\d{1,20}$/.test(rawId) ? rawId : null;

  const entity = id ? message._entities?.get?.(id) : undefined;
  const username = typeof entity?.username === 'string' && entity.username.trim() ? entity.username.trim() : null;
  const displayName = [entity?.firstName, entity?.lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim();
  const postAuthor = typeof message.postAuthor === 'string' && message.postAuthor.trim() ? message.postAuthor.trim() : null;

  if (!id && !username && !displayName && !postAuthor) return null;
  return {
    id,
    username,
    displayName: displayName || (typeof entity?.title === 'string' ? entity.title.trim() : '') || null,
    postAuthor,
  };
}
