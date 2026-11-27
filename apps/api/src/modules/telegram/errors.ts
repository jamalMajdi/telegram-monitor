/**
 * تصنيف أخطاء Telegram RPC دون الاعتماد على نص الرسالة فقط:
 * تُستخدم أصناف teleproto/errors عند توفرها، مع احتياط duck-typing
 * حتى تعمل الاختبارات المحاكاة دون اتصال حقيقي.
 *
 * قاعدة معتمدة: FloodWait لا يُنتظر طويلاً داخل الطلب، ولا تُعاد المحاولة بلا حد،
 * ولا يُدور الاتصال فوراً بعد خطأ تفويض (O10/§11).
 */
import { FloodWaitError, RPCError, SessionRevokedError, AuthKeyUnregisteredError, FloodError } from 'teleproto/errors';

export type TelegramFailureKind =
  | 'flood_wait'      // انتظار إجباري من Telegram
  | 'auth_revoked'    // الجلسة أو مفتاح المصادقة لم يعد صالحاً → يحتاج إعادة دخول
  | 'unauthorized'    // خطأ مصادقة آخر
  | 'network'         // انقطاع شبكة/مهلة/انقطاع اتصال
  | 'rpc'             // رفض RPC آخر من Telegram
  | 'unknown';

export interface ClassifiedTelegramError {
  kind: TelegramFailureKind;
  /** رمز تشغيلي قصير يُحفظ في السجلات (بلا نص حساس). */
  code: string;
  /** مدة الانتظار بالثواني عند flood_wait. */
  waitSeconds?: number;
  /** هل يُعقل إعادة المحاولة تلقائياً؟ */
  retryable: boolean;
  /** هل تتطلب الحالة تدخلاً من المستخدم (إعادة دخول)؟ */
  needsUserAction: boolean;
}

const NETWORK_HINTS = [
  'TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'CONNECTION',
  'SOCKET',
  'NETWORK',
];

function looksLikeNetworkError(err: Record<string, unknown>): boolean {
  const code = typeof err.code === 'string' ? err.code : '';
  if (NETWORK_HINTS.some((hint) => code.includes(hint))) return true;
  const name = typeof err.name === 'string' ? err.name : '';
  if (/Connection|Timeout|NotConnected|Disconnect|Network/i.test(name)) return true;
  const message = typeof err.message === 'string' ? err.message : '';
  return /ECONNRESET|ETIMEDOUT|socket hang up|Connection closed/i.test(message);
}

export function classifyTelegramError(error: unknown): ClassifiedTelegramError {
  if (error instanceof FloodWaitError || error instanceof FloodError) {
    const seconds = typeof (error as unknown as { seconds?: number }).seconds === 'number'
      ? (error as unknown as { seconds: number }).seconds
      : undefined;
    return {
      kind: 'flood_wait',
      code: 'FLOOD_WAIT',
      waitSeconds: seconds,
      retryable: false,
      needsUserAction: false,
    };
  }
  if (error instanceof SessionRevokedError || error instanceof AuthKeyUnregisteredError) {
    return { kind: 'auth_revoked', code: error.constructor.name, retryable: false, needsUserAction: true };
  }
  if (error instanceof RPCError) {
    const code = typeof error.code === 'number' ? error.code : 0;
    const message = error.errorMessage ?? error.message;
    if (code === 420) {
      return { kind: 'flood_wait', code: 'FLOOD_WAIT', waitSeconds: 60, retryable: false, needsUserAction: false };
    }
    if (code === 401) {
      return { kind: 'unauthorized', code: message, retryable: false, needsUserAction: true };
    }
    return { kind: 'rpc', code: message, retryable: code >= 500, needsUserAction: false };
  }

  // احتياط للأخطاء المحاكاة أو الأصناف الجديدة: مطابقة بالشكل لا بالنص الحرفي.
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    const code = typeof record.code === 'number' ? record.code : 0;
    if (name === 'FloodWaitError' || code === 420) {
      const seconds = typeof record.seconds === 'number' ? record.seconds : undefined;
      return { kind: 'flood_wait', code: 'FLOOD_WAIT', waitSeconds: seconds, retryable: false, needsUserAction: false };
    }
    if (name === 'SessionRevokedError' || name === 'AuthKeyUnregisteredError') {
      return { kind: 'auth_revoked', code: name, retryable: false, needsUserAction: true };
    }
    if (name === 'AuthKeyDuplicatedError') {
      return { kind: 'auth_revoked', code: name, retryable: false, needsUserAction: true };
    }
    if (code === 401) {
      return { kind: 'unauthorized', code: name || 'UNAUTHORIZED', retryable: false, needsUserAction: true };
    }
    if (looksLikeNetworkError(record)) {
      return { kind: 'network', code: 'NETWORK', retryable: true, needsUserAction: false };
    }
    if (name.endsWith('Error') && code >= 400) {
      return { kind: 'rpc', code: name, retryable: code >= 500, needsUserAction: false };
    }
  }
  return { kind: 'unknown', code: 'UNKNOWN', retryable: false, needsUserAction: false };
}

/** تأخير أسّي محدود مع تشتيت عشوائي — لا نمو غير محدود ولا حلقات سريعة. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs = 60_000): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  const raw = baseMs * 2 ** exponent;
  const jitter = Math.floor(raw * 0.2 * Math.random());
  return Math.min(raw + jitter, maxMs);
}
