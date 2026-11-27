/**
 * مستودع الاحتفاظ والحذف (P4-د، §14، Q21/Q22/Q23).
 *
 * كل عملية حذف هنا **محصورة بمالك** أو **بسياسة زمنية معلنة**، وتُعيد أعداداً صريحة
 * (تقرير أثر) حتى يُسجَّل ما حُذف فعلاً لا ما نُوي حذفه.
 */
import { query, withTransaction } from '../../db/pool.js';

export type RetentionPolicy =
  | 'content'
  | 'identities'
  | 'deliveries'
  | 'error_events'
  | 'audit_events';
export type RetentionTrigger = 'scheduler' | 'admin' | 'user';

export interface RetentionRunRow {
  id: number;
  policy: string;
  triggeredBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  deleted: number;
  errorCode: string | null;
}

/** تسليمات لا يجوز حذفها بالتنظيف: ما زالت في الطريق أو تنتظر قراراً بشرياً. */
const LIVE_DELIVERY_STATUSES = `('awaiting_review', 'queued', 'sending')`;

/** تقرير أثر الحذف: أعداد الصفوف المحذوفة لكل جدول، بلا أي محتوى. */
export interface PurgeReport {
  deliveries: number;
  deliveryParts: number;
  deliveryAttempts: number;
  deliveryEvidence: number;
  messageIdentities: number;
  messageContent: number;
  messageMatches: number;
  messageExtraction: number;
  messageClassification: number;
  errorEvents: number;
}

export interface UserPurgeResult {
  report: PurgeReport;
  total: number;
}

export class PgRetentionStore {
  // ── تشغيل السياسات ───────────────────────────────────────────────────────
  async startRun(policy: RetentionPolicy, triggeredBy: RetentionTrigger): Promise<number> {
    const res = await query<{ id: string }>(
      `insert into retention_runs (policy, triggered_by) values ($1, $2) returning id`,
      [policy, triggeredBy],
    );
    return Number(res.rows[0]!.id);
  }

  async finishRun(id: number, deleted: number, errorCode: string | null): Promise<void> {
    await query(
      `update retention_runs
          set finished_at = now(), deleted = $2, error_code = $3
        where id = $1`,
      [id, Math.max(0, deleted), errorCode],
    );
  }

  async listRuns(limit: number): Promise<RetentionRunRow[]> {
    const res = await query<{
      id: string;
      policy: string;
      triggered_by: string;
      started_at: Date;
      finished_at: Date | null;
      deleted: number;
      error_code: string | null;
    }>(
      `select id, policy, triggered_by, started_at, finished_at, deleted, error_code
         from retention_runs
        order by id desc
        limit $1`,
      [limit],
    );
    return res.rows.map((row) => ({
      id: Number(row.id),
      policy: row.policy,
      triggeredBy: row.triggered_by,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      deleted: Number(row.deleted),
      errorCode: row.error_code,
    }));
  }

  /**
   * قراءة سياسة نظام بالأيام بأمان: القيمة تُخزَّن ككائن `{ "days": n }` (قيد `system_settings`
   * يفرض أن تكون القيمة كائناً)، وأي شكل آخر يعني الافتراضي لا التخمين.
   */
  async systemDays(key: string, fallback: number): Promise<number> {
    const res = await query<{ value: unknown }>('select value from system_settings where key = $1', [key]);
    const raw = res.rows[0]?.value;
    const candidate =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { days?: unknown }).days : raw;
    const parsed = typeof candidate === 'number' ? candidate : typeof candidate === 'string' ? Number(candidate) : NaN;
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3650) return fallback;
    return Math.trunc(parsed);
  }

  /**
   * حذف التسليمات المنتهية لكل مستخدم بحسب `user_settings.delivery_retention_days`.
   * لا يُحذف تسليم حيّ (مراجعة/طابور/إرسال) مهما طال عمره.
   */
  async purgeExpiredDeliveries(): Promise<number> {
    const res = await query<{ total: number }>(
      `with candidates as (
         select d.id
           from deliveries d
           join user_settings s on s.user_id = d.user_id
          where d.status::text not in ${LIVE_DELIVERY_STATUSES}
            and d.created_at < now() - make_interval(days => s.delivery_retention_days)
       ), removed as (
         delete from deliveries where id in (select id from candidates) returning 1
       )
       select count(*)::int as total from removed`,
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  async purgeErrorEvents(days: number): Promise<number> {
    const res = await query<{ total: number }>(
      `with removed as (
         delete from error_events
          where occurred_at < now() - make_interval(days => $1::int)
          returning 1
       )
       select count(*)::int as total from removed`,
      [days],
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  async purgeAuditEvents(days: number): Promise<number> {
    const res = await query<{ total: number }>(
      `with removed as (
         delete from audit_events
          where occurred_at < now() - make_interval(days => $1::int)
          returning 1
       )
       select count(*)::int as total from removed`,
      [days],
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  // ── الحذف اليدوي (Q21) ───────────────────────────────────────────────────
  /**
   * «حذف بياناتي التشغيلية الآن»: المحتوى والاستخراج والتصنيف والمطابقات والتسليمات
   * وأجزاؤها ومحاولاتها وأدلتها **فقط**. لا يمسّ الإعدادات ولا الجلسات ولا الحسابات
   * ولا المصادر ولا الفلاتر ولا سجل التدقيق.
   */
  async purgeOperationalData(userId: string): Promise<UserPurgeResult> {
    return withTransaction((client) => this.purgeOperationalDataInTx(client, userId));
  }

  /**
   * الحذف النهائي للحساب (Q22): صف المستخدم يُحذف فيسقط معه كل ما يخصه بالتسلسل
   * (حسابات تيليجرام وجلساتها وأسرارها، البوتات، المصادر، القواعد، القوالب، الوجهات،
   * المسارات، التسليمات، الهويات، الإعدادات، جلسات الويب)، **في معاملة واحدة**.
   * وسجل التدقيق يبقى مجهول الهوية لأن `actor_user_id` مضبوط على `on delete set null` (0003).
   */
  async hardDeleteAccount(userId: string): Promise<{ deleted: boolean; report: PurgeReport }> {
    return withTransaction(async (client) => {
      const purge = await this.purgeOperationalDataInTx(client, userId);
      const removed = await client.query('delete from users where id = $1', [userId]);
      return { deleted: (removed.rowCount ?? 0) > 0, report: purge.report };
    });
  }

  /** منطق الحذف التشغيلي داخل معاملة يملكها المستدعي (بلا معاملة متداخلة). */
  private async purgeOperationalDataInTx(
    client: import('pg').PoolClient,
    userId: string,
  ): Promise<UserPurgeResult> {
    const count = async (sql: string, params: unknown[]): Promise<number> => {
      const res = await client.query<{ total: number }>(sql, params);
      return Number(res.rows[0]?.total ?? 0);
    };

    // 1) تُعدّ الصفوف قبل الحذف لتقرير أثر صادق (لا نُبلّغ عن حذف لم يحدث).
    const counts = await client.query<{
      deliveries: number;
      parts: number;
      attempts: number;
      evidence: number;
    }>(
      `select
         (select count(*)::int from deliveries where user_id = $1) as deliveries,
         (select count(*)::int from delivery_parts p join deliveries d on d.id = p.delivery_id where d.user_id = $1) as parts,
         (select count(*)::int from delivery_attempts a join deliveries d on d.id = a.delivery_id where d.user_id = $1) as attempts,
         (select count(*)::int from delivery_evidence e where e.user_id = $1) as evidence`,
      [userId],
    );

    const identities = await count('select count(*)::int as total from message_identity where user_id = $1', [userId]);
    const content = await count(
      `select count(*)::int as total
         from message_content c join message_identity i on i.id = c.identity_id
        where i.user_id = $1`,
      [userId],
    );
    const matches = await count(
      `select count(*)::int as total
         from message_matches m join message_identity i on i.id = m.identity_id
        where i.user_id = $1`,
      [userId],
    );
    const extraction = await count(
      `select count(*)::int as total
         from message_extraction x join message_identity i on i.id = x.identity_id
        where i.user_id = $1`,
      [userId],
    );
    const classification = await count(
      `select count(*)::int as total
         from message_classification k join message_identity i on i.id = k.identity_id
        where i.user_id = $1`,
      [userId],
    );
    const errors = await count('select count(*)::int as total from error_events where user_id = $1', [userId]);

    // 2) الحذف: التسليمات أولاً (أجزاؤها ومحاولاتها وأدلتها تتبعها بالتسلسل)، ثم هويات الرسائل
    //    (المحتوى والاستخراج والتصنيف والمطابقات والتوجيه تتبعها بالتسلسل)، ثم أحداث الأخطاء.
    await client.query('delete from deliveries where user_id = $1', [userId]);
    await client.query('delete from message_identity where user_id = $1', [userId]);
    await client.query('delete from error_events where user_id = $1', [userId]);

    // 3) عدّادات المصادر المشتقة من المحتوى المحذوف تُصفَّر: رقم يبقى بلا صفوف خلفه كذب.
    //    (ignored/failed/repeat عدّادات صحة التقاط لا تُشتق من المحتوى، فتبقى كما هي.)
    await client.query(
      `update telegram_sources
          set matched_count = 0, classified_count = 0
        where user_id = $1`,
      [userId],
    );

    const d = counts.rows[0]!;
    const report: PurgeReport = {
      deliveries: Number(d.deliveries),
      deliveryParts: Number(d.parts),
      deliveryAttempts: Number(d.attempts),
      deliveryEvidence: Number(d.evidence),
      messageIdentities: identities,
      messageContent: content,
      messageMatches: matches,
      messageExtraction: extraction,
      messageClassification: classification,
      errorEvents: errors,
    };
    const total = Object.values(report).reduce((sum, value) => sum + value, 0);
    return { report, total };
  }
}
