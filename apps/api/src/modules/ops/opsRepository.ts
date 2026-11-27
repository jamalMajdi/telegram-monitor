/**
 * مخزن التشغيل (P4-ب): نبض العوامل، عمق الطابور، وعدّادات النشر والالتقاط.
 *
 * قيود ملزمة: لا نصوص رسائل، ولا رموز، ولا عناوين محادثات — أعداد وتواريخ وأسماء حالات فقط (D07).
 */
import { query } from '../../db/pool.js';

export interface HeartbeatRow {
  name: string;
  instance: string;
  lastSeenAt: Date;
  meta: Record<string, unknown>;
}

export interface QueueSnapshot {
  pendingParts: number;
  deliveriesQueued: number;
  oldestPendingAgeSeconds: number | null;
}

export interface DeliveryWindow {
  published: number;
  failed: number;
  uncertain: number;
  partial: number;
  blocked: number;
}

export interface AttemptWindow {
  retryable: number;
  permanent: number;
  uncertain: number;
  total: number;
}

export interface IngestSnapshot {
  lastMessageAt: Date | null;
  messagesLast24h: number;
  accountsTotal: number;
  accountsActive: number;
  accountsNeedsReauth: number;
}

export interface OpsStore {
  upsertHeartbeat(input: { name: string; instance: string; meta: Record<string, unknown> }): Promise<void>;
  listHeartbeats(): Promise<HeartbeatRow[]>;
  queue(): Promise<QueueSnapshot>;
  deliveryWindow(hours: number): Promise<DeliveryWindow>;
  attemptWindow(hours: number): Promise<AttemptWindow>;
  ingest(): Promise<IngestSnapshot>;
}

export class PgOpsStore implements OpsStore {
  async upsertHeartbeat(input: { name: string; instance: string; meta: Record<string, unknown> }): Promise<void> {
    await query(
      `insert into worker_heartbeats (name, instance, last_seen_at, meta)
       values ($1, $2, now(), $3::jsonb)
       on conflict (name, instance) do update set last_seen_at = now(), meta = excluded.meta`,
      [input.name, input.instance, JSON.stringify(input.meta)],
    );
  }

  async listHeartbeats(): Promise<HeartbeatRow[]> {
    const res = await query<{ name: string; instance: string; last_seen_at: Date; meta: unknown }>(
      'select name, instance, last_seen_at, meta from worker_heartbeats order by last_seen_at desc',
    );
    return res.rows.map((row) => ({
      name: row.name,
      instance: row.instance,
      lastSeenAt: row.last_seen_at,
      meta: (row.meta ?? {}) as Record<string, unknown>,
    }));
  }

  async queue(): Promise<QueueSnapshot> {
    const res = await query<{
      pending_parts: number;
      deliveries_queued: number;
      oldest_pending_seconds: number | null;
    }>(
      `select
         (select count(*)::int from delivery_parts where status = 'pending') as pending_parts,
         (select count(*)::int from deliveries where status in ('queued', 'sending')) as deliveries_queued,
         (select extract(epoch from (now() - min(d.created_at)))::int
            from delivery_parts p join deliveries d on d.id = p.delivery_id
           where p.status = 'pending') as oldest_pending_seconds`,
    );
    const row = res.rows[0]!;
    return {
      pendingParts: Number(row.pending_parts),
      deliveriesQueued: Number(row.deliveries_queued),
      oldestPendingAgeSeconds: row.oldest_pending_seconds === null ? null : Number(row.oldest_pending_seconds),
    };
  }

  async deliveryWindow(hours: number): Promise<DeliveryWindow> {
    const res = await query<{
      published: number;
      failed: number;
      uncertain: number;
      partial: number;
      blocked: number;
    }>(
      `select
         count(*) filter (where status = 'published')::int as published,
         count(*) filter (where status = 'failed')::int as failed,
         count(*) filter (where status = 'uncertain')::int as uncertain,
         count(*) filter (where status = 'partial')::int as partial,
         count(*) filter (where status = 'blocked')::int as blocked
       from deliveries
      where created_at >= now() - ($1::int * interval '1 hour')`,
      [hours],
    );
    const row = res.rows[0]!;
    return {
      published: Number(row.published),
      failed: Number(row.failed),
      uncertain: Number(row.uncertain),
      partial: Number(row.partial),
      blocked: Number(row.blocked),
    };
  }

  async attemptWindow(hours: number): Promise<AttemptWindow> {
    const res = await query<{ retryable: number; permanent: number; uncertain: number; total: number }>(
      `select
         count(*) filter (where outcome = 'retryable')::int as retryable,
         count(*) filter (where outcome = 'permanent')::int as permanent,
         count(*) filter (where outcome = 'uncertain')::int as uncertain,
         count(*)::int as total
       from delivery_attempts
      where started_at >= now() - ($1::int * interval '1 hour')`,
      [hours],
    );
    const row = res.rows[0]!;
    return {
      retryable: Number(row.retryable),
      permanent: Number(row.permanent),
      uncertain: Number(row.uncertain),
      total: Number(row.total),
    };
  }

  async ingest(): Promise<IngestSnapshot> {
    const res = await query<{
      last_message_at: Date | null;
      messages_24h: number;
      accounts_total: number;
      accounts_active: number;
      accounts_reauth: number;
    }>(
      `select
         (select max(first_seen_at) from message_identity) as last_message_at,
         (select count(*)::int from message_identity where first_seen_at >= now() - interval '24 hours') as messages_24h,
         (select count(*)::int from telegram_accounts) as accounts_total,
         (select count(*)::int from telegram_accounts where status = 'active') as accounts_active,
         (select count(*)::int from telegram_accounts where status = 'needs_reauth') as accounts_reauth`,
    );
    const row = res.rows[0]!;
    return {
      lastMessageAt: row.last_message_at,
      messagesLast24h: Number(row.messages_24h),
      accountsTotal: Number(row.accounts_total),
      accountsActive: Number(row.accounts_active),
      accountsNeedsReauth: Number(row.accounts_reauth),
    };
  }
}
