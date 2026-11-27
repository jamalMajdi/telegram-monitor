/**
 * مخزن التنبيهات (P4-و): صندوق وارد داخلي لكل مستخدم.
 *
 * قيود ملزمة:
 * - كل استعلام مقيَّد بـ`user_id`؛ لا صف لمستخدم آخر ولا عدّاد عابر للمستخدمين.
 * - لا نص حر: `alert_key` آلي، و`payload` أرقام/رموز مغلقة (قيد المخطط يفرض الحجم والكائن).
 * - تنبيه نشط واحد لكل (user_id, alert_key) — يضمنه فهرس فريد جزئي، والمخزن يعتمد عليه.
 */
import { query, withTransaction } from '../../db/pool.js';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertDraft {
  key: string;
  severity: AlertSeverity;
  observedCount: number;
  payload: Record<string, string | number | boolean | null>;
}

export interface AlertRow {
  id: string;
  alertKey: string;
  severity: AlertSeverity;
  observedCount: number;
  occurrences: number;
  payload: Record<string, unknown>;
  firstSeenAt: Date;
  lastSeenAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
}

export interface AlertListFilters {
  status: 'open' | 'acknowledged' | 'all';
  limit: number;
  /**
   * مؤشِّر على `first_seen_at` (ثابت لا يتغيّر) لا على `last_seen_at`.
   * السبب: `last_seen_at` يُحدَّث مع كل مسح، فمؤشِّر عليه «يقفز» بين الصفحات وتفقد صفوفاً.
   */
  cursor?: { firstSeenAt: Date; id: string } | undefined;
}

export interface AlertCounts {
  open: number;
  unacknowledged: number;
  critical: number;
  warning: number;
  info: number;
}

export interface NotificationsStore {
  /** يُزامن التنبيهات النشطة: يُحدِّث/يُنشئ ما ورد ويحلّ ما اختفى. يعيد ما تغيّر. */
  sync(userId: string, drafts: AlertDraft[]): Promise<{ created: number; updated: number; escalated: number; resolved: number }>;
  list(userId: string, filters: AlertListFilters): Promise<AlertRow[]>;
  counts(userId: string): Promise<AlertCounts>;
  acknowledge(userId: string, id: string): Promise<AlertRow | null>;
  acknowledgeAll(userId: string): Promise<number>;
  /** قراءة عتبة التصعيد من `system_settings` (Q26: قابلة للضبط). */
  systemCount(key: string, fallback: number): Promise<number>;
  /** تنبيهات نشطة لم يُبلَّغ عنها بالبريد بعد (P0: بريد التنبيهات). */
  listUnnotified(userId: string, severities: AlertSeverity[], limit?: number): Promise<AlertRow[]>;
  /** يختم `notified_at` بعد إدراج بريد التنبيه (منع التكرار). */
  markNotified(ids: string[]): Promise<number>;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 1, warning: 2, critical: 3 };

const SELECT_COLUMNS = `id, alert_key, severity::text as severity, observed_count, occurrences, payload,
                        first_seen_at, last_seen_at, acknowledged_at, resolved_at`;

function toRow(row: Record<string, unknown>): AlertRow {
  return {
    id: row.id as string,
    alertKey: row.alert_key as string,
    severity: row.severity as AlertSeverity,
    observedCount: Number(row.observed_count),
    occurrences: Number(row.occurrences),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    firstSeenAt: row.first_seen_at as Date,
    lastSeenAt: row.last_seen_at as Date,
    acknowledgedAt: (row.acknowledged_at ?? null) as Date | null,
    resolvedAt: (row.resolved_at ?? null) as Date | null,
  };
}

export class PgNotificationsStore implements NotificationsStore {
  /**
   * المزامنة كلها في معاملة واحدة: إما أن يرى المستخدم صورة متسقة أو لا شيء.
   * - التنبيه الموجود بنفس الخطورة: تحديث `observed_count`/`last_seen_at`/الحمولة.
   * - التصعيد (خطورة أعلى): عدّاد `occurrences` + إفراغ الاعتراف (اعتراف التحذير لا يسري على الحرج).
   * - الاختفاء من المسح: `resolved_at = now()` (لا حذف — السجل تاريخ).
   */
  async sync(
    userId: string,
    drafts: AlertDraft[],
  ): Promise<{ created: number; updated: number; escalated: number; resolved: number }> {
    return withTransaction(async (client) => {
      const existing = await client.query<{ id: string; alert_key: string; severity: AlertSeverity }>(
        `select id, alert_key, severity::text as severity
           from alert_notifications
          where user_id = $1 and resolved_at is null
          for update`,
        [userId],
      );
      const byKey = new Map(existing.rows.map((row) => [row.alert_key, row]));
      let created = 0;
      let updated = 0;
      let escalated = 0;

      for (const draft of drafts) {
        const current = byKey.get(draft.key);
        if (!current) {
          await client.query(
            `insert into alert_notifications (user_id, alert_key, severity, observed_count, payload, first_seen_at, last_seen_at)
             values ($1, $2, $3::alert_severity, $4, $5::jsonb,
                     date_trunc('milliseconds', now()), date_trunc('milliseconds', now()))`,
            [userId, draft.key, draft.severity, draft.observedCount, JSON.stringify(draft.payload)],
          );
          created += 1;
          continue;
        }
        const isEscalation = SEVERITY_RANK[draft.severity] > SEVERITY_RANK[current.severity];
        await client.query(
          `update alert_notifications
              set severity = $3::alert_severity,
                  observed_count = $4,
                  payload = $5::jsonb,
                  last_seen_at = date_trunc('milliseconds', now()),
                  occurrences = occurrences + case when $6 then 1 else 0 end,
                  acknowledged_at = case when $6 then null else acknowledged_at end
            where id = $1 and user_id = $2`,
          [current.id, userId, draft.severity, draft.observedCount, JSON.stringify(draft.payload), isEscalation],
        );
        if (isEscalation) escalated += 1;
        else updated += 1;
        byKey.delete(draft.key);
      }

      let resolved = 0;
      for (const stale of byKey.values()) {
        await client.query(
          'update alert_notifications set resolved_at = now() where id = $1 and user_id = $2 and resolved_at is null',
          [stale.id, userId],
        );
        resolved += 1;
      }

      return { created, updated, escalated, resolved };
    });
  }

  async list(userId: string, filters: AlertListFilters): Promise<AlertRow[]> {
    const params: unknown[] = [userId];
    let where = 'user_id = $1';
    if (filters.status === 'open') where += ' and resolved_at is null';
    else if (filters.status === 'acknowledged') where += ' and acknowledged_at is not null and resolved_at is null';
    if (filters.cursor) {
      params.push(filters.cursor.firstSeenAt, filters.cursor.id);
      // الفحوص الصريحة للأنواع ضرورية: مقارنة صف غير مُقيَّدة قد تُستنتج كـ`timestamp`
      // بلا منطقة زمنية فتُسقط/تُضيف صفوفاً بصمت.
      where += ` and (first_seen_at, id) < ($2::timestamptz, $3::uuid)`;
    }
    params.push(filters.limit);
    const limitPlaceholder = params.length;
    const res = await query(
      `select ${SELECT_COLUMNS} from alert_notifications
        where ${where}
        order by first_seen_at desc, id desc
        limit $${limitPlaceholder}`,
      params,
    );
    return res.rows.map((row) => toRow(row as Record<string, unknown>));
  }

  /**
   * التنبيهات النشطة التي لم يُرسل بريدها بعد.
   * الشرط: غير محلولة، وغير معترَف بها، ولم تُبلَّغ. الاعتراف يعني «رآها المستخدم»،
   * فلا نُزعجه ببريد عن شيء قال إنه يعرفه.
   */
  async listUnnotified(userId: string, severities: AlertSeverity[], limit = 5): Promise<AlertRow[]> {
    const res = await query<Record<string, unknown>>(
      `select ${SELECT_COLUMNS} from alert_notifications
        where user_id = $1
          and resolved_at is null
          and acknowledged_at is null
          and notified_at is null
          and severity = any($2::alert_severity[])
        order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, last_seen_at desc
        limit $3`,
      [userId, severities, Math.max(1, Math.min(limit, 20))],
    );
    return res.rows.map(toRow);
  }

  async markNotified(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await query(
      `update alert_notifications set notified_at = now()
        where id = any($1::uuid[]) and notified_at is null and resolved_at is null`,
      [ids],
    );
    return res.rowCount ?? 0;
  }

  async counts(userId: string): Promise<AlertCounts> {
    const res = await query<{
      open: number;
      unacknowledged: number;
      critical: number;
      warning: number;
      info: number;
    }>(
      `select
         count(*) filter (where resolved_at is null)::int as open,
         count(*) filter (where resolved_at is null and acknowledged_at is null)::int as unacknowledged,
         count(*) filter (where resolved_at is null and severity = 'critical')::int as critical,
         count(*) filter (where resolved_at is null and severity = 'warning')::int as warning,
         count(*) filter (where resolved_at is null and severity = 'info')::int as info
       from alert_notifications where user_id = $1`,
      [userId],
    );
    const row = res.rows[0];
    return {
      open: row?.open ?? 0,
      unacknowledged: row?.unacknowledged ?? 0,
      critical: row?.critical ?? 0,
      warning: row?.warning ?? 0,
      info: row?.info ?? 0,
    };
  }

  async acknowledge(userId: string, id: string): Promise<AlertRow | null> {
    const res = await query(
      `update alert_notifications
          set acknowledged_at = coalesce(acknowledged_at, now())
        where id = $1 and user_id = $2 and resolved_at is null
        returning ${SELECT_COLUMNS}`,
      [id, userId],
    );
    const row = res.rows[0];
    return row ? toRow(row as Record<string, unknown>) : null;
  }

  async acknowledgeAll(userId: string): Promise<number> {
    const res = await query(
      `update alert_notifications
          set acknowledged_at = now()
        where user_id = $1 and resolved_at is null and acknowledged_at is null`,
      [userId],
    );
    return res.rowCount ?? 0;
  }

  async systemCount(key: string, fallback: number): Promise<number> {
    const res = await query<{ value: unknown }>('select value from system_settings where key = $1', [key]);
    const raw = res.rows[0]?.value;
    const candidate =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { count?: unknown }).count : raw;
    const parsed = typeof candidate === 'number' ? candidate : typeof candidate === 'string' ? Number(candidate) : NaN;
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1000) return fallback;
    return Math.trunc(parsed);
  }
}
