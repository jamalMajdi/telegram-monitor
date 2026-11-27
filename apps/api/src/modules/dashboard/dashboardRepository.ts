/**
 * مخزن نموذج القراءة للوحة (P4-أ): عدّادات فقط، بلا نصوص رسائل ولا أسرار — امتداد D07.
 *
 * كل الأرقام تأتي من قاعدة البيانات (لا ذاكرة عملية)، ومحصورة بمالك واحد (`user_id` في كل استعلام).
 */
import { query } from '../../db/pool.js';

export interface DashboardCounts {
  telegram: { accounts: number; active: number; needsReauth: number; lastConnectedAt: Date | null };
  sources: { total: number; active: number; paused: number };
  filters: { total: number; active: number };
  templates: { total: number };
  destinations: { total: number; active: number };
  messages: {
    matchedTotal: number;
    matchedLast24h: number;
    processedTotal: number;
    lastSeenAt: Date | null;
  };
  deliveries: {
    total: number;
    awaitingReview: number;
    queued: number;
    published: number;
    publishedLast24h: number;
    failed: number;
    uncertain: number;
    blocked: number;
  };
}

export interface ActivityRow {
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  occurredAt: Date;
}

const COUNTS_SQL = `
  with owned_identities as (
    select id, state, publish_state, first_seen_at from message_identity where user_id = $1
  )
  select
    (select count(*)::int from telegram_accounts where user_id = $1) as accounts_total,
    (select count(*)::int from telegram_accounts where user_id = $1 and status = 'active') as accounts_active,
    (select count(*)::int from telegram_accounts where user_id = $1 and status = 'needs_reauth') as accounts_reauth,
    (select max(last_connected_at) from telegram_accounts where user_id = $1) as accounts_last_connected,
    (select count(*)::int from telegram_sources where user_id = $1) as sources_total,
    (select count(*)::int from telegram_sources where user_id = $1 and status = 'active') as sources_active,
    (select count(*)::int from telegram_sources where user_id = $1 and status = 'paused') as sources_paused,
    (select count(*)::int from rule_sets where user_id = $1 and kind = 'filter') as filters_total,
    (select count(*)::int from rule_sets where user_id = $1 and kind = 'filter' and enabled) as filters_active,
    (select count(*)::int from templates where user_id = $1) as templates_total,
    (select count(*)::int from destinations where user_id = $1 and status <> 'deleted') as destinations_total,
    (select count(*)::int from destinations where user_id = $1 and status = 'active') as destinations_active,
    (select count(*)::int from message_matches m join owned_identities i on i.id = m.identity_id) as matched_total,
    (select count(*)::int from message_matches m join owned_identities i on i.id = m.identity_id
      where m.matched_at >= now() - interval '24 hours') as matched_24h,
    (select count(*)::int from owned_identities where state = 'processed') as processed_total,
    (select max(first_seen_at) from owned_identities) as last_seen_at,
    (select count(*)::int from deliveries where user_id = $1) as deliveries_total,
    (select count(*)::int from deliveries where user_id = $1 and status = 'awaiting_review') as deliveries_review,
    (select count(*)::int from deliveries where user_id = $1 and status in ('queued', 'sending')) as deliveries_queued,
    (select count(*)::int from deliveries where user_id = $1 and status = 'published') as deliveries_published,
    (select count(*)::int from deliveries where user_id = $1 and status = 'published'
      and created_at >= now() - interval '24 hours') as deliveries_published_24h,
    (select count(*)::int from deliveries where user_id = $1 and status = 'failed') as deliveries_failed,
    (select count(*)::int from deliveries where user_id = $1 and status = 'uncertain') as deliveries_uncertain,
    (select count(*)::int from deliveries where user_id = $1 and status = 'blocked') as deliveries_blocked
`;

interface CountsRow {
  accounts_total: number;
  accounts_active: number;
  accounts_reauth: number;
  accounts_last_connected: Date | null;
  sources_total: number;
  sources_active: number;
  sources_paused: number;
  filters_total: number;
  filters_active: number;
  templates_total: number;
  destinations_total: number;
  destinations_active: number;
  matched_total: number;
  matched_24h: number;
  processed_total: number;
  last_seen_at: Date | null;
  deliveries_total: number;
  deliveries_review: number;
  deliveries_queued: number;
  deliveries_published: number;
  deliveries_published_24h: number;
  deliveries_failed: number;
  deliveries_uncertain: number;
  deliveries_blocked: number;
}

export interface DashboardStore {
  counts(userId: string): Promise<DashboardCounts>;
  activity(userId: string, limit: number): Promise<ActivityRow[]>;
}

export class PgDashboardStore implements DashboardStore {
  async counts(userId: string): Promise<DashboardCounts> {
    const res = await query<CountsRow>(COUNTS_SQL, [userId]);
    const row = res.rows[0];
    if (!row) {
      throw new Error('استعلام عدّادات اللوحة لم يُعد صفاً');
    }
    return {
      telegram: {
        accounts: Number(row.accounts_total),
        active: Number(row.accounts_active),
        needsReauth: Number(row.accounts_reauth),
        lastConnectedAt: row.accounts_last_connected,
      },
      sources: {
        total: Number(row.sources_total),
        active: Number(row.sources_active),
        paused: Number(row.sources_paused),
      },
      filters: { total: Number(row.filters_total), active: Number(row.filters_active) },
      templates: { total: Number(row.templates_total) },
      destinations: {
        total: Number(row.destinations_total),
        active: Number(row.destinations_active),
      },
      messages: {
        matchedTotal: Number(row.matched_total),
        matchedLast24h: Number(row.matched_24h),
        processedTotal: Number(row.processed_total),
        lastSeenAt: row.last_seen_at,
      },
      deliveries: {
        total: Number(row.deliveries_total),
        awaitingReview: Number(row.deliveries_review),
        queued: Number(row.deliveries_queued),
        published: Number(row.deliveries_published),
        publishedLast24h: Number(row.deliveries_published_24h),
        failed: Number(row.deliveries_failed),
        uncertain: Number(row.deliveries_uncertain),
        blocked: Number(row.deliveries_blocked),
      },
    };
  }

  /** آخر العمليات: من سجل التدقيق، بلا محتوى رسائل ولا عناوين شبكية. */
  async activity(userId: string, limit: number): Promise<ActivityRow[]> {
    const res = await query<{
      action: string;
      target_type: string | null;
      target_id: string | null;
      outcome: string;
      occurred_at: Date;
    }>(
      `select action, target_type, target_id, outcome, occurred_at
         from audit_events
        where actor_user_id = $1
        order by occurred_at desc
        limit $2`,
      [userId, limit],
    );
    return res.rows.map((row) => ({
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      outcome: row.outcome,
      occurredAt: row.occurred_at,
    }));
  }
}
