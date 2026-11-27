/**
 * حلّال هوية المرسل — خطوة احتياطية عند غياب بيانات المستخدم من التحديث.
 *
 * **المشكلة الواقعية (2026-11-26):** تيليجرام يُرسل التحديث ومعرف المرسل فقط (`fromId: PeerUser`)،
 * ولا تُرفق مكتبة العميل مصفوفة `users` مع التحديث — فـ`_entities` تبقى فارغة، ويُحفظ `sender_id`
 * بلا اسم ولا @username، ولا يظهر سطر «👤 المرسل» في المنشور.
 *
 * **الحل بثلاث مراحل، بلا أي طلب شبكة إلا عند الحاجة:**
 *   1) كاش محلي قصير الأجل (نجاح 6 ساعات، فشل 10 دقائق) ⇒ صفر طلبات للمرسل المتكرر.
 *   2) `getEntity` من كاش الجلسة (بلا شبكة إن كان المرسل معروفاً للعميل).
 *   3) عند الفشل: جلب **الرسالة نفسها** من المصدر (`getMessages` بمعرّف الرسالة) — الرد يحمل
 *      كيانات المرسلين فتُخزَّن في جلسة المكتبة — ثم إعادة `getEntity`.
 *
 * **قواعد صارمة:**
 * - لا محتوى رسائل ولا جهات اتصال في السجلات؛ لا يُسجَّل هنا شيء إطلاقاً.
 * - الفشل لا يُسقط الالتقاط أبداً: تُعاد هوية المرسل كما وصلت (بالمعرّف فقط).
 * - مهلة قصوى محدودة: تأخير الالتقاط لأجل توقيع تجميلي غير مقبول.
 * - لا يُخترع شيء: الحقول الغائبة تبقى `null`.
 */
import type { IncomingSender } from './gateway.js';

/** الحقول التي نقرأها من كيان تيليجرام (اسم/يوزر فقط — لا شيء آخر). */
export interface SenderEntityFields {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
}

export interface SenderLookup {
  /** يجلب كيان المستخدم من كاش الجلسة (أو شبكة عند الحاجة). يعيد null عند الفشل. */
  getEntity(userId: string): Promise<SenderEntityFields | null>;
  /**
   * يدفّئ كاش الجلسة بجلب الرسالة نفسها من المصدر (ردّها يحمل كيانات المرسلين).
   * `peerKey` بصيغة النطاق (`channel:123` / `chat:123` / `user:123`) لأن تيليجرام يحتاج
   * نوع النظير صريحاً؛ تمرير رقم مجرّد يُفسَّر كمستخدم فيفشل الحلّ.
   */
  warmFromSourceMessage(peerKey: string, messageId: number): Promise<void>;
}

export interface SenderResolverOptions {
  /** أقصى زمن لكل محاولة حلّ (الافتراضي 3000 مللي). */
  timeoutMs?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
  maxEntries?: number;
}

export interface SenderIdentity {
  username: string | null;
  displayName: string | null;
}

export interface SenderResolverStats {
  cacheHits: number;
  lookups: number;
  resolved: number;
  unresolved: number;
  timeouts: number;
  failures: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;
/** نمط تيليجرام الصارم — أي شيء آخر لا يُخزَّن كـ@username. */
const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const MAX_NAME_LENGTH = 64;

/** قيمة صالحة للعرض: نص غير فارغ ومقصوص، وإلا null. */
function cleanText(value: unknown, maxLength = MAX_NAME_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function cleanUsername(value: unknown): string | null {
  const text = cleanText(value, 64)?.replace(/^@/, '') ?? null;
  return text && USERNAME_PATTERN.test(text) ? text : null;
}

/** يستخرج (username, displayName) من كيان تيليجرام؛ العنوان بديل للأسماء في القنوات. */
export function identityFromEntity(entity: SenderEntityFields | null): SenderIdentity | null {
  if (!entity) return null;
  const username = cleanUsername(entity.username);
  const displayName =
    cleanText([entity.firstName, entity.lastName].filter((part) => cleanText(part)).join(' ')) ??
    cleanText(entity.title);
  if (!username && !displayName) return null;
  return { username, displayName };
}

/**
 * كاش هويات المرسلين — مفتاحه يجب أن يضمّ الحساب والمرسل معاً (عزل المستأجرين).
 * القيمة `null` تعني «تعذّر الحلّ» وتُخزَّن بمدة أقصر لمنع تكرار المحاولات.
 */
export class SenderIdentityCache {
  private readonly entries = new Map<string, { value: SenderIdentity | null; expiresAt: number }>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { maxEntries?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  get(key: string): { found: boolean; value: SenderIdentity | null } {
    const entry = this.entries.get(key);
    if (!entry) return { found: false, value: null };
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return { found: false, value: null };
    }
    return { found: true, value: entry.value };
  }

  set(key: string, value: SenderIdentity | null, ttlMs: number): void {
    if (this.entries.size >= this.maxEntries) {
      // إخلاء الأقدم إدراجاً (Map يحفظ ترتيب الإدراج) — لا نمو غير محدود.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}

/** يغلّف وعداً بمهلة؛ عند التجاوز يعيد رمزاً صريحاً بدل تعليق المعالجة. */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; timeout: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: false; timeout: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timeout: true }), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([work.then((value) => ({ ok: true as const, value })), timeout]);
    return result;
  } catch {
    return { ok: false, timeout: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * يُثري هوية المرسل (اسم/@username) مع الحفاظ على ما وصل وما هو مخزَّن.
 * لا يرمي استثناءً أبداً، ويعيد هوية صالحة دائماً (ولو بالمعرّف وحده).
 */
export async function resolveSenderIdentity(
  input: { accountId: string; sender: IncomingSender; peerKey?: string | null; messageId?: number | null },
  lookup: SenderLookup,
  options: SenderResolverOptions & { cache?: SenderIdentityCache; stats?: SenderResolverStats } = {},
): Promise<IncomingSender> {
  const sender = input.sender;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const positiveTtlMs = options.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS;
  const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const cache = options.cache;
  const stats = options.stats;

  const needsUsername = !cleanUsername(sender.username);
  const needsName = !cleanText(sender.displayName) && !cleanText(sender.postAuthor);
  if (!sender.id || (!needsUsername && !needsName)) return sender;

  const cacheKey = `${input.accountId}:${sender.id}`;
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached.found) {
      if (stats) stats.cacheHits += 1;
      if (!cached.value) return sender;
      return {
        ...sender,
        username: sender.username ?? cached.value.username,
        displayName: sender.displayName ?? cached.value.displayName,
      };
    }
  }

  if (stats) stats.lookups += 1;
  let identity: SenderIdentity | null = null;
  let timedOut = false;

  const first = await withTimeout(lookup.getEntity(sender.id), timeoutMs);
  if (first.ok) identity = identityFromEntity(first.value);
  else timedOut = first.timeout;

  // الاحتياط: جلب الرسالة نفسها ⇒ كيانات المرسلين تُخزَّن في الجلسة ⇒ إعادة المحاولة.
  if (!identity && input.peerKey && input.messageId) {
    const warmed = await withTimeout(lookup.warmFromSourceMessage(input.peerKey, input.messageId), timeoutMs);
    if (!warmed.ok && warmed.timeout) timedOut = true;
    if (warmed.ok || !timedOut) {
      const second = await withTimeout(lookup.getEntity(sender.id), timeoutMs);
      if (second.ok) identity = identityFromEntity(second.value);
      else if (second.timeout) timedOut = true;
    }
  }

  if (identity) {
    if (stats) stats.resolved += 1;
    cache?.set(cacheKey, identity, positiveTtlMs);
    return {
      ...sender,
      username: sender.username ?? identity.username,
      displayName: sender.displayName ?? identity.displayName,
    };
  }

  if (stats) {
    stats.unresolved += 1;
    if (timedOut) stats.timeouts += 1;
  }
  // التخزين السلبي يُمنع فقط عند فشل حقيقي (لا عند مهلة قد تكون عارضة).
  if (!timedOut) cache?.set(cacheKey, null, negativeTtlMs);
  return sender;
}
