/**
 * مخزن مصادر المراقبة: كل عملية مقيّدة بمالك المصدر، والهوية ثابتة (نوع + معرّف رقمي).
 * فترات التفعيل/الإيقاف تُسجَّل صراحةً (نموذج البيانات §9) داخل نفس المعاملة مع تغيير الحالة.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import type { SourcePeerType } from './gateway.js';

export type SourceStatus = 'active' | 'paused';

export interface TelegramSourceRecord {
  id: string;
  userId: string;
  accountId: string;
  peerType: SourcePeerType;
  peerId: string;
  title: string;
  username: string | null;
  status: SourceStatus;
  includeOwnMessages: boolean;
  monitoringStartedAt: Date | null;
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
}

export interface TelegramSourceListRow extends TelegramSourceRecord {
  accountLabel: string;
  accountStatus: string;
}

export interface TelegramSourceStore {
  listByUser(userId: string): Promise<TelegramSourceListRow[]>;
  findOwned(sourceId: string, userId: string): Promise<TelegramSourceRecord | null>;
  findByPeer(
    userId: string,
    peerType: SourcePeerType,
    peerId: string,
  ): Promise<{ id: string; status: SourceStatus; accountId: string } | null>;
  countByAccount(accountId: string): Promise<number>;
  insert(input: {
    userId: string;
    accountId: string;
    peerType: SourcePeerType;
    peerId: string;
    title: string;
    username: string | null;
  }): Promise<TelegramSourceRecord>;
  setStatus(sourceId: string, status: SourceStatus, reason: string): Promise<void>;
  setIncludeOwnMessages(sourceId: string, value: boolean): Promise<void>;
  /** يحدّث بيانات الاسم/العنوان بعد تحقق ناجح، أو يسجّل رمز خطأ الوصول. */
  recordVerification(input: {
    sourceId: string;
    title: string;
    username: string | null;
    errorCode: string | null;
  }): Promise<void>;
  delete(sourceId: string): Promise<void>;
  /**
   * إيقاف كل مصادر الحساب النشطة وإغلاق فتراتها في عملية واحدة.
   * يقبل منفّذاً ليعمل داخل معاملة فصل الحساب (ذرّية كاملة).
   */
  pauseForAccount(accountId: string, reason: string, client?: PoolClient | null): Promise<number>;
}

interface Row {
  id: string;
  user_id: string;
  account_id: string;
  peer_type: SourcePeerType;
  peer_id: string;
  title: string;
  username: string | null;
  status: SourceStatus;
  include_own_messages: boolean;
  monitoring_started_at: Date | null;
  last_verified_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  account_label?: string;
  account_status?: string;
}

function toRecord(row: Row): TelegramSourceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    peerType: row.peer_type,
    peerId: row.peer_id,
    title: row.title,
    username: row.username,
    status: row.status,
    includeOwnMessages: row.include_own_messages,
    monitoringStartedAt: row.monitoring_started_at,
    lastVerifiedAt: row.last_verified_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
  };
}

const COLUMNS = `s.id, s.user_id, s.account_id, s.peer_type, s.peer_id::text as peer_id, s.title, s.username,
                 s.status, s.include_own_messages, s.monitoring_started_at, s.last_verified_at,
                 s.last_error_code, s.created_at`;

export class PgTelegramSourceStore implements TelegramSourceStore {
  async listByUser(userId: string): Promise<TelegramSourceListRow[]> {
    const res = await query<Row>(
      `select ${COLUMNS}, a.label as account_label, a.status::text as account_status
         from telegram_sources s
         join telegram_accounts a on a.id = s.account_id
        where s.user_id = $1
        order by s.created_at desc`,
      [userId],
    );
    return res.rows.map((row) => ({
      ...toRecord(row),
      accountLabel: row.account_label ?? '',
      accountStatus: row.account_status ?? 'unknown',
    }));
  }

  async findOwned(sourceId: string, userId: string): Promise<TelegramSourceRecord | null> {
    const res = await query<Row>(`select ${COLUMNS} from telegram_sources s where s.id = $1 and s.user_id = $2`, [
      sourceId,
      userId,
    ]);
    const row = res.rows[0];
    return row ? toRecord(row) : null;
  }

  async findByPeer(userId: string, peerType: SourcePeerType, peerId: string) {
    const res = await query<{ id: string; status: SourceStatus; account_id: string }>(
      `select id, status, account_id from telegram_sources
        where user_id = $1 and peer_type = $2 and peer_id = $3`,
      [userId, peerType, peerId],
    );
    const row = res.rows[0];
    return row ? { id: row.id, status: row.status, accountId: row.account_id } : null;
  }

  async countByAccount(accountId: string): Promise<number> {
    const res = await query<{ c: number }>(
      'select count(*)::int as c from telegram_sources where account_id = $1',
      [accountId],
    );
    return res.rows[0]?.c ?? 0;
  }

  async insert(input: {
    userId: string;
    accountId: string;
    peerType: SourcePeerType;
    peerId: string;
    title: string;
    username: string | null;
  }): Promise<TelegramSourceRecord> {
    return withTransaction(async (client) => {
      const res = await client.query<Row>(
        `insert into telegram_sources
           (user_id, account_id, peer_type, peer_id, title, username, status, monitoring_started_at)
         values ($1, $2, $3, $4::bigint, $5, $6, 'active', now())
         returning id, user_id, account_id, peer_type, peer_id::text as peer_id, title, username, status,
                   include_own_messages, monitoring_started_at, last_verified_at, last_error_code, created_at`,
        [input.userId, input.accountId, input.peerType, input.peerId, input.title, input.username],
      );
      const row = res.rows[0]!;
      await client.query(
        `insert into telegram_source_periods (source_id, reason) values ($1, 'activated')`,
        [row.id],
      );
      return toRecord(row);
    });
  }

  async setStatus(sourceId: string, status: SourceStatus, reason: string): Promise<void> {
    await withTransaction(async (client) => {
      const current = await client.query<{ status: SourceStatus }>(
        'select status from telegram_sources where id = $1 for update',
        [sourceId],
      );
      const previous = current.rows[0]?.status;
      if (!previous || previous === status) return;
      await client.query(
        `update telegram_sources
            set status = $2::telegram_source_status,
                monitoring_started_at = coalesce(monitoring_started_at, now()),
                last_error_code = case when $2::text = 'paused' then last_error_code else null end
          where id = $1`,
        [sourceId, status],
      );
      if (status === 'paused') {
        await client.query(
          `update telegram_source_periods set ended_at = now(), reason = coalesce(reason, $2::text)
            where source_id = $1 and ended_at is null`,
          [sourceId, reason],
        );
      } else {
        await client.query(`insert into telegram_source_periods (source_id, reason) values ($1, $2::text)`, [
          sourceId,
          reason,
        ]);
      }
    });
  }

  async setIncludeOwnMessages(sourceId: string, value: boolean): Promise<void> {
    await query('update telegram_sources set include_own_messages = $2 where id = $1', [sourceId, value]);
  }

  async recordVerification(input: {
    sourceId: string;
    title: string;
    username: string | null;
    errorCode: string | null;
  }): Promise<void> {
    await query(
      `update telegram_sources
          set title = $2, username = $3, last_verified_at = now(), last_error_code = $4
        where id = $1`,
      [input.sourceId, input.title, input.username, input.errorCode],
    );
  }

  async delete(sourceId: string): Promise<void> {
    await query('delete from telegram_sources where id = $1', [sourceId]);
  }

  async pauseForAccount(
    accountId: string,
    reason: string,
    client: PoolClient | null = null,
  ): Promise<number> {
    if (client) return pauseForAccountWith(client, accountId, reason);
    return withTransaction((tx) => pauseForAccountWith(tx, accountId, reason));
  }
}

/**
 * إيقاف مصادر الحساب وإغلاق فتراتها داخل منفّذ واحد:
 * 1) تُغلق الفترات المفتوحة لمصادر الحساب النشطة (قبل تغيير الحالة حتى يلتقطها الشرط).
 * 2) تُحدَّث حالة المصادر النشطة إلى paused دفعة واحدة.
 * الترتيب والتنفيذ في معاملة واحدة يمنعان أي حالة جزئية (حساب مفصول ومصادر نشطة).
 */
async function pauseForAccountWith(
  client: PoolClient,
  accountId: string,
  reason: string,
): Promise<number> {
  await client.query(
    `update telegram_source_periods p
        set ended_at = now(), reason = coalesce(p.reason, $2::text)
      where p.ended_at is null
        and p.source_id in (
          select id from telegram_sources where account_id = $1 and status = 'active'
        )`,
    [accountId, reason],
  );
  const res = await client.query(
    `update telegram_sources set status = 'paused' where account_id = $1 and status = 'active'`,
    [accountId],
  );
  return res.rowCount ?? 0;
}
