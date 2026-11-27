/**
 * خدمة الاستخراج (الخطوة 5-ج): تربط المستخرج النقي بالمخزن.
 *
 * - تعمل على نص الرسالة وتعليقها فقط (D06: الوسائط لا تُنزَّل ولا تُحلَّل).
 * - لا ترفع أخطاءً بنفسها؛ خطأ التخزين يصعد إلى خدمة المعالجة لتُسجّل `failed` (Q4).
 * - تُرجع ملخّصاً رقمياً فقط (عدد الحقول/الأسطر) لا نصوصاً، فلا يتسرّب محتوى إلى السجلات.
 */
import { logger } from '../../../lib/logger.js';
import { contactsNeedReview, detectContacts } from './contactDetector.js';
import { needsReview, extractFields } from './fieldExtractor.js';
import { EXTRACTION_VERSION } from './cues.js';
import type { ExtractionStore } from './extractionRepository.js';

export interface ExtractionResult {
  ok: boolean;
  fields: number;
  contacts: number;
  needsReview: boolean;
  extractionVersion: number;
}

export class ExtractionService {
  constructor(
    private readonly store: ExtractionStore,
    private readonly enabled = true,
  ) {}

  async extractAndStore(input: {
    identityId: string;
    sourceId: string;
    text: string;
    caption: string;
  }): Promise<ExtractionResult> {
    if (!this.enabled) {
      return { ok: false, fields: 0, contacts: 0, needsReview: false, extractionVersion: EXTRACTION_VERSION };
    }

    const fields = extractFields({ text: input.text, caption: input.caption });
    const contacts = detectContacts({ text: input.text, caption: input.caption });
    const review = needsReview(fields) || contactsNeedReview(contacts);

    await this.store.saveExtraction({
      identityId: input.identityId,
      sourceId: input.sourceId,
      fields,
      contacts,
      extractionVersion: EXTRACTION_VERSION,
      needsReview: review,
    });

    logger.debug(
      { identityId: input.identityId, fields: fields.length, contacts: contacts.length, review },
      'تم استخراج حقول الرسالة',
    );

    return {
      ok: true,
      fields: fields.length,
      contacts: contacts.length,
      needsReview: review,
      extractionVersion: EXTRACTION_VERSION,
    };
  }
}
