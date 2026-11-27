/**
 * خدمة معالجة الرسالة (الخطوة 5-ب): تحوّل «رسالة وصلت» إلى قرار مسجَّل.
 *
 * الترتيب المنفَّذ مطابق لـ§18 المعتمد:
 *   فحص نوع المحتوى → (التكرار حُسم في الالتقاط) → الفلترة → حفظ المحتوى المطابق + النتائج.
 * (الاستخراج والتصنيف والقالب تأتي في الخطوات التالية، فتبقى الحالة `matched` الآن.)
 *
 * ضمانات معتمدة:
 * - المعالجة **متزامنة داخل العملية** بلا طابور يحمل نصاً (Q13).
 * - فشل المعالجة لا يمنع تقدّم نقطة الاستئناف: يُسجَّل `failed` ويُعاد الخطأ للمتصل بلا رفع (Q4).
 * - رسالة بلا نص ولا تعليق ⇒ `ignored/no_text` ولا يُخزَّن لها محتوى (Q3).
 * - تجاوز الحد ⇒ `ignored/too_long` بلا اقتطاع (Q11).
 * - غير المطابق ⇒ `ignored` بلا نص محفوظ (F04/Q1).
 */
import { logger } from '../../lib/logger.js';
import { NORMALIZATION_VERSION } from './normalization.js';
import { prepareContent } from './contentTypes.js';
import type {
  ContentRow,
  IgnoreReason,
  MatchRow,
  ProcessingStore,
} from './messageProcessingRepository.js';
import type { FilterService } from './filterService.js';
import type { ExtractionService } from './extraction/extractionService.js';
import type { ResultsService } from './resultsService.js';

export interface ProcessingOutcome {
  state: 'matched' | 'processed' | 'ignored' | 'failed';
  reason?: IgnoreReason;
  matchedCount?: number;
  isRepeat?: boolean;
  errorCode?: string;
  /** نتائج الاستخراج (الخطوة 5-ج) — أرقام فقط بلا محتوى. */
  extractedFields?: number;
  contacts?: number;
  needsReview?: boolean;
  /** التصنيف المختار (6-أ) واسم القالب المحدَّد (6-ب) — أسماء إعدادات لا محتوى. */
  classificationName?: string;
  templateName?: string | null;
  /** عدد تسليمات النشر التي أنشأها محرك التوجيه (7-ب) — رقم فقط بلا محتوى. */
  deliveries?: number;
}

export interface ProcessingServiceDeps {
  store: ProcessingStore;
  filters: Pick<FilterService, 'decide'>;
  /** تعطيل المعالجة من البيئة؛ الالتقاط يستمر وتُسجَّل الرسائل `ignored/processing_disabled`. */
  enabled: boolean;
  /**
   * مرحلة الاستخراج (5-ج). غيابها يعني التوقف عند `matched` (سلوك 5-ب محفوظ).
   * خطؤها يُصعِد للـcatch ⇒ `failed` بلا إيقاف نقطة الاستئناف (Q4).
   */
  extraction?: Pick<ExtractionService, 'extractAndStore'>;
  /**
   * المرحلة الأخيرة (6-أ/6-ب): التصنيف الحتمي واختيار القالب (O02).
   * غيابها يعني التوقف عند `processed` بلا تصنيف.
   */
  results?: Pick<ResultsService, 'classifyAndSelectTemplate'>;
  /**
   * محرك التوجيه (7-ب): يُنشئ تسليمات النشر بعد اكتمال التصنيف واختيار القالب.
   * غيابه يعني التوقف عند المعالجة بلا توجيه. خطؤه لا يُسقط المعالجة (لا يمسّ نقطة الاستئناف).
   */
  routing?: { routeMessage(input: { userId: string; identityId: string; sourceId: string; matchedFilterIds: string[] }): Promise<{ deliveries: number }> };
}

export class MessageProcessingService {
  private readonly retentionCache = new Map<string, { hours: number; at: number }>();
  private purgeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ProcessingServiceDeps) {}

  /**
   * يعالج رسالة سبق أن حُفظت هويتها في معاملة الالتقاط.
   * لا يرفع الأخطاء أبداً: الفشل يُسجَّل على الهوية/المصدر ويُعاد كـ`failed` (Q4).
   */
  async process(input: {
    userId: string;
    identityId: string;
    sourceId: string;
    text: string;
    caption: string;
  }): Promise<ProcessingOutcome> {
    try {
      if (!this.deps.enabled) {
        await this.deps.store.markIgnored({
          identityId: input.identityId,
          sourceId: input.sourceId,
          reason: 'processing_disabled',
          normalizationVersion: NORMALIZATION_VERSION,
        });
        return { state: 'ignored', reason: 'processing_disabled' };
      }

      // 1) نوع المحتوى والحدود (Q3/Q11) — قبل أي فلترة وقبل أي حفظ.
      const prepared = prepareContent({ text: input.text, caption: input.caption });
      if (!prepared.ok) {
        await this.deps.store.markIgnored({
          identityId: input.identityId,
          sourceId: input.sourceId,
          reason: prepared.reason,
          normalizationVersion: NORMALIZATION_VERSION,
        });
        return { state: 'ignored', reason: prepared.reason };
      }

      // 2) الفلترة: قرار حتمي بحسب إصدار الإعدادات.
      const decision = await this.deps.filters.decide({
        userId: input.userId,
        sourceId: input.sourceId,
        text: prepared.text,
        caption: prepared.caption,
      });

      if (!decision.matched) {
        const reason: IgnoreReason =
          decision.reason === 'no_active_filter' ? 'no_source_filter' : 'no_filter';
        await this.deps.store.markIgnored({
          identityId: input.identityId,
          sourceId: input.sourceId,
          reason,
          contentHash: prepared.contentHash,
          normalizationVersion: NORMALIZATION_VERSION,
        });
        return { state: 'ignored', reason };
      }

      // 3) المطابقة: تكرار المحتوى يُعلَّم فقط الآن (Q6)، والحفظ للأصل كما ورد (Q1/D04).
      const isRepeat = await this.deps.store.isRepeatContent({
        userId: input.userId,
        identityId: input.identityId,
        contentHash: prepared.contentHash,
      });

      const content: ContentRow = {
        text: prepared.text,
        caption: prepared.caption,
        textLength: prepared.textLength,
        captionLength: prepared.captionLength,
        contentHash: prepared.contentHash,
      };

      const matches: MatchRow[] = decision.matches.map((match) => ({
        filterId: match.ruleId,
        filterName: match.ruleName,
        priority: match.priority,
        evidence: match.hits.map((hit) => ({
          conditionId: hit.conditionId,
          mode: hit.mode,
          negate: hit.negate,
          count: hit.count,
          matchedTerms: hit.matchedTerms,
        })),
      }));

      await this.deps.store.saveMatch({
        userId: input.userId,
        identityId: input.identityId,
        sourceId: input.sourceId,
        content,
        matches,
        processingVersion: decision.processingVersion,
        normalizationVersion: NORMALIZATION_VERSION,
        isRepeat,
        retentionHours: await this.retentionHours(input.userId),
      });

      // 4) الاستخراج (5-ج): بعد تثبيت المحتوى والمطابقات، وفي معاملة مستقلة.
      if (this.deps.extraction) {
        const extraction = await this.deps.extraction.extractAndStore({
          identityId: input.identityId,
          sourceId: input.sourceId,
          text: prepared.text,
          caption: prepared.caption,
        });
        if (extraction.ok) {
          // 5) التصنيف واختيار القالب (6-أ/6-ب) في معاملة مستقلة.
          if (this.deps.results) {
            const outcome = await this.deps.results.classifyAndSelectTemplate({
              userId: input.userId,
              identityId: input.identityId,
              sourceId: input.sourceId,
              text: prepared.text,
              caption: prepared.caption,
              matchedFilterIds: matches.map((match) => match.filterId),
              extractionNeedsReview: extraction.needsReview,
            });
            // 6) التوجيه إلى وجهات النشر (7-ب): بعد ثبوت التصنيف والقالب.
            //    فشل التوجيه يُسجَّل ولا يُحوّل الرسالة إلى failed (المعالجة مكتملة أصلاً).
            let deliveries = 0;
            if (this.deps.routing) {
              try {
                const routed = await this.deps.routing.routeMessage({
                  userId: input.userId,
                  identityId: input.identityId,
                  sourceId: input.sourceId,
                  matchedFilterIds: matches.map((match) => match.filterId),
                });
                deliveries = routed.deliveries;
              } catch (err) {
                logger.error(
                  { identityId: input.identityId, err: (err as Error).message },
                  'فشل توجيه الرسالة إلى وجهات النشر — تبقى المعالجة مكتملة',
                );
              }
            }
            return {
              state: 'processed',
              matchedCount: matches.length,
              isRepeat,
              extractedFields: extraction.fields,
              contacts: extraction.contacts,
              needsReview: outcome.needsReview,
              classificationName: outcome.classification.classificationName,
              templateName: outcome.selection.templateName,
              deliveries,
            };
          }
          return {
            state: 'processed',
            matchedCount: matches.length,
            isRepeat,
            extractedFields: extraction.fields,
            contacts: extraction.contacts,
            needsReview: extraction.needsReview,
          };
        }
        return { state: 'matched', matchedCount: matches.length, isRepeat };
      }

      return { state: 'matched', matchedCount: matches.length, isRepeat };
    } catch (err) {
      const code = 'PROCESSING_FAILED';
      logger.error(
        { identityId: input.identityId, sourceId: input.sourceId, err: (err as Error).message },
        'فشل معالجة رسالة — تُسجَّل failed ولا توقف نقطة الاستئناف',
      );
      await this.deps.store
        .markFailed({ identityId: input.identityId, sourceId: input.sourceId, code })
        .catch(() => undefined);
      return { state: 'failed', errorCode: code };
    }
  }

  /** حذف المحتوى والنتائج المنتهية (Q12). */
  async purgeExpired(): Promise<number> {
    const purged = await this.deps.store.purgeExpiredContent();
    if (purged > 0) logger.info({ purged }, 'حُذف محتوى رسائل تجاوز مدة الاحتفاظ');
    return purged;
  }

  /** تنظيف المحتوى الدوري (Q12): مستقل عن احتفاظ الهوية؛ يفشل بصمت مع تسجيل الخطأ. */
  startBackgroundTasks(intervalMs: number): void {
    void this.purgeExpired().catch((err: unknown) => {
      logger.error({ err: (err as Error).message }, 'فشل تنظيف المحتوى عند البدء');
    });
    if (this.purgeTimer) return;
    this.purgeTimer = setInterval(() => {
      void this.purgeExpired().catch((err: unknown) => {
        logger.error({ err: (err as Error).message }, 'فشل تنظيف المحتوى الدوري');
      });
    }, intervalMs);
    this.purgeTimer.unref?.();
  }

  stopBackgroundTasks(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = null;
  }

  /** مدة الاحتفاظ بالمحتوى مع تخزين مؤقت قصير لتفادي استعلام لكل رسالة. */
  private async retentionHours(userId: string): Promise<number> {
    const cached = this.retentionCache.get(userId);
    const now = Date.now();
    if (cached && now - cached.at < 60_000) return cached.hours;
    const hours = await this.deps.store.contentRetentionHours(userId);
    this.retentionCache.set(userId, { hours, at: now });
    return hours;
  }
}
