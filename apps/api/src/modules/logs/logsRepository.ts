/**
 * مستودع السجلات (P4-ج).
 *
 * - قراءة المالك: صفوفه فقط (`user_id = $1`)، بلا استثناء.
 * - قراءة المدير: **تجميع** بلا هوية مستخدم وبلا `detail` — أعداد وأنواع ورموز فقط (Q24).
 * - الترقيم مؤشِّر (keyset على `id` تنازلياً) فلا تتأثر الصفحة بإدخالات جديدة (Q30).
 */
import { query } from '../../db/pool.js';

export interface LogFilters {
  scope?: string;
  kind?: string;
  severity?: string;
  code?: string;
  from?: Date;
  to?: Date;
  limit: number;
  /** مؤشِّر الصفحة: صفوف أقدم من هذا المعرّف. */
  cursorId?: number | null;
}

export interface LogRow {
  id: number;
  scope: string;
  kind: string;
  code: string;
  severity: string;
  detail: string | null;
  correlationId: string | null;
  occurredAt: Date;
}

export interface AdminErrorGroup {
  scope: string;
  kind: string;
  code: string;
  severity: string;
  occurrences: number;
  affectedUsers: number;
  lastOccurredAt: Date;
}

export interface LogsStore {
  listForUser(userId: string, filters: LogFilters): Promise<LogRow[]>;
  countForUser(userId: string): Promise<number>;
  groupForAdmin(filters: { from?: Date; scope?: string; limit: number }): Promise<AdminErrorGroup[]>;
  totalsForAdmin(since: Date): Promise<{ total: number; critical: number; byScope: Record<string, number> }>;
}

function pageClause(filters: LogFilters, params: unknown[]): string {
  const clauses: string[] = [];
  if (filters.scope) {
    params.push(filters.scope);
    clauses.push(`scope = $${params.length}::error_scope`);
  }
  if (filters.kind) {
    params.push(filters.kind);
    clauses.push(`kind = $${params.length}`);
  }
  if (filters.severity) {
    params.push(filters.severity);
    clauses.push(`severity = $${params.length}::error_severity`);
  }
  if (filters.code) {
    params.push(filters.code);
    clauses.push(`code = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    clauses.push(`occurred_at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    clauses.push(`occurred_at <= $${params.length}`);
  }
  if (filters.cursorId !== null && filters.cursorId !== undefined) {
    params.push(filters.cursorId);
    clauses.push(`id < $${params.length}`);
  }
  return clauses.length > 0 ? `and ${clauses.join(' and ')}` : '';
}

export class PgLogsStore implements LogsStore {
  async listForUser(userId: string, filters: LogFilters): Promise<LogRow[]> {
    const params: unknown[] = [userId];
    const where = pageClause(filters, params);
    params.push(filters.limit);
    const res = await query<{
      id: string;
      scope: string;
      kind: string;
      code: string;
      severity: string;
      detail: string | null;
      correlation_id: string | null;
      occurred_at: Date;
    }>(
      `select id, scope, kind, code, severity, detail, correlation_id, occurred_at
         from error_events
        where user_id = $1 ${where}
        order by id desc
        limit $${params.length}`,
      params,
    );
    return res.rows.map((row) => ({
      id: Number(row.id),
      scope: row.scope,
      kind: row.kind,
      code: row.code,
      severity: row.severity,
      detail: row.detail,
      correlationId: row.correlation_id,
      occurredAt: row.occurred_at,
    }));
  }

  async countForUser(userId: string): Promise<number> {
    const res = await query<{ total: number }>(
      'select count(*)::int as total from error_events where user_id = $1',
      [userId],
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  async groupForAdmin(filters: { from?: Date; scope?: string; limit: number }): Promise<AdminErrorGroup[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (filters.from) {
      params.push(filters.from);
      clauses.push(`occurred_at >= $${params.length}`);
    }
    if (filters.scope) {
      params.push(filters.scope);
      clauses.push(`scope = $${params.length}::error_scope`);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
    params.push(filters.limit);
    const res = await query<{
      scope: string;
      kind: string;
      code: string;
      severity: string;
      occurrences: number;
      affected_users: number;
      last_occurred_at: Date;
    }>(
      `select scope, kind, code,
              max(severity::text)::error_severity as severity,
              count(*)::int as occurrences,
              count(distinct user_id)::int as affected_users,
              max(occurred_at) as last_occurred_at
         from error_events
         ${where}
        group by scope, kind, code
        order by occurrences desc, last_occurred_at desc
        limit $${params.length}`,
      params,
    );
    return res.rows.map((row) => ({
      scope: row.scope,
      kind: row.kind,
      code: row.code,
      severity: row.severity,
      occurrences: Number(row.occurrences),
      affectedUsers: Number(row.affected_users),
      lastOccurredAt: row.last_occurred_at,
    }));
  }

  async totalsForAdmin(since: Date): Promise<{ total: number; critical: number; byScope: Record<string, number> }> {
    const res = await query<{ scope: string; total: number; critical: number }>(
      `select scope,
              count(*)::int as total,
              count(*) filter (where severity = 'critical')::int as critical
         from error_events
        where occurred_at >= $1
        group by scope`,
      [since],
    );
    const byScope: Record<string, number> = {};
    let total = 0;
    let critical = 0;
    for (const row of res.rows) {
      byScope[row.scope] = Number(row.total);
      total += Number(row.total);
      critical += Number(row.critical);
    }
    return { total, critical, byScope };
  }
}
