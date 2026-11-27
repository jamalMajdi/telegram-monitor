/**
 * تشفير جلسات MTProto عند الراحة: AES-256-GCM بمفتاح من البيئة (خارج قاعدة البيانات والكود).
 *
 * صيغة المغلّف (بايتات):
 *   [0]      نسخة المغلّف = 1
 *   [1..2]   معرّف المفتاح (uint16، يبدأ من 1)
 *   [3..14]  IV عشوائي 12 بايت
 *   [15..]   نص مشفّر (+16 بايت وسم GCM في نهايته)
 *
 * AAD يربط المغلّف بمعرّف الحساب ونوع المحتوى: نسخ صف جلسة إلى حساب آخر يُفشل الفك،
 * ولا يمكن إعادة استخدام مغلّف "حالة ربط مؤقتة" مكان مغلّف جلسة (أو العكس).
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import type { StoredUpdateState } from 'teleproto/sessions';

const ENVELOPE_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HEADER_LENGTH = 3 + IV_LENGTH;

export class SessionCipherError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'malformed' | 'unknown_key' | 'auth_failed',
  ) {
    super(message);
    this.name = 'SessionCipherError';
  }
}

export interface SessionPayload {
  /** سلسلة الجلسة كما ينتجها Teleproto (تحتوي مفتاح المصادقة). */
  session: string;
  /** حالة تحديثات Telegram لاستعادة ما فات بعد إعادة التشغيل (D03). */
  updateState?: StoredUpdateState;
  /** طابع زمني لآخر حفظ، للتدقيق التشغيلي فقط. */
  savedAt?: string;
}

export interface DecryptedSession extends SessionPayload {
  keyVersion: number;
}

/** مفتاح تشفير واحد داخل حلقة مفاتيح؛ يُستخدم لمغلّفات الجلسات ولرموز البوتات (بمفاتيح منفصلة). */
export interface CipherKeyEntry {
  version: number;
  key: Buffer;
}

type KeyEntry = CipherKeyEntry;

function readKeyring(source = env): KeyEntry[] {
  const keys: KeyEntry[] = [];
  const current = source.TG_SESSION_ENC_KEY;
  const previous = source.TG_SESSION_ENC_KEY_PREVIOUS;
  /**
   * `?? 1` وحدها كانت تُبقي النسخة نصاً ('1') إذا مرّرها مصدر غير محلَّل، فيُختم المغلّف
   * بالنسخة 1 ويُفكّ ببحث عن رقم 1 ⇒ `unknown_key`. التحويل هنا يجعل الفكّ لا يعتمد على
   * من حلّل البيئة.
   */
  const version = Number(source.TG_SESSION_ENC_KEY_VERSION ?? 1);
  if (current) {
    const key = Buffer.from(current, 'base64');
    if (key.length !== KEY_LENGTH) throw new SessionCipherError('مفتاح التشفير الحالي غير صالح الطول.', 'not_configured');
    keys.push({ version, key });
  }
  if (previous) {
    const key = Buffer.from(previous, 'base64');
    if (key.length !== KEY_LENGTH) throw new SessionCipherError('مفتاح التشفير السابق غير صالح الطول.', 'not_configured');
    if (version <= 1) {
      throw new SessionCipherError('لا يمكن قبول مفتاح سابق مع نسخة المفتاح 1؛ ارفع TG_SESSION_ENC_KEY_VERSION.', 'not_configured');
    }
    keys.push({ version: version - 1, key });
  }
  if (keys.length === 0) {
    throw new SessionCipherError('مفتاح تشفير جلسات تيليجرام غير مهيأ.', 'not_configured');
  }
  return keys;
}

/**
 * أنواع المحتوى المشفّر:
 * - `session`: جلسة MTProto.
 * - `login`: حالة ربط مؤقتة (رقم + phone_code_hash + جلسة مؤقتة).
 * - `bot`: رمز بوت نشر (Bot API) — بمفتاح مستقل TG_BOT_ENC_KEY (المرحلة الثالثة).
 */
export type SealedPurpose = 'session' | 'login' | 'bot';

export interface SealedPayload {
  ciphertext: Buffer;
  keyVersion: number;
}

function associatedData(purpose: SealedPurpose, accountId: string, keyVersion: number): Buffer {
  return Buffer.from(`tg-${purpose}:v1:${accountId}:${keyVersion}`, 'utf8');
}

/** تشفير أي قيمة JSON في المغلّف نفسه؛ يُستخدم للجلسات وحالة الربط المؤقتة دون تكرار. */
export function sealPayload<T>(
  purpose: SealedPurpose,
  accountId: string,
  value: T,
  source = env,
): SealedPayload {
  const [entry] = readKeyring(source);
  if (!entry) throw new SessionCipherError('لا يوجد مفتاح تشفير صالح.', 'not_configured');
  return sealWithKey(purpose, accountId, value, entry);
}

/**
 * تشفير بمفتاح محدَّد داخل حلقة مفاتيح معطاة.
 * يُستخدم لمغلّف الجلسات (مفتاح TG_SESSION_ENC_KEY) ولمغلّف رمز البوت (مفتاح TG_BOT_ENC_KEY)
 * دون أي ازدواج في صيغة المغلّف أو تحقّقه.
 */
export function sealWithKey<T>(
  purpose: SealedPurpose,
  subjectId: string,
  value: T,
  entry: CipherKeyEntry,
): SealedPayload {
  const iv = randomBytes(IV_LENGTH);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', entry.key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(associatedData(purpose, subjectId, entry.version));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt8(ENVELOPE_VERSION, 0);
  header.writeUInt16BE(entry.version, 1);
  iv.copy(header, 3);
  return { ciphertext: Buffer.concat([header, encrypted, tag]), keyVersion: entry.version };
}

/** فك مغلّف سابق التحقق من النسخة والمفتاح والوسم، وإرجاع القيمة المنظّمة. */
export function openPayload<T>(
  purpose: SealedPurpose,
  accountId: string,
  ciphertext: Buffer,
  source = env,
): { value: T; keyVersion: number } {
  return openWithKeys<T>(purpose, accountId, ciphertext, readKeyring(source));
}

/** فك مغلّف بمفاتيح معطاة (فك فقط) — يتحقق من النسخة والمفتاح والوسم قبل إرجاع القيمة. */
export function openWithKeys<T>(
  purpose: SealedPurpose,
  subjectId: string,
  ciphertext: Buffer,
  keys: CipherKeyEntry[],
): { value: T; keyVersion: number } {
  if (ciphertext.length <= HEADER_LENGTH + TAG_LENGTH) {
    throw new SessionCipherError('مغلّف الجلسة أقصر من الحد الأدنى.', 'malformed');
  }
  const envelopeVersion = ciphertext.readUInt8(0);
  if (envelopeVersion !== ENVELOPE_VERSION) {
    throw new SessionCipherError('نسخة مغلّف الجلسة غير مدعومة.', 'malformed');
  }
  const keyVersion = ciphertext.readUInt16BE(1);
  const iv = ciphertext.subarray(3, HEADER_LENGTH);
  const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
  const body = ciphertext.subarray(HEADER_LENGTH, ciphertext.length - TAG_LENGTH);

  const entry = keys.find((k) => k.version === keyVersion);
  if (!entry) {
    throw new SessionCipherError('مفتاح فك التشفير المطلوب غير متوفر.', 'unknown_key');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', entry.key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAAD(associatedData(purpose, subjectId, keyVersion));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    return { value: JSON.parse(plaintext.toString('utf8')) as T, keyVersion };
  } catch (err) {
    if (err instanceof SessionCipherError) throw err;
    throw new SessionCipherError('فشل التحقق من سلامة مغلّف الجلسة (مفتاح خاطئ أو بيانات معدّلة).', 'auth_failed');
  }
}

export function isSessionCipherConfigured(source = env): boolean {
  return Boolean(source.TG_SESSION_ENC_KEY);
}

export function encryptSession(accountId: string, payload: SessionPayload, source = env): SealedPayload {
  return sealPayload<SessionPayload>('session', accountId, payload, source);
}

export function decryptSession(accountId: string, ciphertext: Buffer, source = env): DecryptedSession {
  const { value, keyVersion } = openPayload<SessionPayload>('session', accountId, ciphertext, source);
  if (typeof value.session !== 'string' || value.session.length === 0) {
    throw new SessionCipherError('محتوى الجلسة غير صالح.', 'malformed');
  }
  return { session: value.session, updateState: value.updateState, savedAt: value.savedAt, keyVersion };
}

/** مقارنة ثابتة الزمن تُستخدم في الاختبارات للتحقق من عدم تطابق النص الصريح. */
export function containsPlaintext(ciphertext: Buffer, needle: string): boolean {
  const a = ciphertext;
  const b = Buffer.from(needle, 'utf8');
  if (b.length === 0 || b.length > a.length) return false;
  for (let i = 0; i <= a.length - b.length; i += 1) {
    if (timingSafeEqual(a.subarray(i, i + b.length), b)) return true;
  }
  return false;
}
