/**
 * سجل الأخطاء الموحّد (P4-ج، Q19).
 *
 * القاعدة الحاكمة: **لا محتوى، لا أسرار، لا نصوص حرة**. كل ما يُكتب هنا يمرّ بـ`cleanDetail`
 * التي تُقنّع أي شكل يشبه رمز بوت أو رقماً طويلاً، ثم تُسقط أي قيمة لا تطابق نمط «المقطع الآلي».
 * وإذا فشل التقنيع لأي سبب ⇒ `null` (رفض آمن) لا كتابة مشكوك فيها.
 *
 * و`recordErrorEvent` لا يرمي أبداً: تسجيل الخطأ يجب ألا يُسقط العملية التي يُسجّل عنها.
 */
import { logger } from './logger.js';
import { query } from '../db/pool.js';

export type ErrorScope = 'telegram' | 'processing' | 'publishing' | 'auth' | 'system';
export type ErrorSeverity = 'warn' | 'error' | 'critical';

export interface ErrorEventInput {
  scope: ErrorScope;
  kind: string;
  code: string;
  severity?: ErrorSeverity;
  userId?: string | null;
  detail?: string | null;
  correlationId?: string | null;
}

/** قاموس مغلق للبادئات: التفصيل ليس حراً، بل مقطع آلي من هذه العائلات فقط. */
const DETAIL_PREFIXES = ['http', 'policy', 'attempt', 'stage', 'status', 'wait', 'reason', 'field', 'step'];
const DETAIL_PATTERN =
  /^(http|policy|attempt|stage|status|wait|reason|field|step)\.[a-z0-9_]{1,32}(\.[a-z0-9_]{1,32}){0,2}$/;
const BOT_TOKEN_SHAPE = /\d{4,}:[A-Za-z0-9_-]{10,}/;

/**
 * تقنيع المقطع ورفضه عند الشك.
 *
 * أي قيمة لا تنتمي إلى قاموس البادئات المعتمد ⇒ `null`. هذا هو الفرق بين «سجل بلا محتوى»
 * و«سجل نأمل ألا يحتوي محتوى»: النص الإنجليزي، والعربي، ورقم الهاتف، ورمز البوت — كلها تسقط هنا.
 */
export function cleanDetail(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const text = value.toLowerCase().trim();
    // 1) رموز البوت وأي أرقام طويلة: رفض مباشر، لا محاولة «تنظيف ثم تمرير».
    if (BOT_TOKEN_SHAPE.test(text)) return null;
    if (/\d{4,}/.test(text)) return null;
    // 2) أي حرف خارج [a-z0-9_.:/-] (عربي، مسافات، رموز) ⇒ رفض.
    if (!/^[a-z0-9_.:/-]+$/.test(text)) return null;
    if (text.length > 120) return null;
    // 3) القاموس المغلق هو الفيصل النهائي.
    if (!DETAIL_PREFIXES.includes(text.split('.')[0] ?? '')) return null;
    return DETAIL_PATTERN.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** كتابة حدث خطأ واحد. لا ترمي مهما حدث (فشل التسجيل يُذكر في pino فقط). */
export async function recordErrorEvent(input: ErrorEventInput): Promise<void> {
  const row = {
    userId: input.userId ?? null,
    scope: input.scope,
    kind: input.kind,
    code: input.code,
    severity: input.severity ?? 'error',
    detail: cleanDetail(input.detail),
    correlationId: input.correlationId ?? null,
  };
  try {
    await query(
      `insert into error_events (user_id, scope, kind, code, severity, detail, correlation_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [row.userId, row.scope, row.kind, row.code, row.severity, row.detail, row.correlationId],
    );
  } catch (err) {
    // لا محتوى في السجل النصي أيضاً: النوع والرمز فقط.
    logger.warn(
      { scope: row.scope, kind: row.kind, code: row.code, err: (err as Error)?.message?.slice(0, 120) },
      'تعذّر تسجيل حدث خطأ في قاعدة البيانات',
    );
  }
}
