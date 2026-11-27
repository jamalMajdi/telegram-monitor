/**
 * مخزن نتائج المعالجة (الخطوة 6): تصنيف الرسالة، القالب المختار، وقراءة نتائجها للمراجعة.
 *
 * المبادئ:
 * - التصنيف التلقائي واليدوي صفّان منفصلان، والعرض يفضّل اليدوي (O02: التعديل اليدوي يغلب في العرض).
 * - كل استعلام مقيّد بمالك البيانات؛ القراءة لا تُرجع أي قيمة تواصل خام (`value_raw` غير مختارة هنا).
 * - كل ما يُكتب هنا «نتيجة» تُحذف مع احتفاظ المحتوى (Q12).
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';

export type ReviewState = 'none' | 'needs_review' | 'reviewed';

export interface ClassificationToStore {
  id: string | null;
  name: string;
  confidence: number;
  ambiguous: boolean;
  evidence: unknown[];
  version: string;
}

export interface TemplateSelectionToStore {
  templateId: string | null;
  templateName: string | null;
  resolvedBy: 'route' | 'source' | 'filter' | 'classification' | 'default' | 'none';
  details: Record<string, unknown>;
}

export interface ResultListFilter {
  review?: ReviewState;
  classificationId?: string;
  state?: 'processed' | 'failed' | 'matched';
  /** تصفية بحالة النشر (P4-هـ): الجسر بين المعالجة والنشر في واجهة واحدة. */
  publishState?: 'not_routed' | 'routed' | 'awaiting_review';
  limit: number;
  /** وضع التوافق القديم فقط (offset)؛ المسار المعتمد هو المؤشِّر. */
  offset?: number;
  /** مؤشِّر الصفحة: الصفوف الأقدم من (first_seen_at, id) هذا. */
  after?: { receivedAt: string; id: string };
}

export interface ResultSummaryRow {
  identityId: string;
  sourceId: string;
  sourceTitle: string;
  peerType: string;
  state: string;
  /** حالة النشر (P4-هـ): تُعرض مع حالة المعالجة في القائمة نفسها. */
  publishState: string;
  reviewState: ReviewState;
  receivedAt: string;
  isRepeat: boolean;
  matchedCount: number;
  contactCount: number;
  extractionCount: number;
  classificationId: string | null;
  classificationName: string | null;
  classificationConfidence: number | null;
  /** غموض التصنيف الفعّال: مطابقتان أو أكثر في التصنيف التلقائي (يُستخدم لحسم المراجعة والعرض). */
  classificationAmbiguous: boolean;
  classificationOrigin: 'automatic' | 'manual' | null;
  templateId: string | null;
  templateName: string | null;
  resolvedBy: string | null;
  contentAvailable: boolean;
}

export interface ResultDetailRow extends ResultSummaryRow {
  autoClassificationId: string | null;
  autoClassificationName: string | null;
  autoClassificationConfidence: number | null;
  manualClassificationId: string | null;
  manualClassificationName: string | null;
  extractionVersion: number | null;
  extractedAt: string | null;
  templateResolvedDetails: Record<string, unknown>;
}

export interface ExtractedFieldRow {
  fieldKey: string;
  value: string;
  spanStart: number;
  spanEnd: number;
  source: 'text' | 'caption';
  cue: string;
  confidence: number;
  ambiguous: boolean;
}

export interface ContactRowSafe {
  kind: string;
  masked: string;
  spanStart: number;
  spanEnd: number;
  source: 'text' | 'caption';
  confidence: number;
  ambiguous: boolean;
}

export interface MatchRowSafe {
  filterId: string;
  filterName: string;
  priority: number;
  evidence: unknown[];
}

export interface ResultsStore {
  saveClassificationAndTemplate(input: {
    identityId: string;
    sourceId: string;
    classification: ClassificationToStore | null;
    selection: TemplateSelectionToStore;
    needsReview: boolean;
  }): Promise<void>;
  list(input: { userId: string; filter: ResultListFilter }): Promise<{
    rows: ResultSummaryRow[];
    total: number | null;
    hasMore: boolean;
  }>;
  detail(input: { userId: string; identityId: string }): Promise<{
    summary: ResultDetailRow;
    fields: ExtractedFieldRow[];
    contacts: ContactRowSafe[];
    matches: MatchRowSafe[];
    text: string | null;
    caption: string | null;
  } | null>;
  setReviewState(input: { userId: string; identityId: string; reviewState: ReviewState }): Promise<boolean>;
  setManualClassification(input: {
    userId: string;
    identityId: string;
    classification: { id: string; name: string } | null;
  }): Promise<boolean>;
}

const SUMMARY_COLUMNS = `
  i.id as identity_id, i.source_id, s.title as source_title, s.peer_type::text as peer_type,
  i.state::text as state, i.publish_state, i.review_state::text as review_state,
  i.first_seen_at as received_at, i.is_repeat, i.matched_count, i.contact_count, i.extraction_count,
  coalesce(man.classification_id, auto.classification_id) as classification_id,
  coalesce(man.classification_name, auto.classification_name) as classification_name,
  coalesce(man.confidence, auto.confidence) as classification_confidence,
  coalesce(man.ambiguous, auto.ambiguous, false) as classification_ambiguous,
  case when man.identity_id is not null then 'manual'
       when auto.identity_id is not null then 'automatic' else null end as classification_origin,
  r.template_id, r.template_name, r.resolved_by,
  (c.identity_id is not null) as content_available`;

const SUMMARY_JOINS = `
  from message_identity i
  join telegram_sources s on s.id = i.source_id
  left join message_classification auto on auto.identity_id = i.id and auto.origin = 'automatic'
  left join message_classification man on man.identity_id = i.id and man.origin = 'manual'
  left join message_template_resolution r on r.identity_id = i.id
  left join message_content c on c.identity_id = i.id`;

function toSummary(row: Record<string, unknown>): ResultSummaryRow {
  return {
    identityId: row.identity_id as string,
    sourceId: row.source_id as string,
    sourceTitle: row.source_title as string,
    peerType: row.peer_type as string,
    state: row.state as string,
    publishState: row.publish_state as string,
    reviewState: row.review_state as ReviewState,
    receivedAt: (row.received_at as Date).toISOString(),
    isRepeat: Boolean(row.is_repeat),
    matchedCount: Number(row.matched_count),
    contactCount: Number(row.contact_count),
    extractionCount: Number(row.extraction_count),
    classificationId: (row.classification_id as string | null) ?? null,
    classificationName: (row.classification_name as string | null) ?? null,
    classificationConfidence:
      row.classification_confidence === null || row.classification_confidence === undefined
        ? null
        : Number(row.classification_confidence),
    classificationAmbiguous: Boolean(row.classification_ambiguous),
    classificationOrigin: (row.classification_origin as 'automatic' | 'manual' | null) ?? null,
    templateId: (row.template_id as string | null) ?? null,
    templateName: (row.template_name as string | null) ?? null,
    resolvedBy: (row.resolved_by as string | null) ?? null,
    contentAvailable: Boolean(row.content_available),
  };
}

export class PgResultsStore implements ResultsStore {
  async saveClassificationAndTemplate(input: {
    identityId: string;
    sourceId: string;
    classification: ClassificationToStore | null;
    selection: TemplateSelectionToStore;
    needsReview: boolean;
  }): Promise<void> {
    await withTransaction(async (client: PoolClient) => {
      if (input.classification && input.classification.id) {
        await client.query(
          `insert into message_classification
             (identity_id, origin, classification_id, classification_name, confidence, ambiguous,
              evidence, classification_version)
           values ($1, 'automatic', $2, $3, $4, $5, $6::jsonb, $7::bigint)
           on conflict (identity_id, origin) do update
             set classification_id = excluded.classification_id,
                 classification_name = excluded.classification_name,
                 confidence = excluded.confidence,
                 ambiguous = excluded.ambiguous,
                 evidence = excluded.evidence,
                 classification_version = excluded.classification_version,
                 classified_at = now()`,
          [
            input.identityId,
            input.classification.id,
            input.classification.name,
            input.classification.confidence,
            input.classification.ambiguous,
            JSON.stringify(input.classification.evidence),
            input.classification.version,
          ],
        );
      }

      await client.query(
        `insert into message_template_resolution
           (identity_id, template_id, template_name, resolved_by, details)
         values ($1, $2, $3, $4, $5::jsonb)
         on conflict (identity_id) do update
           set template_id = excluded.template_id,
               template_name = excluded.template_name,
               resolved_by = excluded.resolved_by,
               details = excluded.details,
               resolved_at = now()`,
        [
          input.identityId,
          input.selection.templateId,
          input.selection.templateName,
          input.selection.resolvedBy,
          JSON.stringify(input.selection.details),
        ],
      );

      if (input.needsReview) {
        await client.query(
          `update message_identity
              set review_state = 'needs_review'
            where id = $1 and review_state = 'none'`,
          [input.identityId],
        );
      }

      await client.query('update telegram_sources set classified_count = classified_count + 1 where id = $1', [
        input.sourceId,
      ]);
    });
  }

  /**
   * صفحة نتائج بترقيم مؤشِّر (keyset على `first_seen_at desc, id desc`).
   *
   * لماذا لا `offset`: كل صفحة كانت تُعيد ترتيب النتائج وتقفز صفوفاً حين تصل رسالة جديدة أثناء التنقّل،
   * وتكلفتها تنمو مع العمق. المؤشِّر ثابت التكلفة، و`total` يُحسب فقط في وضع التوافق القديم.
   */
  async list(input: { userId: string; filter: ResultListFilter }): Promise<{
    rows: ResultSummaryRow[];
    total: number | null;
    hasMore: boolean;
  }> {
    const where: string[] = [`i.user_id = $1`, `i.state in ('processed', 'matched', 'failed')`];
    const params: unknown[] = [input.userId];

    if (input.filter.review) {
      params.push(input.filter.review);
      where.push(`i.review_state = $${params.length}::message_review_state`);
    }
    if (input.filter.classificationId) {
      params.push(input.filter.classificationId);
      where.push(`coalesce(man.classification_id, auto.classification_id) = $${params.length}`);
    }
    if (input.filter.state) {
      params.push(input.filter.state);
      where.push(`i.state = $${params.length}::message_state`);
    }
    if (input.filter.publishState) {
      params.push(input.filter.publishState);
      where.push(`i.publish_state = $${params.length}`);
    }
    if (input.filter.after) {
      // مفتاح مركّب حتمي: أقدم من نقطة التوقف، أو نفس اللحظة بمعرّف أصغر.
      params.push(input.filter.after.receivedAt, input.filter.after.id);
      where.push(`(i.first_seen_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }

    const whereSql = where.join(' and ');
    const usesOffset = input.filter.after === undefined && typeof input.filter.offset === 'number';

    const countRes = usesOffset
      ? await query<{ total: string }>(`select count(*)::text as total ${SUMMARY_JOINS} where ${whereSql}`, params)
      : null;

    // صف إضافي واحد لمعرفة إن كانت هناك صفحة تالية بلا استعلام ثانٍ.
    // نلتقط رقم الموضع صراحةً: ترتيب المعاملات يتغيّر عند وجود مؤشِّر.
    params.push(input.filter.limit + 1);
    const limitPlaceholder = params.length;
    let offsetPlaceholder = 0;
    if (usesOffset) {
      params.push(input.filter.offset ?? 0);
      offsetPlaceholder = params.length;
    }
    const rowsRes = await query<Record<string, unknown>>(
      `select ${SUMMARY_COLUMNS} ${SUMMARY_JOINS}
        where ${whereSql}
        order by i.first_seen_at desc, i.id desc
        limit $${limitPlaceholder}${offsetPlaceholder ? ` offset $${offsetPlaceholder}` : ''}`,
      params,
    );

    const hasMore = rowsRes.rows.length > input.filter.limit;
    const page = hasMore ? rowsRes.rows.slice(0, input.filter.limit) : rowsRes.rows;
    return {
      rows: page.map(toSummary),
      total: countRes ? Number(countRes.rows[0]?.total ?? 0) : null,
      hasMore,
    };
  }

  async detail(input: { userId: string; identityId: string }): Promise<{
    summary: ResultDetailRow;
    fields: ExtractedFieldRow[];
    contacts: ContactRowSafe[];
    matches: MatchRowSafe[];
    text: string | null;
    caption: string | null;
  } | null> {
    const summaryRes = await query<Record<string, unknown>>(
      `select ${SUMMARY_COLUMNS},
              auto.classification_id as auto_classification_id,
              auto.classification_name as auto_classification_name,
              auto.confidence as auto_classification_confidence,
              man.classification_id as manual_classification_id,
              man.classification_name as manual_classification_name,
              i.extraction_version, i.extracted_at,
              coalesce(r.details, '{}'::jsonb) as template_details
         ${SUMMARY_JOINS}
        where i.user_id = $1 and i.id = $2`,
      [input.userId, input.identityId],
    );
    const row = summaryRes.rows[0];
    if (!row) return null;

    const [fieldsRes, contactsRes, matchesRes, contentRes] = await Promise.all([
      query<Record<string, unknown>>(
        `select field_key, value_text, span_start, span_end, source::text as source, cue,
                confidence, ambiguous
           from message_extraction where identity_id = $1
          order by span_start, field_key`,
        [input.identityId],
      ),
      // لا تُختار value_raw إطلاقاً: العرض المحجوب هو الافتراضي (O03).
      query<Record<string, unknown>>(
        `select contact_kind::text as kind, value_masked as masked, span_start, span_end,
                source::text as source, confidence, ambiguous
           from message_contacts where identity_id = $1
          order by span_start`,
        [input.identityId],
      ),
      query<Record<string, unknown>>(
        `select filter_id, filter_name, priority, evidence from message_matches
          where identity_id = $1 order by priority, filter_name`,
        [input.identityId],
      ),
      query<{ message_text: string | null; caption: string | null }>(
        'select message_text, caption from message_content where identity_id = $1',
        [input.identityId],
      ),
    ]);

    const summary: ResultDetailRow = {
      ...toSummary(row),
      autoClassificationId: (row.auto_classification_id as string | null) ?? null,
      autoClassificationName: (row.auto_classification_name as string | null) ?? null,
      autoClassificationConfidence:
        row.auto_classification_confidence === null || row.auto_classification_confidence === undefined
          ? null
          : Number(row.auto_classification_confidence),
      manualClassificationId: (row.manual_classification_id as string | null) ?? null,
      manualClassificationName: (row.manual_classification_name as string | null) ?? null,
      extractionVersion: (row.extraction_version as number | null) ?? null,
      extractedAt: row.extracted_at ? (row.extracted_at as Date).toISOString() : null,
      templateResolvedDetails: (row.template_details as Record<string, unknown>) ?? {},
    };

    return {
      summary,
      fields: fieldsRes.rows.map((field) => ({
        fieldKey: field.field_key as string,
        value: field.value_text as string,
        spanStart: Number(field.span_start),
        spanEnd: Number(field.span_end),
        source: field.source as 'text' | 'caption',
        cue: field.cue as string,
        confidence: Number(field.confidence),
        ambiguous: Boolean(field.ambiguous),
      })),
      contacts: contactsRes.rows.map((contact) => ({
        kind: contact.kind as string,
        masked: contact.masked as string,
        spanStart: Number(contact.span_start),
        spanEnd: Number(contact.span_end),
        source: contact.source as 'text' | 'caption',
        confidence: Number(contact.confidence),
        ambiguous: Boolean(contact.ambiguous),
      })),
      matches: matchesRes.rows.map((match) => ({
        filterId: match.filter_id as string,
        filterName: match.filter_name as string,
        priority: Number(match.priority),
        evidence: (match.evidence as unknown[]) ?? [],
      })),
      text: contentRes.rows[0]?.message_text ?? null,
      caption: contentRes.rows[0]?.caption ?? null,
    };
  }

  async setReviewState(input: { userId: string; identityId: string; reviewState: ReviewState }): Promise<boolean> {
    const res = await query(
      `update message_identity
          set review_state = $3::message_review_state
        where user_id = $1 and id = $2`,
      [input.userId, input.identityId, input.reviewState],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setManualClassification(input: {
    userId: string;
    identityId: string;
    classification: { id: string; name: string } | null;
  }): Promise<boolean> {
    return withTransaction(async (client: PoolClient) => {
      const owned = await client.query('select 1 from message_identity where user_id = $1 and id = $2', [
        input.userId,
        input.identityId,
      ]);
      if (owned.rowCount === 0) return false;

      if (!input.classification) {
        await client.query(
          `delete from message_classification where identity_id = $1 and origin = 'manual'`,
          [input.identityId],
        );
        return true;
      }

      // الثقة 1.00 لأن القرار بشري صريح، و`ambiguous=false` لأنه حُسم يدوياً (O02).
      await client.query(
        `insert into message_classification
           (identity_id, origin, classification_id, classification_name, confidence, ambiguous, evidence, classification_version)
         values ($1, 'manual', $2, $3, 1.00, false, '[]'::jsonb,
                 coalesce((select classification_version from message_classification
                            where identity_id = $1 and origin = 'automatic'), 0))
         on conflict (identity_id, origin) do update
           set classification_id = excluded.classification_id,
               classification_name = excluded.classification_name,
               confidence = 1.00,
               ambiguous = false,
               classified_at = now()`,
        [input.identityId, input.classification.id, input.classification.name],
      );
      return true;
    });
  }
}
