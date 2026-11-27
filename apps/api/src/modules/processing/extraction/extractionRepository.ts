/**
 * مخزن نتائج الاستخراج (الخطوة 5-ج).
 *
 * كل الكتابات في معاملة واحدة: الحقول + فئات التواصل + حالة الهوية + عدّاد المصدر.
 * لا يُخزَّن أي نص رسالة هنا (النص في `message_content`)، والقيم المستخرجة دائماً مقتطعة
 * من النص الأصلي بواسطة طبقة الاستخراج النقية.
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../../../db/pool.js';
import type { DetectedContact } from './contactDetector.js';
import type { ExtractedField } from './fieldExtractor.js';

export interface ExtractionStore {
  /** يحفظ نتائج الاستخراج ويحوّل الهوية إلى `processed`. */
  saveExtraction(input: {
    identityId: string;
    sourceId: string;
    fields: ExtractedField[];
    contacts: DetectedContact[];
    extractionVersion: number;
    needsReview: boolean;
  }): Promise<void>;
}

export class PgExtractionStore implements ExtractionStore {
  async saveExtraction(input: {
    identityId: string;
    sourceId: string;
    fields: ExtractedField[];
    contacts: DetectedContact[];
    extractionVersion: number;
    needsReview: boolean;
  }): Promise<void> {
    await withTransaction(async (client: PoolClient) => {
      for (const field of input.fields) {
        await client.query(
          `insert into message_extraction
             (identity_id, field_key, value_text, span_start, span_end, source, cue,
              confidence, ambiguous, extraction_version)
           values ($1, $2, $3, $4, $5, $6::extraction_source, $7, $8, $9, $10)
           on conflict (identity_id, field_key, span_start, span_end) do nothing`,
          [
            input.identityId,
            field.fieldKey,
            field.value,
            field.spanStart,
            field.spanEnd,
            field.source,
            field.cue,
            field.confidence,
            field.ambiguous,
            input.extractionVersion,
          ],
        );
      }

      for (const contact of input.contacts) {
        await client.query(
          `insert into message_contacts
             (identity_id, contact_kind, value_raw, value_normalized, value_masked,
              span_start, span_end, source, confidence, ambiguous, extraction_version)
           values ($1, $2::contact_kind, $3, $4, $5, $6, $7, $8::extraction_source, $9, $10, $11)
           on conflict (identity_id, contact_kind, span_start, span_end) do nothing`,
          [
            input.identityId,
            contact.kind,
            contact.raw,
            contact.normalized,
            contact.masked,
            contact.spanStart,
            contact.spanEnd,
            contact.source,
            contact.confidence,
            contact.ambiguous,
            input.extractionVersion,
          ],
        );
      }

      await client.query(
        `update message_identity
            set state = 'processed',
                extraction_version = $2,
                extraction_count = $3,
                contact_count = $4,
                extracted_at = now(),
                review_state = case
                  when $5::boolean then 'needs_review'::message_review_state
                  when review_state = 'none'::message_review_state then 'none'::message_review_state
                  else review_state
                end
          where id = $1`,
        [input.identityId, input.extractionVersion, input.fields.length, input.contacts.length, input.
          needsReview],
      );

      await client.query('update telegram_sources set extracted_count = extracted_count + 1 where id = $1', [
        input.sourceId,
      ]);
    });
  }
}
