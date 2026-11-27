/**
 * تشفير رموز بوتات النشر عند الراحة (Q1) — نفس صيغة مغلّف الجلسات، بمفتاح مستقل.
 *
 * - المفتاح: `TG_BOT_ENC_KEY` (32 بايت base64)، ومفتاح سابق للفك فقط عند التدوير.
 *   الفصل عن `TG_SESSION_ENC_KEY` مقصود: اختراق مفتاح أحدهما لا يفتح الآخر.
 * - AAD: `tg-bot:v1:<botRowId>:<keyVersion>` — نسخ مغلّف بوت إلى صف آخر يُفشل الفك.
 * - لا يُعاد الرمز الصريح من أي دالة عامة هنا إلا عبر `openBotToken` عند الإرسال (7-د)،
 *   ولا يُسجَّل ولا يُعاد في أي استجابة HTTP.
 */
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import {
  CipherKeyEntry,
  openWithKeys,
  sealWithKey,
  SessionCipherError,
} from '../telegram/sessionCipher.js';

const KEY_LENGTH = 32;
const SEALED_PURPOSE = 'bot' as const;

export type BotCipherErrorCode = 'not_configured' | 'malformed' | 'unknown_key' | 'auth_failed';

export class BotCipherError extends Error {
  constructor(
    message: string,
    readonly code: BotCipherErrorCode,
  ) {
    super(message);
    this.name = 'BotCipherError';
  }
}

interface BotPayload {
  token: string;
  savedAt: string;
}

/** حلقة مفاتيح رموز البوتات: المفتاح الحالي + مفتاح سابق اختياري (فك فقط). */
export function readBotKeyring(source = env): CipherKeyEntry[] {
  const keys: CipherKeyEntry[] = [];
  const current = source.TG_BOT_ENC_KEY;
  const previous = source.TG_BOT_ENC_KEY_PREVIOUS;
  const version = source.TG_BOT_ENC_KEY_VERSION ?? 1;
  if (current) {
    const key = Buffer.from(current, 'base64');
    if (key.length !== KEY_LENGTH) {
      throw new BotCipherError('مفتاح تشفير رموز البوتات الحالي غير صالح الطول.', 'not_configured');
    }
    keys.push({ version, key });
  }
  if (previous) {
    const key = Buffer.from(previous, 'base64');
    if (key.length !== KEY_LENGTH) {
      throw new BotCipherError('مفتاح تشفير رموز البوتات السابق غير صالح الطول.', 'not_configured');
    }
    if (version <= 1) {
      throw new BotCipherError(
        'لا يمكن قبول مفتاح بوت سابق مع نسخة المفتاح 1؛ ارفع TG_BOT_ENC_KEY_VERSION.',
        'not_configured',
      );
    }
    keys.push({ version: version - 1, key });
  }
  return keys;
}

export function isBotCipherConfigured(source = env): boolean {
  return Boolean(source.TG_BOT_ENC_KEY);
}

/** بصمة الرمز (sha-256) لكشف تغييره وتدقيقه دون تخزينه صريحاً. */
export function fingerprintBotToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** تشفير رمز البوت وربطه بمعرّف صف البوت (AAD). */
export function sealBotToken(
  botId: string,
  token: string,
  source = env,
): { ciphertext: Buffer; keyVersion: number; fingerprint: string } {
  let keys: CipherKeyEntry[];
  try {
    keys = readBotKeyring(source);
  } catch (err) {
    throw toBotCipherError(err);
  }
  const [entry] = keys;
  if (!entry) {
    throw new BotCipherError('مفتاح تشفير رموز البوتات غير مهيأ.', 'not_configured');
  }
  const payload: BotPayload = { token, savedAt: new Date().toISOString() };
  try {
    const sealed = sealWithKey<BotPayload>(SEALED_PURPOSE, botId, payload, entry);
    return { ciphertext: sealed.ciphertext, keyVersion: sealed.keyVersion, fingerprint: fingerprintBotToken(token) };
  } catch (err) {
    throw toBotCipherError(err);
  }
}

/** فك رمز البوت (يُستخدم لحظة التحقق/الإرسال فقط؛ لا يُسجَّل ولا يُعاد للعميل). */
export function openBotToken(botId: string, ciphertext: Buffer, source = env): { token: string; keyVersion: number } {
  let keys: CipherKeyEntry[];
  try {
    keys = readBotKeyring(source);
  } catch (err) {
    throw toBotCipherError(err);
  }
  if (keys.length === 0) {
    throw new BotCipherError('مفتاح تشفير رموز البوتات غير مهيأ.', 'not_configured');
  }
  try {
    const { value, keyVersion } = openWithKeys<BotPayload>(SEALED_PURPOSE, botId, ciphertext, keys);
    if (typeof value.token !== 'string' || value.token.length === 0) {
      throw new BotCipherError('محتوى مغلّف رمز البوت غير صالح.', 'malformed');
    }
    return { token: value.token, keyVersion };
  } catch (err) {
    throw toBotCipherError(err);
  }
}

function toBotCipherError(err: unknown): BotCipherError {
  if (err instanceof BotCipherError) return err;
  if (err instanceof SessionCipherError) return new BotCipherError(err.message, err.code);
  return new BotCipherError('تعذّر معالجة مغلّف رمز البوت.', 'malformed');
}
