/**
 * الخط الزمني الموحّد للرسالة (P4-هـ، §17/§18).
 *
 * الهدف: أن يرى المالك **قصة واحدة** لا ثلاث حالات متنافرة. نجمع في مسار واحد:
 * - `message_identity.state` (المعالجة: ignored/processed/matched/failed)
 * - `message_identity.publish_state` (التوجيه: not_routed/routed/awaiting_review)
 * - `deliveries.status` لكل وجهة (awaiting_review/queued/sending/published/partial/failed/uncertain/blocked/cancelled)
 *
 * قواعد ثابتة:
 * - كل استعلام مقيَّد بمالك الرسالة؛ لا صف من مستخدم آخر.
 * - لا محتوى تواصل خام في أي حقل (يُعرض العدد والقيم المحجوبة فقط).
 * - الأحداث مرتّبة زمنياً مع حقل `at` لكل حدث، والترتيب حتمي عند التعادل.
 */
import { query } from '../../db/pool.js';

export type JourneyStage = 'processing' | 'filtering' | 'classification' | 'routing' | 'publishing' | 'review';

export interface JourneyEvent {
  at: string;
  stage: JourneyStage;
  /** رمز آلي ثابت يعرضه العميل بلغته (لا جمل حرة). */
  code: string;
  /** تفصيل مختصر وحقائق محددة (أسماء وجهات، رموز أخطاء) — بلا نصوص رسائل. */
  detail: Record<string, string | number | boolean | null>;
}

export interface JourneyDelivery {
  id: string;
  status: string;
  destinationId: string;
  destinationTitle: string | null;
  planParts: number;
  sentParts: number;
  attempts: number;
  lastErrorCode: string | null;
  review: string;
  republishCount: number;
  lastRepublishedAt: string | null;
  republish: { allowed: boolean; reason: string | null; remaining: number };
  createdAt: string;
  publishedAt: string | null;
  parts: { partIndex: number; status: string; telegramMessageId: string | null; charCount: number }[];
  attemptsLog: { partIndex: number | null; attemptNo: number; outcome: string; errorCode: string | null; startedAt: string }[];
  evidence: { method: string; decision: string; note: string | null; decidedAt: string }[];
}

export interface MessageJourney {
  identityId: string;
  sourceId: string;
  sourceTitle: string;
  receivedAt: string;
  state: string;
  publishState: string;
  reviewState: string;
  contentAvailable: boolean;
  retentionExpiresAt: string | null;
  matchedFilters: { id: string; name: string; priority: number }[];
  classification: { name: string | null; origin: string | null; confidence: number | null; ambiguous: boolean } | null;
  template: { id: string | null; name: string | null; resolvedBy: string | null };
  deliveries: JourneyDelivery[];
  /** الحالات الثلاث كما هي، بلا دمج ولا تفسير — للمقارنة الصريحة. */
  states: { processing: string; publishing: string; deliveryStatuses: string[] };
  timeline: JourneyEvent[];
}

/** السقف المعلن لإعادة النشر (Q20) — يُستورد من مخزن التنفيذ ليبقى مصدراً واحداً. */
import { REPUBLISH_LIMIT, republishCapability } from '../publishing/deliveryStore.js';

export class JourneyRepository {
  async load(userId: string, identityId: string): Promise<MessageJourney | null> {
    const head = await query<{
      id: string;
      source_id: string;
      source_title: string;
      first_seen_at: Date;
      state: string;
      publish_state: string;
      review_state: string;
      content_available: boolean;
      retention_expires_at: Date | null;
      classification_name: string | null;
      classification_origin: string | null;
      classification_confidence: number | null;
      classification_ambiguous: boolean | null;
      template_id: string | null;
      template_name: string | null;
      resolved_by: string | null;
    }>(
      `select i.id, i.source_id, s.title as source_title, i.first_seen_at,
              i.state::text as state, i.publish_state, i.review_state::text as review_state,
              (c.identity_id is not null) as content_available, c.retention_expires_at,
              coalesce(man.classification_name, auto.classification_name) as classification_name,
              case when man.identity_id is not null then 'manual'
                   when auto.identity_id is not null then 'automatic' else null end as classification_origin,
              coalesce(man.confidence, auto.confidence) as classification_confidence,
              coalesce(man.ambiguous, auto.ambiguous) as classification_ambiguous,
              r.template_id, r.template_name, r.resolved_by
         from message_identity i
         join telegram_sources s on s.id = i.source_id and s.user_id = i.user_id
         left join message_content c on c.identity_id = i.id
         left join message_classification auto on auto.identity_id = i.id and auto.origin = 'automatic'
         left join message_classification man on man.identity_id = i.id and man.origin = 'manual'
         left join message_template_resolution r on r.identity_id = i.id
        where i.id = $2 and i.user_id = $1`,
      [userId, identityId],
    );
    const row = head.rows[0];
    if (!row) return null;

    const [matchesRes, deliveriesRes] = await Promise.all([
      query<{ id: string; name: string; priority: number; matched_at: Date }>(
        `select m.filter_id as id, m.filter_name as name, m.priority, m.matched_at
           from message_matches m
           join message_identity i on i.id = m.identity_id
          where m.identity_id = $1 and i.user_id = $2
          order by m.priority, m.filter_name, m.filter_id`,
        [identityId, userId],
      ),
      query<{
        id: string;
        status: string;
        destination_id: string;
        destination_title: string | null;
        chunk_count: number;
        attempts: number;
        last_error_code: string | null;
        review: string;
        republish_count: number;
        last_republished_at: Date | null;
        created_at: Date;
        published_at: Date | null;
      }>(
        `select d.id, d.status::text as status, d.destination_id, dest.title as destination_title,
                d.chunk_count, d.attempts, d.last_error_code, d.review::text as review,
                d.republish_count, d.last_republished_at, d.created_at, d.published_at
           from deliveries d
           left join destinations dest on dest.id = d.destination_id and dest.user_id = d.user_id
          where d.identity_id = $1 and d.user_id = $2
          order by d.created_at, d.id`,
        [identityId, userId],
      ),
    ]);

    const deliveries: JourneyDelivery[] = [];
    for (const delivery of deliveriesRes.rows) {
      const [partsRes, attemptsRes, evidenceRes] = await Promise.all([
        query<{ part_index: number; status: string; telegram_message_id: string | null; char_count: number }>(
          `select part_index, status::text as status, telegram_message_id::text as telegram_message_id, char_count
             from delivery_parts where delivery_id = $1 order by part_index`,
          [delivery.id],
        ),
        query<{
          part_index: number | null;
          attempt_no: number;
          outcome: string;
          error_code: string | null;
          started_at: Date;
        }>(
          `select p.part_index, a.attempt_no, a.outcome::text as outcome, a.error_code, a.started_at
             from delivery_attempts a
             left join delivery_parts p on p.id = a.part_id
            where a.delivery_id = $1
            order by a.started_at, a.attempt_no`,
          [delivery.id],
        ),
        query<{ method: string; decision: string; note: string | null; decided_at: Date }>(
          `select method, decision, note, decided_at from delivery_evidence
            where delivery_id = $1 and user_id = $2 order by decided_at`,
          [delivery.id, userId],
        ),
      ]);

      const parts = partsRes.rows.map((part) => ({
        partIndex: part.part_index,
        status: part.status,
        telegramMessageId: part.telegram_message_id,
        charCount: part.char_count,
      }));

      deliveries.push({
        id: delivery.id,
        status: delivery.status,
        destinationId: delivery.destination_id,
        destinationTitle: delivery.destination_title,
        planParts: delivery.chunk_count,
        sentParts: parts.filter((part) => part.status === 'sent').length,
        attempts: delivery.attempts,
        lastErrorCode: delivery.last_error_code,
        review: delivery.review,
        republishCount: delivery.republish_count,
        lastRepublishedAt: delivery.last_republished_at ? delivery.last_republished_at.toISOString() : null,
        republish: republishCapability(delivery.status, delivery.republish_count),
        createdAt: delivery.created_at.toISOString(),
        publishedAt: delivery.published_at ? delivery.published_at.toISOString() : null,
        parts,
        attemptsLog: attemptsRes.rows.map((attempt) => ({
          partIndex: attempt.part_index,
          attemptNo: attempt.attempt_no,
          outcome: attempt.outcome,
          errorCode: attempt.error_code,
          startedAt: attempt.started_at.toISOString(),
        })),
        evidence: evidenceRes.rows.map((item) => ({
          method: item.method,
          decision: item.decision,
          note: item.note,
          decidedAt: item.decided_at.toISOString(),
        })),
      });
    }

    const timeline: JourneyEvent[] = [];
    const receivedAt = row.first_seen_at.toISOString();
    timeline.push({ at: receivedAt, stage: 'processing', code: 'received', detail: { source: row.source_title } });

    if (row.state !== 'processed' && row.state !== 'matched' && row.state !== 'failed') {
      timeline.push({
        at: receivedAt,
        stage: 'processing',
        code: `state.${row.state}`,
        detail: { messageState: row.state },
      });
    }

    for (const match of matchesRes.rows) {
      timeline.push({
        at: match.matched_at.toISOString(),
        stage: 'filtering',
        code: 'filter_matched',
        detail: { filter: match.name, priority: match.priority },
      });
    }

    if (row.classification_name) {
      timeline.push({
        at: receivedAt,
        stage: 'classification',
        code: 'classified',
        detail: {
          classification: row.classification_name,
          origin: row.classification_origin,
          confidence: row.classification_confidence === null ? null : Number(row.classification_confidence),
        },
      });
    }
    if (row.template_name || row.resolved_by) {
      timeline.push({
        at: receivedAt,
        stage: 'classification',
        code: 'template_resolved',
        detail: { template: row.template_name, resolvedBy: row.resolved_by },
      });
    }

    timeline.push({
      at: receivedAt,
      stage: 'routing',
      code: `publish_state.${row.publish_state}`,
      detail: { deliveries: deliveries.length },
    });

    for (const delivery of deliveries) {
      const destination = delivery.destinationTitle ?? 'وجهة محذوفة';
      timeline.push({
        at: delivery.createdAt,
        stage: 'publishing',
        code: 'delivery_created',
        detail: { destination, status: delivery.status, parts: delivery.planParts },
      });
      if (delivery.review !== 'not_required') {
        timeline.push({
          at: delivery.createdAt,
          stage: 'review',
          code: `review.${delivery.review}`,
          detail: { destination },
        });
      }
      for (const attempt of delivery.attemptsLog) {
        timeline.push({
          at: attempt.startedAt,
          stage: 'publishing',
          code: `attempt.${attempt.outcome}`,
          detail: {
            destination,
            partIndex: attempt.partIndex,
            attemptNo: attempt.attemptNo,
            errorCode: attempt.errorCode,
          },
        });
      }
      if (delivery.lastRepublishedAt) {
        timeline.push({
          at: delivery.lastRepublishedAt,
          stage: 'publishing',
          code: 'delivery_republished',
          detail: { destination, count: delivery.republishCount, limit: REPUBLISH_LIMIT },
        });
      }
      if (delivery.publishedAt) {
        timeline.push({
          at: delivery.publishedAt,
          stage: 'publishing',
          code: 'delivery_published',
          detail: { destination, status: delivery.status },
        });
      } else if (['failed', 'uncertain', 'blocked', 'cancelled'].includes(delivery.status)) {
        timeline.push({
          at: delivery.createdAt,
          stage: 'publishing',
          code: `delivery_${delivery.status}`,
          detail: { destination, errorCode: delivery.lastErrorCode },
        });
      }
      for (const item of delivery.evidence) {
        timeline.push({
          at: item.decidedAt,
          stage: 'review',
          code: `evidence.${item.decision}`,
          detail: { destination, method: item.method },
        });
      }
    }

    // ترتيب حتمي: الزمن ثم المرحلة ثم الرمز، فتُقرأ القصة نفسها في كل تحميل.
    timeline.sort((left, right) => {
      if (left.at !== right.at) return left.at < right.at ? -1 : 1;
      if (left.stage !== right.stage) return left.stage < right.stage ? -1 : 1;
      return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
    });

    return {
      identityId: row.id,
      sourceId: row.source_id,
      sourceTitle: row.source_title,
      receivedAt,
      state: row.state,
      publishState: row.publish_state,
      reviewState: row.review_state,
      contentAvailable: row.content_available,
      retentionExpiresAt: row.retention_expires_at ? row.retention_expires_at.toISOString() : null,
      matchedFilters: matchesRes.rows.map((match) => ({
        id: match.id,
        name: match.name,
        priority: match.priority,
      })),
      classification: row.classification_name
        ? {
            name: row.classification_name,
            origin: row.classification_origin,
            confidence: row.classification_confidence === null ? null : Number(row.classification_confidence),
            ambiguous: Boolean(row.classification_ambiguous),
          }
        : null,
      template: { id: row.template_id, name: row.template_name, resolvedBy: row.resolved_by },
      deliveries,
      states: {
        processing: row.state,
        publishing: row.publish_state,
        deliveryStatuses: deliveries.map((delivery) => delivery.status),
      },
      timeline,
    };
  }
}
