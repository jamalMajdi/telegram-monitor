/**
 * مخزن الالتقاط (الخطوة الرابعة): هوية الرسائل ومؤشرات المصادر.
 *
 * المبادئ:
 * - لا يُخزَّن أي نص رسالة ولا وسيط ولا تاريخ محادثة (D06/D07 وقرارات الخطوة الرابعة).
 * - منع التكرار بقيد فريد + `ON CONFLICT DO NOTHING RETURNING` فلا تفشل المعاملة عند التكرار المتزامن.
 * - إدراج الهوية وتحديث عدّاد المصدر في **معاملة واحدة**: لا عدّاد بلا هوية ولا هوية بلا عدّاد.
 * - كل استعلام مقيّد بالمالك، والملكية مفروضة أيضاً بمفاتيح أجنبية مركّبة في قاعدة البيانات.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import type { IncomingSender, SourcePeerType } from './gateway.js';

export interface MonitoredSourceRow {
  id: string;
  userId: string;
  accountId: string;
  peerType: SourcePeerType;
  peerId: string;
  title: string;
  status: 'active' | 'paused';
  includeOwnMessages: boolean;
}

export interface IngestRecordResult {
  /** inserted = التقاط جديد، duplicate = هوية موجودة مسبقاً. */
  outcome: 'inserted' | 'duplicate';
  sourceId: string;
  /** معرّف صف الهوية للرسالة الجديدة (null عند التكرار) — يستخدمه خط المعالجة (5-ب). */
  identityId: string | null;
  /**
   * عدد الصفوف القديمة التي أُكملت بيانات مرسلها في هذه العملية.
   * الرسائل التي وصلت قبل توفّر الاسم تحمل `sender_id` بلا اسم؛ وعند معرفة الاسم لاحقاً
   * لنفس المرسل تُكمَل صفوفه السابقة تلقائياً (إصلاح ذاتي بلا تدخّل يدوي).
   */
  repairedSenders?: number;
}

export interface SourceIngestStats {
  sourceId: string;
  title: string;
  /** اسم مستخدم عام للعرض فقط — لا يُستخدم كهوية ولا يُخزَّن نص. */
  username: string | null;
  peerType: SourcePeerType;
  peerId: string;
  status: 'active' | 'paused';
  accountId: string;
  accountLabel: string;
  accountStatus: string;
  lastMessageAt: Date | null;
  ingestedCount: string;
  duplicateCount: string;
  excludedCount: string;
  /** عدّادات المعالجة (5-ب، Q14): مطابقة / متجاهلة / مكرّرة المحتوى / فاشلة. */
  matchedCount: string;
  ignoredCount: string;
  repeatCount: string;
  failedCount: string;
  /** عدد الرسائل التي أكملت الاستخراج (5-ج). */
  extractedCount: string;
  /** عدد الرسائل التي صنُّفت واختير لها قالب (6-أ/6-ب). */
  classifiedCount: string;
  lastErrorCode: string | null;
}

export interface IngestStore {
  /** يبحث عن مصدر مراقَب لنفس المالك وهذا الحساب بالمعرّف الرقمي للند. */
  findMonitoredSource(input: { userId: string; accountId: string; peerId: string }): Promise<MonitoredSourceRow | null>;
  /** يسجّل الهوية ويحدّث عدّاد المصدر في معاملة واحدة. */
  recordMessage(input: {
    userId: string;
    accountId: string;
    source: MonitoredSourceRow;
    telegramMessageId: number;
    sentAt: Date;
    /** هوية المرسل كما وصلت من MTProto (تُخزَّن مع الهوية للاستخدام في المنشور). */
    sender?: IncomingSender | null;
  }): Promise<IngestRecordResult>;
  /** يزيد عدّاد الاستبعاد المتعمّد (رسالة ذاتية أو مصدر موقوف). */
  recordExcluded(sourceId: string): Promise<void>;
  /** يسجّل فشلاً في حفظ الهوية على المصدر (تشخيص للمستخدم). */
  recordFailure(input: { sourceId: string; code: string }): Promise<void>;
  /** إحصاءات الالتقاط لمستخدم واحد. */
  statsForUser(userId: string): Promise<SourceIngestStats[]>;
  /** إحصاءات مصدر واحد (مقيّدة بالمالك). */
  statsForSource(input: { userId: string; sourceId: string }): Promise<SourceIngestStats | null>;
  /** حذف هويات تجاوزت مدة الاحتفاظ؛ يعيد العدد المحذوف. */
  purgeIdentitiesOlderThan(days: number): Promise<number>;
}

interface SourceRow {
  id: string;
  user_id: string;
  account_id: string;
  peer_type: SourcePeerType;
  peer_id: string;
  title: string;
  status: 'active' | 'paused';
  include_own_messages: boolean;
}

const STATS_COLUMNS = `s.id as source_id, s.title, s.username, s.peer_type, s.peer_id::text as peer_id, s.status,
                       s.account_id, s.last_message_at, s.ingested_count::text as ingested_count,
                       s.duplicate_count::text as duplicate_count, s.excluded_count::text as excluded_count,
                       s.matched_count::text as matched_count, s.ignored_count::text as ignored_count,
                       s.repeat_count::text as repeat_count, s.failed_count::text as failed_count,
                       s.extracted_count::text as extracted_count,
                       s.classified_count::text as classified_count,
                       s.last_ingest_error_code`;

interface StatsRow {
  source_id: string;
  title: string;
  username: string | null;
  peer_type: SourcePeerType;
  peer_id: string;
  status: 'active' | 'paused';
  account_id: string;
  account_label: string;
  account_status: string;
  last_message_at: Date | null;
  ingested_count: string;
  duplicate_count: string;
  excluded_count: string;
  matched_count: string;
  ignored_count: string;
  repeat_count: string;
  failed_count: string;
  extracted_count: string;
  classified_count: string;
  last_ingest_error_code: string | null;
}

function toStats(row: StatsRow): SourceIngestStats {
  return {
    sourceId: row.source_id,
    title: row.title,
    username: row.username,
    peerType: row.peer_type,
    peerId: row.peer_id,
    status: row.status,
    accountId: row.account_id,
    accountLabel: row.account_label,
    accountStatus: row.account_status,
    lastMessageAt: row.last_message_at,
    ingestedCount: row.ingested_count,
    duplicateCount: row.duplicate_count,
    excludedCount: row.excluded_count,
    matchedCount: row.matched_count,
    ignoredCount: row.ignored_count,
    repeatCount: row.repeat_count,
    failedCount: row.failed_count,
    extractedCount: row.extracted_count,
    classifiedCount: row.classified_count,
    lastErrorCode: row.last_ingest_error_code,
  };
}

export class PgIngestStore implements IngestStore {
  async findMonitoredSource(input: {
    userId: string;
    accountId: string;
    peerId: string;
  }): Promise<MonitoredSourceRow | null> {
    // الهوية الرقمية للند (peer_id) هي المعيار؛ نوع المصدر تصنيف عرضي في الواجهة
    // (المجموعة العظمى تُصنَّف group بينما تحديثها يصل كـchannel)، فلا نُطابق عليه.
    const res = await query<SourceRow>(
      `select id, user_id, account_id, peer_type, peer_id::text as peer_id, title, status, include_own_messages
         from telegram_sources
        where user_id = $1 and account_id = $2 and peer_id = $3::bigint
        limit 1`,
      [input.userId, input.accountId, input.peerId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      accountId: row.account_id,
      peerType: row.peer_type,
      peerId: row.peer_id,
      title: row.title,
      status: row.status,
      includeOwnMessages: row.include_own_messages,
    };
  }

  async recordMessage(input: {
    userId: string;
    accountId: string;
    source: MonitoredSourceRow;
    telegramMessageId: number;
    sentAt: Date;
    sender?: IncomingSender | null;
  }): Promise<IngestRecordResult> {
    return withTransaction(async (client: PoolClient) => {
      const sender = input.sender ?? null;
      const inserted = await client.query<{ id: string }>(
        `insert into message_identity
           (user_id, source_id, account_id, peer_type, peer_id, telegram_message_id,
            sender_id, sender_username, sender_display_name, post_author)
         values ($1, $2, $3, $4, $5::bigint, $6::bigint,
                 $7::bigint, $8, $9, $10)
         on conflict (user_id, source_id, telegram_message_id) do nothing
         returning id`,
        [
          input.userId,
          input.source.id,
          input.accountId,
          input.source.peerType,
          input.source.peerId,
          input.telegramMessageId,
          sender?.id ?? null,
          sender?.username ?? null,
          sender?.displayName ?? null,
          sender?.postAuthor ?? null,
        ],
      );

      if (inserted.rowCount === 0) {
        // تكرار: لا استثناء ولا معاملة فاشلة، وعدّاد مستقل.
        await client.query(
          'update telegram_sources set duplicate_count = duplicate_count + 1 where id = $1',
          [input.source.id],
        );
        return { outcome: 'duplicate' as const, sourceId: input.source.id, identityId: null };
      }

      // إصلاح ذاتي: إن عُرف اسم المرسل/@username الآن، تُكمَل صفوفه السابقة الناقصة على نفس المصدر.
      let repairedSenders = 0;
      if (sender?.id && (sender.username || sender.displayName)) {
        const repaired = await client.query(
          `update message_identity
              set sender_username = coalesce(sender_username, $4),
                  sender_display_name = coalesce(sender_display_name, $5)
            where user_id = $1 and source_id = $2 and sender_id = $3::bigint
              and (sender_username is null or sender_display_name is null)`,
          [input.userId, input.source.id, sender.id, sender.username ?? null, sender.displayName ?? null],
        );
        repairedSenders = repaired.rowCount ?? 0;
      }

      // نجاح: العدّاد في نفس المعاملة، وآخر رسالة لا تتراجع للخلف أبداً.
      // رمز خطأ سابق يُمحى هنا: إبقاؤه يعني مؤشراً يقول «فشل» بعد أن نجح الالتقاط فعلاً.
      await client.query(
        `update telegram_sources
            set ingested_count = ingested_count + 1,
                last_message_at = greatest(coalesce(last_message_at, to_timestamp(0)), $2::timestamptz),
                last_ingest_error_code = null
          where id = $1`,
        [input.source.id, input.sentAt],
      );
      return {
        outcome: 'inserted' as const,
        sourceId: input.source.id,
        identityId: inserted.rows[0]!.id,
        repairedSenders,
      };
    });
  }

  async recordExcluded(sourceId: string): Promise<void> {
    await query('update telegram_sources set excluded_count = excluded_count + 1 where id = $1', [sourceId]);
  }

  async recordFailure(input: { sourceId: string; code: string }): Promise<void> {
    await query('update telegram_sources set last_ingest_error_code = $2 where id = $1', [
      input.sourceId,
      input.code.slice(0, 64),
    ]);
  }

  async statsForUser(userId: string): Promise<SourceIngestStats[]> {
    const res = await query<StatsRow>(
      `select ${STATS_COLUMNS}, a.label as account_label, a.status::text as account_status
         from telegram_sources s
         join telegram_accounts a on a.id = s.account_id
        where s.user_id = $1
        order by s.created_at desc`,
      [userId],
    );
    return res.rows.map(toStats);
  }

  async statsForSource(input: { userId: string; sourceId: string }): Promise<SourceIngestStats | null> {
    const res = await query<StatsRow>(
      `select ${STATS_COLUMNS}, a.label as account_label, a.status::text as account_status
         from telegram_sources s
         join telegram_accounts a on a.id = s.account_id
        where s.user_id = $1 and s.id = $2`,
      [input.userId, input.sourceId],
    );
    const row = res.rows[0];
    return row ? toStats(row) : null;
  }

  async purgeIdentitiesOlderThan(days: number): Promise<number> {
    const res = await query(
      `delete from message_identity where first_seen_at < now() - make_interval(days => $1::int)`,
      [days],
    );
    return res.rowCount ?? 0;
  }
}
