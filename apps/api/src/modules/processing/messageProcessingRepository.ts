/**
 * مخزن معالجة الرسائل (الخطوة 5-ب): حالة المعالجة على صف الهوية، محتوى الرسائل المطابقة،
 * ونتائج المطابقة. كل كتابة تُحدِّث عدّادات المصدر في **نفس المعاملة** (Q14).
 *
 * المبادئ المنفَّذة:
 * - لا يُخزَّن محتوى إلا للرسائل المطابقة (F04/Q1)، وبنفس النص الأصلي (D04).
 * - `retention_expires_at` يُحسب من وقت أول حفظ ولا يتغيّر لاحقاً (O06/D09).
 * - الحذف عند انتهاء المدة يمسّ المحتوى والنتائج فقط، ويبقي الهوية وبصمة المحتوى (Q12).
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';

export type MessageState = 'matched' | 'ignored' | 'processed' | 'failed';
export type IgnoreReason =
  | 'too_long'
  | 'no_text'
  | 'no_filter'
  | 'no_source_filter'
  | 'self_message'
  | 'paused_source'
  | 'processing_disabled';

export interface MatchEvidence {
  conditionId: string;
  mode: 'all' | 'any';
  negate: boolean;
  count: number;
  matchedTerms: string[];
}

export interface MatchRow {
  filterId: string;
  filterName: string;
  priority: number;
  evidence: MatchEvidence[];
}

export interface ContentRow {
  text: string;
  caption: string;
  textLength: number;
  captionLength: number;
  contentHash: string;
}

export interface ProcessingStore {
  /** مدة الاحتفاظ بالمحتوى بالساعات من إعدادات المستخدم (1..2160، افتراضياً 48). */
  contentRetentionHours(userId: string): Promise<number>;
  /** يسجّل التجاهل: الحالة + السبب + عدّاد المصدر. */
  markIgnored(input: {
    identityId: string;
    sourceId: string;
    reason: IgnoreReason;
    contentHash?: string | null;
    normalizationVersion: number;
  }): Promise<void>;
  /** فشل المعالجة (لا يوقف نقطة الاستئناف — Q4). */
  markFailed(input: { identityId: string; sourceId: string; code: string }): Promise<void>;
  /** هل يوجد محتوى بالبصمة نفسها لهذا المستخدم في رسالة أخرى داخل نافذة الاحتفاظ؟ (Q6) */
  isRepeatContent(input: { userId: string; identityId: string; contentHash: string }): Promise<boolean>;
  /** حفظ المحتوى والنتائج والعدّادات في معاملة واحدة. */
  saveMatch(input: {
    userId: string;
    identityId: string;
    sourceId: string;
    content: ContentRow;
    matches: MatchRow[];
    processingVersion: string;
    normalizationVersion: number;
    isRepeat: boolean;
    retentionHours: number;
  }): Promise<void>;
  /** يحذف المحتوى والنتائج المنتهية ويبقي الهوية والبصمة؛ يعيد العدد. */
  purgeExpiredContent(): Promise<number>;
}

export class PgMessageProcessingStore implements ProcessingStore {
  async contentRetentionHours(userId: string): Promise<number> {
    const res = await query<{ content_retention_hours: number }>(
      'select content_retention_hours from user_settings where user_id = $1',
      [userId],
    );
    const hours = res.rows[0]?.content_retention_hours;
    // الحدود مفروضة في المخطط أيضاً؛ التقييد هنا دفاع إضافي.
    return typeof hours === 'number' && hours >= 1 && hours <= 2160 ? hours : 48;
  }

  async markIgnored(input: {
    identityId: string;
    sourceId: string;
    reason: IgnoreReason;
    contentHash?: string | null;
    normalizationVersion: number;
  }): Promise<void> {
    await withTransaction(async (client: PoolClient) => {
      await client.query(
        `update message_identity
            set state = 'ignored',
                ignore_reason = $2::message_ignore_reason,
                content_hash = coalesce($3, content_hash),
                normalization_version = $4,
                attempts = attempts + 1,
                processed_at = now()
          where id = $1`,
        [input.identityId, input.reason, input.contentHash ?? null, input.normalizationVersion],
      );
      await client.query('update telegram_sources set ignored_count = ignored_count + 1 where id = $1', [
        input.sourceId,
      ]);
    });
  }

  async markFailed(input: { identityId: string; sourceId: string; code: string }): Promise<void> {
    await withTransaction(async (client: PoolClient) => {
      await client.query(
        `update message_identity
            set state = 'failed',
                ignore_reason = null,
                processing_error_code = $2,
                attempts = attempts + 1,
                processed_at = now()
          where id = $1`,
        [input.identityId, input.code.slice(0, 64)],
      );
      await client.query(
        `update telegram_sources
            set failed_count = failed_count + 1,
                last_ingest_error_code = $2
          where id = $1`,
        [input.sourceId, input.code.slice(0, 64)],
      );
    });
  }

  async isRepeatContent(input: { userId: string; identityId: string; contentHash: string }): Promise<boolean> {
    const res = await query<{ exists: boolean }>(
      `select exists (
         select 1 from message_identity
          where user_id = $1 and content_hash = $2 and id <> $3
            and first_seen_at > now() - make_interval(days => 30)
       ) as exists`,
      [input.userId, input.contentHash, input.identityId],
    );
    return res.rows[0]?.exists ?? false;
  }

  async saveMatch(input: {
    userId: string;
    identityId: string;
    sourceId: string;
    content: ContentRow;
    matches: MatchRow[];
    processingVersion: string;
    normalizationVersion: number;
    isRepeat: boolean;
    retentionHours: number;
  }): Promise<void> {
    await withTransaction(async (client: PoolClient) => {
      // المحتوى: أول حفظ فقط يحسب وقت الانتهاء؛ إعادة المحاولة لا تمدّد الاحتفاظ (O06).
      await client.query(
        `insert into message_content
           (identity_id, message_text, caption, text_length, caption_length, content_hash, retention_expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7::int))
         on conflict (identity_id) do nothing`,
        [
          input.identityId,
          input.content.text || null,
          input.content.caption || null,
          input.content.textLength,
          input.content.captionLength,
          input.content.contentHash,
          input.retentionHours,
        ],
      );

      for (const match of input.matches) {
        await client.query(
          `insert into message_matches
             (identity_id, filter_id, filter_name, priority, evidence, processing_version)
           values ($1, $2, $3, $4, $5::jsonb, $6::bigint)
           on conflict (identity_id, filter_id) do nothing`,
          [
            input.identityId,
            match.filterId,
            match.filterName,
            match.priority,
            JSON.stringify(match.evidence),
            input.processingVersion,
          ],
        );
      }

      await client.query(
        `update message_identity
            set state = 'matched',
                ignore_reason = null,
                matched_count = $2,
                content_hash = $3,
                is_repeat = $4,
                processing_version = $5::bigint,
                normalization_version = $6,
                attempts = attempts + 1,
                processing_error_code = null,
                processed_at = now()
          where id = $1`,
        [
          input.identityId,
          input.matches.length,
          input.content.contentHash,
          input.isRepeat,
          input.processingVersion,
          input.normalizationVersion,
        ],
      );

      await client.query(
        `update telegram_sources
            set matched_count = matched_count + 1,
                repeat_count = repeat_count + $2::int,
                last_ingest_error_code = null
          where id = $1`,
        [input.sourceId, input.isRepeat ? 1 : 0],
      );
    });
  }

  async purgeExpiredContent(): Promise<number> {
    return withTransaction(async (client: PoolClient) => {
      const expired = await client.query<{ identity_id: string }>(
        `delete from message_content
          where retention_expires_at < now()
          returning identity_id`,
      );
      const ids = expired.rows.map((row) => row.identity_id);
      if (ids.length === 0) return 0;
      await client.query('delete from message_matches where identity_id = any($1::uuid[])', [ids]);
      // نتائج الاستخراج وفئات التواصل «نتائج» لا محتوى مصدر: تُحذف مع المحتوى (Q12).
      await client.query('delete from message_extraction where identity_id = any($1::uuid[])', [ids]);
      await client.query('delete from message_contacts where identity_id = any($1::uuid[])', [ids]);
      // التصنيف واختيار القالب «نتائج» أيضاً (Q12) — تُحذف مع المحتوى.
      await client.query('delete from message_classification where identity_id = any($1::uuid[])', [ids]);
      await client.query('delete from message_template_resolution where identity_id = any($1::uuid[])', [ids]);
      await client.query(
        // matched_count تاريخي ولا يُصفَّر: صفوف message_matches هي التي تُحذف (Q12).
        `update message_identity
            set content_purged_at = now()
          where id = any($1::uuid[])`,
        [ids],
      );
      return ids.length;
    });
  }
}
