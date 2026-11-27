/**
 * مشغّل الاحتفاظ الوحيد داخل العملية (P4-د، Q23).
 *
 * - **سياسة واحدة، مكان واحد**: محتوى، هويات، تسليمات، أخطاء، تدقيق — بلا مؤقتات متفرقة.
 * - **كل تشغيل يُسجَّل**: صف في `retention_runs` لكل سياسة (كم حُذف، متى، وهل فشل).
 * - **لا تداخل**: تشغيل جديد يُتجاهل إن كان هناك تشغيل جارٍ (علم داخلي).
 * - **الفشل لا يوقف البقية**: سياسة تفشل تُسجَّل `error_code` وتُكمل الدورة.
 * - **النبض**: كل دورة تُسجّل `retention_scheduler` لتظهر في `/readyz` والمقاييس.
 */
import { recordErrorEvent } from '../../lib/errorLog.js';
import { logger } from '../../lib/logger.js';
import type { OpsService } from '../ops/opsService.js';
import type { PgRetentionStore, RetentionPolicy, RetentionRunRow, RetentionTrigger } from './retentionRepository.js';

export interface RetentionDeps {
  store: PgRetentionStore;
  /** حذف المحتوى المنتهي عبر خط المعالجة القائم (نفس الدلالات، بلا نسخة ثانية). */
  purgeContent: () => Promise<number>;
  /** حذف هويات الرسائل المنتهية عبر خدمة الالتقاط القائمة. */
  purgeIdentities: () => Promise<number>;
  /** نبض التشغيل (اختياري في الاختبارات). */
  ops?: OpsService;
  instance?: string;
  /** فاصل الدورة الدورية بالدقائق. */
  intervalMinutes?: number;
  now?: () => Date;
}

export interface RetentionCycleResult {
  runs: { policy: RetentionPolicy; deleted: number; errorCode: string | null }[];
  totalDeleted: number;
}

export const RETENTION_HEARTBEAT = 'retention_scheduler';
const DEFAULT_ERROR_DAYS = 30;
const DEFAULT_AUDIT_DAYS = 180;

/** رموز الفشل: آلية قصيرة تصلح لـ`retention_runs.error_code` (بلا نصوص حرة). */
function errorCodeOf(err: unknown): string {
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  if (message.includes('timeout')) return 'timeout';
  if (message.includes('deadlock')) return 'deadlock';
  if (message.includes('connect')) return 'connection_failed';
  return 'run_failed';
}

export class RetentionService {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly instance: string;

  constructor(private readonly deps: RetentionDeps) {
    this.instance = deps.instance ?? `retention-${process.pid}`;
  }

  /** دورة كاملة: كل السياسات، كل واحدة مسجَّلة على حدة. */
  async runCycle(triggeredBy: RetentionTrigger = 'scheduler'): Promise<RetentionCycleResult> {
    if (this.running) return { runs: [], totalDeleted: 0 };
    this.running = true;
    try {
      if (this.deps.ops) {
        await this.deps.ops
          .heartbeat(RETENTION_HEARTBEAT, this.instance, { owner: this.instance })
          .catch(() => undefined);
      }
      const errorDays = await this.deps.store.systemDays('system.error_events_retention_days', DEFAULT_ERROR_DAYS);
      const auditDays = await this.deps.store.systemDays('system.audit_retention_days', DEFAULT_AUDIT_DAYS);

      const policies: { policy: RetentionPolicy; run: () => Promise<number> }[] = [
        { policy: 'content', run: () => this.deps.purgeContent() },
        { policy: 'identities', run: () => this.deps.purgeIdentities() },
        { policy: 'deliveries', run: () => this.deps.store.purgeExpiredDeliveries() },
        { policy: 'error_events', run: () => this.deps.store.purgeErrorEvents(errorDays) },
        { policy: 'audit_events', run: () => this.deps.store.purgeAuditEvents(auditDays) },
      ];

      const runs: RetentionCycleResult['runs'] = [];
      let totalDeleted = 0;

      for (const { policy, run } of policies) {
        const runId = await this.deps.store.startRun(policy, triggeredBy);
        try {
          const deleted = await run();
          await this.deps.store.finishRun(runId, deleted, null);
          runs.push({ policy, deleted, errorCode: null });
          totalDeleted += deleted;
          if (deleted > 0) logger.info({ policy, deleted }, 'نُفِّذت سياسة احتفاظ');
        } catch (err) {
          const code = errorCodeOf(err);
          await this.deps.store.finishRun(runId, 0, code).catch(() => undefined);
          runs.push({ policy, deleted: 0, errorCode: code });
          logger.warn({ policy, code }, 'فشلت سياسة احتفاظ — تُكمل الدورة بلا توقف');
          await recordErrorEvent({
            scope: 'system',
            kind: 'retention_failed',
            code: code.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
            severity: 'warn',
            detail: `policy.${policy}`,
          });
        }
      }

      return { runs, totalDeleted };
    } finally {
      this.running = false;
    }
  }

  async listRuns(limit = 25): Promise<RetentionRunRow[]> {
    return this.deps.store.listRuns(limit);
  }

  /** تشغيل دوري واحد داخل العملية (Q23). المؤقت `unref` حتى لا يمنع الإغلاق. */
  start(): void {
    if (this.timer) return;
    const minutes = Math.max(1, this.deps.intervalMinutes ?? 60);
    const period = minutes * 60 * 1000;
    const tick = (): void => {
      void this.runCycle('scheduler').catch((err: unknown) => {
        logger.error({ err: (err as Error)?.message?.slice(0, 160) ?? 'unknown' }, 'دورة الاحتفاظ فشلت');
      });
    };
    this.timer = setInterval(tick, period);
    this.timer.unref?.();
    logger.info({ intervalMinutes: minutes }, 'مشغّل الاحتفاظ الدوري بدأ');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
