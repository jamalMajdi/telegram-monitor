/**
 * مخزن صندوق البريد الصادر (P0 — تدقيق ما قبل التسليم).
 *
 * ضمانات:
 * - **استحواذ ذرّي بلُقية**: `for update skip locked` + `lease_expires_at` — فلا يرسل
 *   عاملان الرسالة نفسها، ولو تشارك أكثر من عملية على القاعدة.
 * - **إعادة محاولة محدودة**: `attempts` + `next_attempt_at`، ثم فشل نهائي `failed`.
 * - **منع التكرار بمفتاح**: `dedupe_key` فريد؛ إعادة إدراج نفس الحدث لا تُنشئ بريداً ثانياً.
 * - لا محتوى رسائل في الصف: القالب مغلق والحمولة أرقام/رموز (الرمز الوحيد مشفّر).
 */
import { query, withTransaction } from '../../db/pool.js';

export type OutboxStatus = 'pending' | 'sent' | 'failed' | 'discarded';

export interface OutboxRow {
  id: string;
  userId: string | null;
  recipient: string;
  template: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
}

export interface EnqueueInput {
  userId: string | null;
  recipient: string;
  template: string;
  payload: Record<string, unknown>;
  /** عند وجوده: لا يُدرج صف جديد إن كان المفتاح موجوداً (يعيد false). */
  dedupeKey?: string | null;
}

export interface OutboxStore {
  enqueue(input: EnqueueInput): Promise<boolean>;
  claim(owner: string, leaseMs: number, maxAttempts: number): Promise<OutboxRow | null>;
  markSent(id: string): Promise<void>;
  markFailed(input: { id: string; error: string; retryAt: Date | null; final: boolean }): Promise<void>;
  counts(): Promise<{ pending: number; failed: number; sent: number }>;
}

const MAX_ERROR_LENGTH = 200;

export class PgOutboxStore implements OutboxStore {
  async enqueue(input: EnqueueInput): Promise<boolean> {
    const res = await query(
      `insert into notification_outbox (user_id, channel, recipient, template, payload, dedupe_key, next_attempt_at)
       values ($1, 'email', $2, $3, $4::jsonb, $5, now())
       on conflict (dedupe_key) do nothing
       returning id`,
      [input.userId, input.recipient, input.template, JSON.stringify(input.payload), input.dedupeKey ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async claim(owner: string, leaseMs: number, maxAttempts: number): Promise<OutboxRow | null> {
    const res = await query<{
      id: string;
      user_id: string | null;
      recipient: string;
      template: string;
      payload: Record<string, unknown>;
      status: OutboxStatus;
      attempts: number;
    }>(
      `with candidate as (
         select id from notification_outbox
          where status = 'pending'
            and attempts < $3::int
            and (next_attempt_at is null or next_attempt_at <= now())
            and (lease_expires_at is null or lease_expires_at <= now())
          order by created_at
          limit 1
          for update skip locked
       )
       update notification_outbox o
          set lease_owner = $1,
              lease_expires_at = now() + ($2::int * interval '1 millisecond'),
              attempts = o.attempts + 1,
              last_attempt_at = now()
         from candidate c
        where o.id = c.id
        returning o.id, o.user_id, o.recipient, o.template, o.payload, o.status::text as status, o.attempts`,
      [owner, leaseMs, maxAttempts],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      recipient: row.recipient,
      template: row.template,
      payload: row.payload,
      status: row.status,
      attempts: Number(row.attempts),
    };
  }

  async markSent(id: string): Promise<void> {
    await query(
      `update notification_outbox
          set status = 'sent', sent_at = now(), last_error = null,
              lease_owner = null, lease_expires_at = null, next_attempt_at = null
        where id = $1`,
      [id],
    );
  }

  async markFailed(input: { id: string; error: string; retryAt: Date | null; final: boolean }): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `update notification_outbox
            set status = $2::outbox_status,
                last_error = $3,
                next_attempt_at = $4,
                lease_owner = null,
                lease_expires_at = null
          where id = $1`,
        [input.id, input.final ? 'failed' : 'pending', input.error.slice(0, MAX_ERROR_LENGTH), input.retryAt],
      );
    });
  }

  async counts(): Promise<{ pending: number; failed: number; sent: number }> {
    const res = await query<{ pending: string; failed: string; sent: string }>(
      `select count(*) filter (where status = 'pending')::text as pending,
              count(*) filter (where status = 'failed')::text as failed,
              count(*) filter (where status = 'sent')::text as sent
         from notification_outbox`,
    );
    const row = res.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
      sent: Number(row?.sent ?? 0),
    };
  }
}
