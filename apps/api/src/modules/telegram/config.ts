/**
 * تهيئة تكامل تيليجرام: بيانات التطبيق ومفتاح تشفير الجلسات.
 * لا تُطبع قيم الأسرار أبداً؛ تُبلَّغ الحالة فقط (متوفر/غير متوفر).
 */
import { env } from '../../config/env.js';

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export interface TelegramConfig {
  /** true عندما تتوفر بيانات تطبيق Telegram ومفتاح تشفير صالح. */
  readonly ready: boolean;
  /** بيانات التطبيق إن توفرت. */
  readonly credentials?: TelegramCredentials;
  /** سبب عدم الجاهزية برسالة عربية آمنة (بلا قيم سرية). */
  readonly reason?: string;
  readonly encryptionKeyConfigured: boolean;
  readonly testServers: boolean;
  readonly catchUp: boolean;
  readonly connectionRetries: number;
  readonly maxReconnectAttempts: number;
  readonly reconnectBaseDelayMs: number;
  readonly floodSleepThreshold: number;
}

export function readTelegramConfig(source = env): TelegramConfig {
  const hasId = source.TG_API_ID !== undefined;
  const hasHash = source.TG_API_HASH !== undefined;
  const encryptionKeyConfigured = Boolean(source.TG_SESSION_ENC_KEY);
  const base = {
    encryptionKeyConfigured,
    testServers: source.TG_TEST_SERVERS,
    catchUp: source.TG_CATCH_UP,
    connectionRetries: source.TG_CONNECTION_RETRIES,
    maxReconnectAttempts: source.TG_MAX_RECONNECT_ATTEMPTS,
    reconnectBaseDelayMs: source.TG_RECONNECT_BASE_DELAY_MS,
    floodSleepThreshold: source.TG_FLOOD_SLEEP_THRESHOLD,
  };

  if (!hasId || !hasHash) {
    return { ready: false, reason: 'بيانات تطبيق Telegram غير مهيأة (TG_API_ID / TG_API_HASH).', ...base };
  }
  if (!encryptionKeyConfigured) {
    return {
      ready: false,
      reason: 'مفتاح تشفير جلسات تيليجرام غير مهيأ (TG_SESSION_ENC_KEY).',
      ...base,
    };
  }
  return {
    ready: true,
    credentials: { apiId: source.TG_API_ID as number, apiHash: source.TG_API_HASH as string },
    ...base,
  };
}

export const TELEPROTO_PACKAGE = 'teleproto';
export const TELEPROTO_VERSION = '1.234.0';
export const TELEPROTO_SCHEMA_LAYER = 234;
