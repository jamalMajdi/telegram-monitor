/**
 * تدقيق تشغيلي: يُسجّل الأفعال دون محتوى رسائل أو أسرار.
 * القاعدة المعتمدة D07: الرفض افتراضي، وكل وصول فعلي إلى المحتوى يُدقَّق.
 * في المرحلة الأولى يُستخدم لتسجيل أحداث الهوية والإدارة.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.js';
import { logger } from './logger.js';

export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditEvent {
  action: string;
  actorUserId?: string | null;
  actorRole?: 'user' | 'admin' | null;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: AuditOutcome;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

type Executor = PoolClient | null;

export async function recordAudit(event: AuditEvent, client: Executor = null): Promise<void> {
  const sql = `
    insert into audit_events
      (actor_user_id, actor_role, action, target_type, target_id, outcome, ip, user_agent, metadata)
    values ($1, $2, $3, $4, $5, $6, $7::inet, $8, $9::jsonb)
  `;
  const params = [
    event.actorUserId ?? null,
    event.actorRole ?? null,
    event.action,
    event.targetType ?? null,
    event.targetId ?? null,
    event.outcome ?? 'success',
    event.ip ?? null,
    event.userAgent ?? null,
    JSON.stringify(event.metadata ?? {}),
  ];
  try {
    if (client) {
      await client.query(sql, params);
    } else {
      await query(sql, params);
    }
  } catch (err) {
    // فشل التدقيق لا يُسقط الطلب تلقائياً هنا، لكنه يصدر في السجل بوصفه خطأً جسيماً.
    logger.error({ err: err instanceof Error ? err.message : String(err), action: event.action }, 'فشل تسجيل حدث التدقيق');
    throw err;
  }
}
