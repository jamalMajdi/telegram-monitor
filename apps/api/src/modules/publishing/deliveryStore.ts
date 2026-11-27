/**
 * مخزن تنفيذ التسليم (الدفعة 7-د): استحواذ الأجزاء، محاولات الإرسال، الأدلة، وقرار المراجعة.
 *
 * مبادئ ملزمة:
 * - استحواذ مزدوج: قفل على الجزء **و** على التسليم بلُقية زمنية، فلا يرسل عاملان الجزء نفسه.
 * - المحاولة تُفتح في قاعدة البيانات **قبل** طلب HTTP (`openAttempt`)، وتُغلق بعده.
 * - لا يُخزَّن نص في `delivery_attempts` ولا أي رمز؛ نصوص الأجزاء محجوبة ومنسَّقة سلفاً.
 * - الحالة النهائية تُحسب من حالات الأجزاء لا من نيّة العامل.
 */
import { query, withTransaction } from '../../db/pool.js';
import type { DeliveryStatus } from './publishRepository.js';

export interface ClaimedPart {
  partId: string;
  deliveryId: string;
  partIndex: number;
  text: string;
  textHash: string;
  attemptNo: number;
  userId: string;
  destinationId: string;
  chatId: string;
  /** وقت إنشاء التسليم: أساس سقف الست ساعات (Q12). */
  createdAt: Date;
  deliveryAttempts: number;
}

export interface AttemptPatch {
  outcome: 'ok' | 'retryable' | 'permanent' | 'uncertain';
  httpStatus?: number | null;
  telegramErrorCode?: number | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  retryAfterSeconds?: number | null;
  durationMs?: number | null;
}

export interface DeliveryDetail {
  id: string;
  status: DeliveryStatus;
  review: string;
  reviewReason: string | null;
  planVersion: number;
  approvedVersion: number | null;
  chunkCount: number;
  attempts: number;
  lastErrorCode: string | null;
  nextAttemptAt: string | null;
  publishedAt: string | null;
  destinationTitle: string | null;
  /** إعادة النشر (Q20): العدد والسقف والقدرة المحسوبة. */
  republishCount: number;
  lastRepublishedAt: string | null;
  republish: { allowed: boolean; reason: string | null; remaining: number };
  parts: {
    id: string;
    partIndex: number;
    text: string;
    charCount: number;
    status: string;
    telegramMessageId: string | null;
    attempts: number;
    lastErrorCode: string | null;
  }[];
  evidence: { method: string; decision: string; telegramMessageId: string | null; note: string | null; decidedAt: string }[];
  attemptLog: {
    partIndex: number | null;
    attemptNo: number;
    outcome: string;
    httpStatus: number | null;
    errorCode: string | null;
    startedAt: string;
    finishedAt: string | null;
  }[];
}

export interface DeliveryStore {
  claimPart(owner: string, leaseMs: number, filter?: { userId?: string }): Promise<ClaimedPart | null>;
  recoverExpiredLeases(): Promise<number>;
  blockUnroutableDestinations(): Promise<number>;
  openAttempt(input: { deliveryId: string; partId: string; attemptNo: number }): Promise<string | null>;
  closeAttempt(attemptId: string, patch: AttemptPatch): Promise<void>;
  markPartSent(input: { deliveryId: string; partId: string; telegramMessageId: string }): Promise<void>;
  markPartStopped(input: {
    deliveryId: string;
    partId: string;
    status: 'failed' | 'uncertain';
    errorCode: string;
  }): Promise<void>;
  scheduleRetry(input: { deliveryId: string; partId: string; nextAttemptAt: Date; errorCode: string }): Promise<void>;
  releaseLeases(input: { deliveryId: string; partId: string | null }): Promise<void>;
  finalizeDelivery(deliveryId: string): Promise<DeliveryStatus | null>;
  review(
    deliveryId: string,
    userId: string,
    decision: 'approve' | 'reject',
    input: { reason?: string | null },
  ): Promise<boolean>;
  recordEvidence(input: {
    deliveryId: string;
    userId: string;
    method: 'message_id' | 'manual_check';
    decision: 'published' | 'not_published';
    telegramMessageId?: string | null;
    note?: string | null;
  }): Promise<boolean>;
  detail(deliveryId: string, userId: string): Promise<DeliveryDetail | null>;
  /**
   * تهيئة إعادة التخطيط (Q20): تحقّق + صفّ الأجزاء + رفع العدّاد، في معاملة واحدة.
   * ترفض `uncertain` دائماً (لا إعادة قبل دليل بشري)، وترفض تجاوز السقف (3).
   */
  prepareRepublish(
    deliveryId: string,
    userId: string,
  ): Promise<{ ok: true; republishCount: number } | { ok: false; reason: RepublishRefusal }>;
}

/** أسباب رفض إعادة النشر: صريحة وحصرية، تصبح رسائل 409 في الواجهة. */
export type RepublishRefusal =
  | 'not_found'
  | 'uncertain_forbidden'
  | 'not_republishable'
  | 'limit_reached'
  | 'content_expired';

/** السقف المعلن لإعادة النشر (Q20) — مصدره واحد: هذه القيمة وقيد المخطط. */
export const REPUBLISH_LIMIT = 3;
const REPUBLISHABLE: ReadonlySet<string> = new Set(['failed', 'cancelled', 'blocked']);

/**
 * هل يمكن إعادة النشر لهذا التسليم الآن؟ القرار دالة نقية تُستخدم في العرض وفي التنفيذ معاً،
 * حتى لا تتناقض الواجهة مع الخادم.
 */
export function republishCapability(
  status: string,
  republishCount: number,
): { allowed: boolean; reason: string | null; remaining: number } {
  const remaining = Math.max(0, REPUBLISH_LIMIT - republishCount);
  // 1) القاعدة الحاكمة أولاً: المجهول لا يُعاد أبداً، ولو كان العدّاد صفراً.
  if (status === 'uncertain') {
    return { allowed: false, reason: 'uncertain_forbidden', remaining };
  }
  // 2) ثم السقف: «استُهلكت المحاولات» أدق من «الحالة لا تسمح» بعد ثلاث إعادات.
  if (remaining === 0) {
    return { allowed: false, reason: 'limit_reached', remaining };
  }
  if (!REPUBLISHABLE.has(status)) {
    return { allowed: false, reason: 'not_republishable', remaining };
  }
  return { allowed: true, reason: null, remaining };
}

const LEASE = `now() + ($2::int * interval '1 millisecond')`;

export class PgDeliveryStore implements DeliveryStore {
  async claimPart(owner: string, leaseMs: number, filter: { userId?: string } = {}): Promise<ClaimedPart | null> {
    const res = await query<{
      part_id: string;
      part_index: number;
      text: string;
      text_hash: string;
      attempt_no: number;
      user_id: string;
      destination_id: string;
      chat_id: string;
      delivery_id: string;
      created_at: Date;
      delivery_attempts: number;
    }>(
      `with candidate as (
         select p.id as part_id, p.delivery_id, d.created_at
           from delivery_parts p
           join deliveries d on d.id = p.delivery_id
           join destinations dest on dest.id = d.destination_id and dest.user_id = d.user_id
          where p.status = 'pending'
            and d.status in ('queued', 'sending')
            and dest.status = 'active'
            and (d.next_attempt_at is null or d.next_attempt_at <= now())
            and (d.lease_expires_at is null or d.lease_expires_at <= now())
            and (p.lease_expires_at is null or p.lease_expires_at <= now())
            -- لا إرسال قبل موافقة بشرية، ولا بعد إعادة تخطيط تُبطل الموافقة.
            and ($3::uuid is null or d.user_id = $3::uuid)
            and (d.review = 'not_required'
                 or (d.review = 'approved' and d.approved_version is not null and d.approved_version = d.plan_version))
          order by d.created_at, p.part_index
          limit 1
          for update of p, d skip locked
       ), part_claim as (
         update delivery_parts p
            set status = 'sending',
                lease_owner = $1,
                lease_expires_at = ${LEASE},
                attempts = p.attempts + 1,
                last_error_code = null
           from candidate c
          where p.id = c.part_id
          returning p.id, p.delivery_id, p.part_index, p.text, p.text_hash, p.attempts
       ), delivery_claim as (
         update deliveries d
            set status = 'sending',
                lease_owner = $1,
                lease_expires_at = ${LEASE},
                attempts = d.attempts + 1
           from part_claim pc
          where d.id = pc.delivery_id
          returning d.id, d.user_id, d.destination_id, d.created_at, d.attempts
       )
       select pc.id as part_id, pc.part_index, pc.text, pc.text_hash, pc.attempts as attempt_no,
              dc.user_id, dc.destination_id, dc.created_at, dc.attempts as delivery_attempts,
              dest.chat_id, pc.delivery_id
         from part_claim pc
         join delivery_claim dc on dc.id = pc.delivery_id
         join destinations dest on dest.id = dc.destination_id`,
      [owner, leaseMs, filter.userId ?? null],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      partId: row.part_id,
      deliveryId: row.delivery_id,
      partIndex: row.part_index,
      text: row.text,
      textHash: row.text_hash,
      attemptNo: row.attempt_no,
      userId: row.user_id,
      destinationId: row.destination_id,
      chatId: String(row.chat_id),
      createdAt: row.created_at,
      deliveryAttempts: Number(row.delivery_attempts),
    };
  }

  /**
   * استعادة اللُّقى المنتهية بلا إرسال مزدوج (تدقيق 2026-11-26).
   *
   * **الخلل الذي كان قائماً:** كل جزء حالته `sending` وانتهت لُقيته كان يُعاد `pending` مباشرة.
   * فلو أن عاملاً أرسل الجزء فعلاً إلى تيليجرام ثم سقط (نشرة/إعادة تشغيل/OOM) قبل تسجيل
   * `markPartSent`، لانتهت اللُّقية وعاد الجزء «معلّقاً» فأرسله عامل آخر ⇒ **منشور مكرر في القناة**.
   *
   * **القاعدة الآن (متسقة مع O04: المجهول لا يُعاد تلقائياً):**
   * - جزء **بدأت له محاولة** (`delivery_attempts.outcome = 'started'`) ⇒ الطلب قد يكون وصل:
   *   يُغلق `uncertain` (والبيعة كذلك) بانتظار دليل بشري، ولا يُعاد إرساله أبداً تلقائياً.
   *   نافذة الالتباس ضيّقة جداً لأن حفظ المحاولة يسبق طلب HTTP مباشرة.
   * - جزء **بلا أي محاولة** ⇒ لم يُرسَل شيء قطعاً: يعود `pending` بأمان (استعادة سريعة).
   * - محاولة معلّقة تُغلق `uncertain` مع رمز `lease_expired_unknown` ليكتمل الخط الزمني.
   */
  async recoverExpiredLeases(): Promise<number> {
    return withTransaction(async (client) => {
      const expired = await client.query<{ part_id: string; delivery_id: string; has_open_attempt: boolean }>(
        `select p.id as part_id, p.delivery_id,
                exists (
                  select 1 from delivery_attempts a
                   where a.part_id = p.id and a.outcome = 'started'
                ) as has_open_attempt
           from delivery_parts p
          where p.status = 'sending' and p.lease_expires_at is not null and p.lease_expires_at <= now()
          for update of p`,
      );
      if (expired.rowCount === 0) return 0;

      const unknownParts = expired.rows.filter((row) => row.has_open_attempt).map((row) => row.part_id);
      const safeParts = expired.rows.filter((row) => !row.has_open_attempt).map((row) => row.part_id);
      const unknownDeliveries = [...new Set(expired.rows.filter((row) => row.has_open_attempt).map((row) => row.delivery_id))];

      if (unknownParts.length > 0) {
        // 1) إغلاق المحاولات المعلّقة بدل تركها 'started' إلى الأبد.
        await client.query(
          `update delivery_attempts
              set outcome = 'uncertain', finished_at = now(), error_code = 'lease_expired_unknown'
            where part_id = any($1::uuid[]) and outcome = 'started'`,
          [unknownParts],
        );
        // 2) الأجزاء تُغلق uncertain ولا تعود إلى الطابور.
        await client.query(
          `update delivery_parts
              set status = 'uncertain', last_error_code = 'lease_expired_unknown',
                  lease_owner = null, lease_expires_at = null
            where id = any($1::uuid[])`,
          [unknownParts],
        );
        // 3) التسليمات likewise: نتيجة مجهولة تحتاج دليلاً بشرياً.
        await client.query(
          `update deliveries
              set status = 'uncertain', last_error_code = 'lease_expired_unknown',
                  lease_owner = null, lease_expires_at = null, next_attempt_at = null
            where id = any($1::uuid[]) and status in ('queued', 'sending')`,
          [unknownDeliveries],
        );
      }

      if (safeParts.length > 0) {
        await client.query(
          `update delivery_parts
              set status = 'pending', lease_owner = null, lease_expires_at = null
            where id = any($1::uuid[])`,
          [safeParts],
        );
      }

      // تسليمات بقيت `sending` بلا أجزاء معلّقة (سقط العامل قبل الاستحواذ على جزء) تعود للطابور.
      const deliveries = await client.query(
        `update deliveries d
            set status = 'queued', lease_owner = null, lease_expires_at = null
          where d.status = 'sending' and d.lease_expires_at is not null and d.lease_expires_at <= now()
            and not exists (select 1 from delivery_parts p where p.delivery_id = d.id and p.status in ('sent', 'uncertain'))
          returning d.id`,
      );

      return (expired.rowCount ?? 0) + (deliveries.rowCount ?? 0);
    });
  }

  /** تسليمات وجهتها لم تعد فعّالة: تُغلق `blocked` بلا إرسال. */
  async blockUnroutableDestinations(): Promise<number> {
    const res = await query(
      `update deliveries d
          set status = 'blocked', last_error_code = 'destination_inactive', lease_owner = null, lease_expires_at = null
         from destinations dest
        where dest.id = d.destination_id and dest.user_id = d.user_id
          and d.status in ('queued', 'sending')
          and dest.status <> 'active'
          and exists (select 1 from delivery_parts p where p.delivery_id = d.id and p.status = 'pending')`,
    );
    return res.rowCount ?? 0;
  }

  async openAttempt(input: { deliveryId: string; partId: string; attemptNo: number }): Promise<string | null> {
    const res = await query<{ id: string }>(
      `insert into delivery_attempts (delivery_id, part_id, attempt_no, outcome)
       values ($1, $2, $3, 'started')
       on conflict (delivery_id, part_id, attempt_no) do nothing
       returning id`,
      [input.deliveryId, input.partId, input.attemptNo],
    );
    return res.rows[0]?.id ?? null;
  }

  async closeAttempt(attemptId: string, patch: AttemptPatch): Promise<void> {
    await query(
      `update delivery_attempts
          set outcome = $2::delivery_attempt_outcome,
              finished_at = now(),
              http_status = $3,
              telegram_error_code = $4,
              error_code = $5,
              error_detail = $6,
              retry_after_seconds = $7,
              duration_ms = $8
        where id = $1`,
      [
        attemptId,
        patch.outcome,
        patch.httpStatus ?? null,
        patch.telegramErrorCode ?? null,
        patch.errorCode ?? null,
        patch.errorDetail ? patch.errorDetail.slice(0, 200) : null,
        patch.retryAfterSeconds ?? null,
        patch.durationMs ?? null,
      ],
    );
  }

  async markPartSent(input: { deliveryId: string; partId: string; telegramMessageId: string }): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `update delivery_parts
            set status = 'sent', telegram_message_id = $3::bigint, sent_at = now(),
                lease_owner = null, lease_expires_at = null, last_error_code = null
          where id = $1 and delivery_id = $2`,
        [input.partId, input.deliveryId, input.telegramMessageId],
      );
      await client.query(
        `update deliveries set lease_owner = null, lease_expires_at = null, next_attempt_at = null
          where id = $1`,
        [input.deliveryId],
      );
    });
  }

  async markPartStopped(input: {
    deliveryId: string;
    partId: string;
    status: 'failed' | 'uncertain';
    errorCode: string;
  }): Promise<void> {
    await query(
      `update delivery_parts
          set status = $3::delivery_part_status, last_error_code = $4,
              lease_owner = null, lease_expires_at = null
        where id = $1 and delivery_id = $2`,
      [input.partId, input.deliveryId, input.status, input.errorCode.slice(0, 64)],
    );
    await query(`update deliveries set lease_owner = null, lease_expires_at = null where id = $1`, [input.deliveryId]);
  }

  async scheduleRetry(input: {
    deliveryId: string;
    partId: string;
    nextAttemptAt: Date;
    errorCode: string;
  }): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `update delivery_parts
            set status = 'pending', last_error_code = $3, lease_owner = null, lease_expires_at = null
          where id = $1 and delivery_id = $2`,
        [input.partId, input.deliveryId, input.errorCode.slice(0, 64)],
      );
      await client.query(
        `update deliveries
            set status = 'queued', next_attempt_at = $2, last_error_code = $3,
                lease_owner = null, lease_expires_at = null
          where id = $1`,
        [input.deliveryId, input.nextAttemptAt.toISOString(), input.errorCode.slice(0, 64)],
      );
    });
  }

  async releaseLeases(input: { deliveryId: string; partId: string | null }): Promise<void> {
    await withTransaction(async (client) => {
      if (input.partId) {
        await client.query(
          `update delivery_parts set lease_owner = null, lease_expires_at = null
            where id = $1 and status <> 'sending'`,
          [input.partId],
        );
      }
      await client.query(`update deliveries set lease_owner = null, lease_expires_at = null where id = $1`, [
        input.deliveryId,
      ]);
    });
  }

  /** يحسب الحالة النهائية من الأجزاء. لا يمسّ التسليمات المعلّقة بانتظار عامل. */
  async finalizeDelivery(deliveryId: string): Promise<DeliveryStatus | null> {
    return withTransaction(async (client) => {
      const parts = await client.query<{ status: string; total: number }>(
        `select status::text as status, count(*)::int as total from delivery_parts where delivery_id = $1 group by status`,
        [deliveryId],
      );
      if (parts.rows.length === 0) return null;
      const counts = new Map(parts.rows.map((row) => [row.status, Number(row.total)]));
      const terminalError = await client.query<{ last_error_code: string | null }>(
        `select last_error_code from delivery_parts
          where delivery_id = $1 and status in ('failed', 'uncertain') and last_error_code is not null
          order by part_index limit 1`,
        [deliveryId],
      );
      const errorCode = terminalError.rows[0]?.last_error_code ?? null;
      const sent = counts.get('sent') ?? 0;
      const pending = (counts.get('pending') ?? 0) + (counts.get('sending') ?? 0);
      const uncertain = counts.get('uncertain') ?? 0;
      const total = [...counts.values()].reduce((sum, value) => sum + Number(value), 0);

      if (pending > 0) {
        // عمل متبقٍّ: يبقى التسليم في الطابور. لا يُمَس استحواذ عامل نشِط.
        await client.query(
          `update deliveries set status = 'queued'
            where id = $1 and status = 'sending'
              and (lease_expires_at is null or lease_expires_at <= now())`,
          [deliveryId],
        );
        return 'queued';
      }

      let status: DeliveryStatus;
      if (sent === total) {
        status = 'published';
      } else if (uncertain > 0) {
        status = 'uncertain'; // O04: لا إعادة تلقائية، تنتظر دليلاً بشرياً
      } else if (sent > 0) {
        status = 'partial';
      } else {
        status = 'failed';
      }

      const res = await client.query<{ status: string }>(
        `update deliveries
            set status = $2::delivery_status,
                published_at = case when $2::text = 'published' then coalesce(published_at, now()) else published_at end,
                last_error_code = case when $2::text = 'published' then null else coalesce($3, last_error_code) end,
                lease_owner = null, lease_expires_at = null
          where id = $1 and status <> 'blocked'
          returning status::text as status`,
        [deliveryId, status, errorCode],
      );
      return (res.rows[0]?.status as DeliveryStatus | undefined) ?? status;
    });
  }

  async review(
    deliveryId: string,
    userId: string,
    decision: 'approve' | 'reject',
    input: { reason?: string | null },
  ): Promise<boolean> {
    const res = await query(
      `update deliveries
          set status = case when $3 = 'approve' then 'queued'::delivery_status else 'cancelled'::delivery_status end,
              review = case when $3 = 'approve' then 'approved'::delivery_review else 'rejected'::delivery_review end,
              approved_by = case when $3 = 'approve' then $2::uuid else null end,
              approved_at = case when $3 = 'approve' then now() else null end,
              approved_version = case when $3 = 'approve' then plan_version else null end,
              rejected_reason = case when $3 = 'approve' then null else $4 end,
              last_error_code = null
        where id = $1 and user_id = $2
          and status = 'awaiting_review'
        returning id`,
      [deliveryId, userId, decision, input.reason ? input.reason.slice(0, 200) : null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async recordEvidence(input: {
    deliveryId: string;
    userId: string;
    method: 'message_id' | 'manual_check';
    decision: 'published' | 'not_published';
    telegramMessageId?: string | null;
    note?: string | null;
  }): Promise<boolean> {
    return withTransaction(async (client) => {
      const current = await client.query<{ status: string; chunk_count: number }>(
        'select status::text as status, chunk_count from deliveries where id = $1 and user_id = $2 for update',
        [input.deliveryId, input.userId],
      );
      const row = current.rows[0];
      if (!row || row.status !== 'uncertain') return false;

      await client.query(
        `insert into delivery_evidence (delivery_id, part_id, user_id, method, decision, telegram_message_id, note)
         values ($1, null, $2, $3, $4, $5::bigint, $6)`,
        [
          input.deliveryId,
          input.userId,
          input.method,
          input.decision,
          input.telegramMessageId ?? null,
          input.note ? input.note.slice(0, 200) : null,
        ],
      );

      if (input.decision === 'published') {
        // دليل النشر يحسم الأمر: الأجزاء المجهولة تُثبَّت كمرسلة (بلا إرسال جديد).
        await client.query(
          `update delivery_parts
              set status = 'sent', sent_at = coalesce(sent_at, now()),
                  telegram_message_id = coalesce(telegram_message_id, $2::bigint),
                  lease_owner = null, lease_expires_at = null
            where delivery_id = $1 and status = 'uncertain'`,
          [input.deliveryId, input.telegramMessageId ?? null],
        );
        await client.query(
          `update deliveries set status = 'published', published_at = coalesce(published_at, now()),
                  last_error_code = null, lease_owner = null, lease_expires_at = null
            where id = $1`,
          [input.deliveryId],
        );
      } else {
        await client.query(
          `update delivery_parts set status = 'failed', last_error_code = 'evidence_not_published',
                  lease_owner = null, lease_expires_at = null
            where delivery_id = $1 and status = 'uncertain'`,
          [input.deliveryId],
        );
        await client.query(
          `update deliveries set status = 'failed', last_error_code = 'evidence_not_published',
                  lease_owner = null, lease_expires_at = null
            where id = $1`,
          [input.deliveryId],
        );
      }
      return true;
    });
  }

  async detail(deliveryId: string, userId: string): Promise<DeliveryDetail | null> {
    const head = await query<{
      id: string;
      status: DeliveryStatus;
      review: string;
      review_reason: string | null;
      plan_version: number;
      approved_version: number | null;
      chunk_count: number;
      attempts: number;
      last_error_code: string | null;
      next_attempt_at: Date | null;
      published_at: Date | null;
      destination_title: string | null;
      republish_count: number;
      last_republished_at: Date | null;
    }>(
      `select d.id, d.status, d.review::text as review, d.review_reason, d.plan_version, d.approved_version,
              d.chunk_count, d.attempts, d.last_error_code, d.next_attempt_at, d.published_at,
              d.republish_count, d.last_republished_at,
              dest.title as destination_title
         from deliveries d
         left join destinations dest on dest.id = d.destination_id and dest.user_id = d.user_id
        where d.id = $1 and d.user_id = $2`,
      [deliveryId, userId],
    );
    const row = head.rows[0];
    if (!row) return null;

    const [parts, evidence, attempts] = await Promise.all([
      query<{
        id: string;
        part_index: number;
        text: string;
        char_count: number;
        status: string;
        telegram_message_id: string | null;
        attempts: number;
        last_error_code: string | null;
      }>(
        `select id, part_index, text, char_count, status::text as status,
                telegram_message_id::text as telegram_message_id, attempts, last_error_code
           from delivery_parts where delivery_id = $1 order by part_index`,
        [deliveryId],
      ),
      query<{
        method: string;
        decision: string;
        telegram_message_id: string | null;
        note: string | null;
        decided_at: Date;
      }>(
        `select method, decision, telegram_message_id::text as telegram_message_id, note, decided_at
           from delivery_evidence where delivery_id = $1 order by decided_at desc`,
        [deliveryId],
      ),
      query<{
        part_index: number | null;
        attempt_no: number;
        outcome: string;
        http_status: number | null;
        error_code: string | null;
        started_at: Date;
        finished_at: Date | null;
      }>(
        `select p.part_index, a.attempt_no, a.outcome::text as outcome, a.http_status, a.error_code,
                a.started_at, a.finished_at
           from delivery_attempts a
           left join delivery_parts p on p.id = a.part_id
          where a.delivery_id = $1
          order by a.started_at desc, a.attempt_no desc
          limit 50`,
        [deliveryId],
      ),
    ]);

    return {
      id: row.id,
      status: row.status,
      review: row.review,
      reviewReason: row.review_reason,
      planVersion: row.plan_version,
      approvedVersion: row.approved_version,
      chunkCount: row.chunk_count,
      attempts: row.attempts,
      lastErrorCode: row.last_error_code,
      nextAttemptAt: row.next_attempt_at ? row.next_attempt_at.toISOString() : null,
      publishedAt: row.published_at ? row.published_at.toISOString() : null,
      destinationTitle: row.destination_title,
      republishCount: Number(row.republish_count ?? 0),
      lastRepublishedAt: row.last_republished_at ? row.last_republished_at.toISOString() : null,
      republish: republishCapability(row.status, Number(row.republish_count ?? 0)),
      parts: parts.rows.map((part) => ({
        id: part.id,
        partIndex: part.part_index,
        text: part.text,
        charCount: part.char_count,
        status: part.status,
        telegramMessageId: part.telegram_message_id,
        attempts: part.attempts,
        lastErrorCode: part.last_error_code,
      })),
      evidence: evidence.rows.map((item) => ({
        method: item.method,
        decision: item.decision,
        telegramMessageId: item.telegram_message_id,
        note: item.note,
        decidedAt: item.decided_at.toISOString(),
      })),
      attemptLog: attempts.rows.map((item) => ({
        partIndex: item.part_index,
        attemptNo: item.attempt_no,
        outcome: item.outcome,
        httpStatus: item.http_status,
        errorCode: item.error_code,
        startedAt: item.started_at.toISOString(),
        finishedAt: item.finished_at ? item.finished_at.toISOString() : null,
      })),
    };
  }

  /**
   * تهيئة إعادة التخطيط (Q20) في معاملة واحدة:
   * 1) استحواذ على الصف (`for update`) فلا تتزامن إعادتان.
   * 2) رفض `uncertain` دائماً — تحتاج دليلاً بشرياً لا خطة جديدة.
   * 3) رفض ما ليس في (`failed`,`cancelled`,`blocked`) ورفض تجاوز السقف.
   * 4) حذف الأجزاء القديمة (محاولاتها تُحذف معها) وإعادة التسليم إلى مساره الطبيعي:
   *    `awaiting_review` إن كان المسار يطلب مراجعة، وإلا `queued`.
   * إعادة بناء الأجزاء نفسها تقع على المخطِّط بعد هذه المعاملة (مصدر واحد للتخطيط).
   */
  async prepareRepublish(
    deliveryId: string,
    userId: string,
  ): Promise<{ ok: true; republishCount: number } | { ok: false; reason: RepublishRefusal }> {
    return withTransaction(async (client) => {
      const res = await client.query<{
        status: string;
        review: string;
        republish_count: number;
        retention_expires_at: Date | null;
      }>(
        `select d.status::text as status, d.review::text as review, d.republish_count,
                c.retention_expires_at
           from deliveries d
           left join message_content c on c.identity_id = d.identity_id
          where d.id = $1 and d.user_id = $2
          for update of d`,
        [deliveryId, userId],
      );
      const row = res.rows[0];
      if (!row) return { ok: false as const, reason: 'not_found' as const };

      const capability = republishCapability(row.status, Number(row.republish_count));
      if (!capability.allowed) {
        // نُمرّر سبب الرفض نفسه الذي تعرضه الواجهة، فلا اختلاف بين العرض والتنفيذ.
        if (capability.reason === 'uncertain_forbidden') {
          return { ok: false as const, reason: 'uncertain_forbidden' as const };
        }
        if (capability.reason === 'limit_reached') {
          return { ok: false as const, reason: 'limit_reached' as const };
        }
        return { ok: false as const, reason: 'not_republishable' as const };
      }

      // المحتوى منتهي الاحتفاظ ⇒ لا خطة جديدة ممكنة (O06/D09).
      if (!row.retention_expires_at || row.retention_expires_at.getTime() <= Date.now()) {
        return { ok: false as const, reason: 'content_expired' as const };
      }

      await client.query('delete from delivery_parts where delivery_id = $1', [deliveryId]);
      const needsReview = row.review === 'pending' || row.review === 'approved';
      await client.query(
        `update deliveries
            set status = $3::delivery_status,
                review = $4::delivery_review,
                approved_version = null,
                approved_by = null,
                approved_at = null,
                rejected_reason = null,
                republish_count = republish_count + 1,
                last_republished_at = now(),
                last_error_code = null,
                attempts = 0,
                next_attempt_at = null,
                lease_owner = null,
                lease_expires_at = null,
                chunk_count = 0,
                chars_total = 0
          where id = $1 and user_id = $2`,
        [deliveryId, userId, needsReview ? 'awaiting_review' : 'queued', needsReview ? 'pending' : 'not_required'],
      );
      return { ok: true as const, republishCount: Number(row.republish_count) + 1 };
    });
  }
}
