/**
 * تهيئة تكامل تيليجرام للتشغيل: بوابة واحدة + مدير اتصالات واحد + خدمة ربط واحدة.
 * وجود كائن واحد لكل منها يمنع إنشاء اتصالات أو عملاء مكررين للحساب نفسه.
 * إذا لم تكن بيانات التطبيق أو مفتاح التشفير مهيأة، يعمل النظام في وضع "غير مهيأ":
 * القراءة متاحة، وأي عملية ربط تُرفض برسالة 503 واضحة دون أي اتصال خارجي.
 */
import { env } from '../../config/env.js';
import { recordAudit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { PgConnectionRepository, type ConnectionRepository, type TelegramAccountStore } from './accountRepository.js';
import { readTelegramConfig, TELEPROTO_PACKAGE, TELEPROTO_VERSION } from './config.js';
import { TelegramConnectionManager } from './connectionManager.js';
import { createTelegramGateway } from './factory.js';
import type { TelegramGateway } from './gateway.js';
import { PgLoginChallengeStore } from './loginChallengeStore.js';
import { PgIngestStore } from './ingestRepository.js';
import { TelegramIngestService } from './ingestService.js';
import { FilterService } from '../processing/filterService.js';
import { PgRuleConfigRepository, type RuleConfigStore } from '../processing/ruleConfigRepository.js';
import { MessageProcessingService } from '../processing/messageProcessingService.js';
import { PgMessageProcessingStore } from '../processing/messageProcessingRepository.js';
import { ExtractionService } from '../processing/extraction/extractionService.js';
import { PgExtractionStore } from '../processing/extraction/extractionRepository.js';
import { ResultsService } from '../processing/resultsService.js';
import { PgResultsStore } from '../processing/resultsRepository.js';
import { PgTelegramSourceStore } from './sourceRepository.js';
import type { BotApiClient } from '../publishing/botApiClient.js';
import { PublishingRuntime } from '../publishing/runtime.js';
import { PgOpsStore } from '../ops/opsRepository.js';
import { OpsService, PUBLISH_WORKER } from '../ops/opsService.js';
import { TelegramSourceService } from './sourceService.js';
import { TelegramLoginService, type LoginLimits } from './loginService.js';
import { PgRetentionStore } from '../retention/retentionRepository.js';
import { RetentionService } from '../retention/retentionService.js';

/** بوابة بديلة عند غياب الإعداد: تفشل بوضوح ولا تحاول أي اتصال. */
class UnconfiguredGateway implements TelegramGateway {
  readonly libraryName = TELEPROTO_PACKAGE;
  readonly libraryVersion = TELEPROTO_VERSION;

  createAccountClient(): never {
    throw new Error('telegram_not_configured');
  }

  createLoginClient(): never {
    throw new Error('telegram_not_configured');
  }
}

export interface TelegramRuntime {
  ready: boolean;
  reason: string | null;
  gateway: TelegramGateway;
  /** true إذا كانت البوابة حقيقية (وليست البديل غير المهيأ). */
  usingRealGateway: boolean;
  manager: TelegramConnectionManager;
  logins: TelegramLoginService;
  sourceService: TelegramSourceService;
  ingest: TelegramIngestService;
  /** إعدادات المعالجة (الخطوة 5-أ): قواميس وفلاتر. */
  ruleConfig: RuleConfigStore;
  /** خدمة الفلترة: قرار حتمي لكل رسالة بحسب إصدار الإعدادات. */
  filters: FilterService;
  /** خط المعالجة (5-ب): فحص المحتوى ← فلترة ← حفظ المطابق فقط. */
  processing: MessageProcessingService;
  /** الاستخراج المقيَّد بالقرائن واكتشاف فئات التواصل (5-ج). */
  extraction: ExtractionService;
  /** التصنيف الحتمي واختيار القالب ونتائج المراجعة (6-أ/6-ب). */
  results: ResultsService;
  /** النشر (المرحلة الثالثة): بوت، وجهات، مسارات، ومحرك توجيه. */
  publishing: PublishingRuntime;
  /** التشغيل (P4-ب): الجهوزية والمقاييس والنبض. */
  ops: OpsService;
  /** الاحتفاظ (P4-د): مشغّل السياسات الوحيد داخل العملية. */
  retention: RetentionService;
  accounts: TelegramAccountStore & ConnectionRepository;
  /** يعيد توصيل الحسابات النشطة التي لها جلسة محفوظة (D03/O01). */
  restoreActiveAccounts: () => Promise<{ attempted: number; connected: number; failed: number }>;
}

export function loginLimitsFromEnv(): LoginLimits {
  return {
    ttlMinutes: env.TG_LOGIN_TTL_MINUTES,
    maxCodeAttempts: env.TG_LOGIN_MAX_CODE_ATTEMPTS,
    maxPasswordAttempts: env.TG_LOGIN_MAX_PASSWORD_ATTEMPTS,
    maxResends: env.TG_LOGIN_MAX_RESENDS,
    resendIntervalSeconds: env.TG_LOGIN_RESEND_INTERVAL_SECONDS,
  };
}

export function createTelegramRuntime(
  options: { gateway?: TelegramGateway; botApi?: BotApiClient; publishing?: PublishingRuntime } = {},
): TelegramRuntime {
  const config = readTelegramConfig();
  let gateway: TelegramGateway | null = options.gateway ?? null;
  if (!gateway && config.ready) {
    try {
      gateway = createTelegramGateway().gateway;
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'تعذّر إنشاء بوابة تيليجرام');
    }
  }
  const usingRealGateway = Boolean(gateway);
  const effectiveGateway: TelegramGateway = gateway ?? new UnconfiguredGateway();

  const accounts = new PgConnectionRepository();
  const sourceStore = new PgTelegramSourceStore();
  const ruleConfig = new PgRuleConfigRepository();
  const filters = new FilterService(ruleConfig);
  const extraction = new ExtractionService(new PgExtractionStore(), env.TG_EXTRACTION_ENABLED);
  const results = new ResultsService({ results: new PgResultsStore(), config: ruleConfig });
  // وحدة النشر تُركَّب مرة واحدة؛ محرك التوجيه يُمرَّر لخط المعالجة ليُنشئ التسليمات (7-ب).
  // التشغيل أولاً: وحدة النشر تحتاج نبضها، والتطبيق يعرض مقاييسها.
  const ops = new OpsService({ store: new PgOpsStore() });
  const workerInstance = `worker-${process.pid}`;
  const publishing =
    options.publishing ??
    new PublishingRuntime({
      ...(options.botApi ? { botApi: options.botApi } : {}),
      heartbeat: (meta) => ops.heartbeat(PUBLISH_WORKER, workerInstance, meta),
    });
  const processing = new MessageProcessingService({
    store: new PgMessageProcessingStore(),
    filters,
    enabled: env.TG_PROCESSING_ENABLED,
    extraction,
    results,
    routing: publishing.routing,
  });
  // مرجع مؤجَّل: المدير يحتاج خدمة الالتقاط، والخدمة تحتاج حالة المدير للقراءة فقط.
  let ingestRef: TelegramIngestService | null = null;
  const manager = new TelegramConnectionManager({
    gateway: effectiveGateway,
    repository: accounts,
    onMessage: (message) => (ingestRef ? ingestRef.handle(message) : undefined),
    maxReconnectAttempts: config.maxReconnectAttempts,
    reconnectBaseDelayMs: config.reconnectBaseDelayMs,
  });
  const ingest = new TelegramIngestService({
    store: new PgIngestStore(),
    accounts,
    connections: manager,
    maxAttempts: env.TG_INGEST_MAX_ATTEMPTS,
    identityRetentionDays: env.TG_INGEST_IDENTITY_RETENTION_DAYS,
    enabled: env.TG_INGEST_ENABLED,
    processing,
  });
  ingestRef = ingest;
  // مشغّل الاحتفاظ الوحيد (Q23): يستخدم خط المعالجة والالتقاط القائمين بدل نسخ المنطق.
  const retention = new RetentionService({
    store: new PgRetentionStore(),
    purgeContent: () => processing.purgeExpired(),
    purgeIdentities: () => ingest.purgeExpiredIdentities(),
    ops,
    instance: `retention-${process.pid}`,
    intervalMinutes: env.TG_RETENTION_INTERVAL_MINUTES,
  });
  const logins = new TelegramLoginService({
    gateway,
    accounts,
    challenges: new PgLoginChallengeStore(),
    connections: manager,
    limits: loginLimitsFromEnv(),
    sources: sourceStore,
  });
  const sourceService = new TelegramSourceService({
    sources: sourceStore,
    accounts,
    connections: manager,
    maxSourcesPerAccount: env.TG_MAX_SOURCES_PER_ACCOUNT,
  });

  const restoreActiveAccounts = async (): Promise<{ attempted: number; connected: number; failed: number }> => {
    if (!usingRealGateway) return { attempted: 0, connected: 0, failed: 0 };
    const rows = await accounts.listAccountsForRestore();
    let connected = 0;
    let failed = 0;
    // توصيل متحفظ: ثلاث حسابات في وقت واحد فقط، بلا حلقات إعادة محاولة إضافية.
    const queue = [...rows];
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        try {
          const state = await manager.connect(row.id, row.userId);
          if (state.phase === 'connected') connected += 1;
          else failed += 1;
        } catch (err) {
          failed += 1;
          logger.warn(
            { accountId: row.id, err: err instanceof Error ? err.message : String(err) },
            'فشل استعادة اتصال حساب تيليجرام',
          );
        }
      }
    });
    await Promise.all(workers);
    await recordAudit({
      action: 'telegram.connections_restored',
      outcome: failed === 0 ? 'success' : 'failure',
      metadata: { attempted: rows.length, connected, failed },
    }).catch(() => undefined);
    return { attempted: rows.length, connected, failed };
  };

  return {
    ready: usingRealGateway,
    reason: usingRealGateway ? null : (config.reason ?? 'تكامل تيليجرام غير مهيأ.'),
    gateway: effectiveGateway,
    usingRealGateway,
    manager,
    logins,
    sourceService,
    ingest,
    ruleConfig,
    filters,
    processing,
    extraction,
    results,
    publishing,
    ops,
    retention,
    accounts,
    restoreActiveAccounts,
  };
}
