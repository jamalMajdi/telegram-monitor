/**
 * خدمة التشغيل (P4-ب): الجهوزية والمقاييس والنبض — لمصلحة systemd/nginx والمدير، بلا محتوى ولا أسرار.
 *
 * قرارات معتمدة:
 * - Q17: `/healthz` و`/readyz` عامّتان مختصرتان، والمقاييس التفصيلية للمدير فقط (`/admin/metrics`).
 * - Q18: الحياة تُقرأ من نبض مسجَّل في قاعدة البيانات، لا من ذاكرة العملية.
 * - Q26: عتبة «العامل متوقف» قابلة للضبط (TG_OPS_WORKER_STALE_SECONDS، افتراضي 120).
 */
import { checkDatabase } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import type { HeartbeatRow, OpsStore } from './opsRepository.js';

export const PUBLISH_WORKER = 'publish_worker';

export type ReadinessState = 'ok' | 'stale' | 'missing';

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  database: { ok: boolean; latencyMs: number | null };
  publishWorker: { state: ReadinessState; lastSeenSeconds: number | null };
  queue: { pendingParts: number; oldestPendingAgeSeconds: number | null };
  checkedAt: string;
}

export interface OpsMetrics extends ReadinessReport {
  deliveries24h: { published: number; failed: number; uncertain: number; partial: number; blocked: number };
  attempts1h: { retryable: number; permanent: number; uncertain: number; total: number };
  ingest: {
    lastMessageAt: string | null;
    messagesLast24h: number;
    accountsTotal: number;
    accountsActive: number;
    accountsNeedsReauth: number;
  };
  heartbeats: { name: string; instance: string; lastSeenSeconds: number; meta: Record<string, unknown> }[];
  staleAfterSeconds: number;
}

export class OpsService {
  constructor(
    private readonly deps: {
      store: Pick<OpsStore, 'upsertHeartbeat' | 'listHeartbeats' | 'queue' | 'deliveryWindow' | 'attemptWindow' | 'ingest'>;
      staleAfterSeconds?: number;
      clock?: () => number;
    },
  ) {}

  private get now(): number {
    return this.deps.clock ? this.deps.clock() : Date.now();
  }

  get staleAfterSeconds(): number {
    return this.deps.staleAfterSeconds ?? env.TG_OPS_WORKER_STALE_SECONDS;
  }

  /** يُسجّل نبض دورة عامل. فشله لا يُسقط الدورة (يُسجَّل تحذيراً فقط). */
  async heartbeat(name: string, instance: string, meta: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.deps.store.upsertHeartbeat({ name, instance, meta });
    } catch (err) {
      logger.warn({ err: (err as Error).message, name }, 'تعذّر تسجيل نبض العامل');
    }
  }

  private workerState(heartbeats: HeartbeatRow[]): { state: ReadinessState; lastSeenSeconds: number | null } {
    const mine = heartbeats.filter((item) => item.name === PUBLISH_WORKER);
    if (mine.length === 0) return { state: 'missing', lastSeenSeconds: null };
    const newest = mine.reduce((latest, item) => (item.lastSeenAt > latest ? item.lastSeenAt : latest), mine[0]!.lastSeenAt);
    const seconds = Math.max(0, Math.round((this.now - newest.getTime()) / 1000));
    return { state: seconds <= this.staleAfterSeconds ? 'ok' : 'stale', lastSeenSeconds: seconds };
  }

  async readiness(): Promise<ReadinessReport> {
    const startedAt = Date.now();
    const [dbOk, queue, heartbeats] = await Promise.all([
      checkDatabase().then(
        () => ({ ok: true, latencyMs: Date.now() - startedAt }),
        (err: unknown) => {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, 'فحص جهوزية قاعدة البيانات فشل');
          return { ok: false, latencyMs: null };
        },
      ),
      this.deps.store.queue().catch(() => ({ pendingParts: 0, deliveriesQueued: 0, oldestPendingAgeSeconds: null })),
      this.deps.store.listHeartbeats().catch(() => [] as HeartbeatRow[]),
    ]);
    const worker = this.workerState(heartbeats);
    return {
      // الجهوزية تسقط فقط بسقوط قاعدة البيانات؛ توقف العامل يُبلَّغ عنه ولا يجعل الخادم «غير جاهز»
      // لأن واجهات القراءة والكتابة تبقى صحيحة (والتنبيه يتولّى العامل — Q26).
      status: dbOk.ok ? 'ok' : 'degraded',
      database: dbOk,
      publishWorker: worker,
      queue: { pendingParts: queue.pendingParts, oldestPendingAgeSeconds: queue.oldestPendingAgeSeconds },
      checkedAt: new Date(this.now).toISOString(),
    };
  }

  async metrics(): Promise<OpsMetrics> {
    const [readiness, deliveries, attempts, ingest, heartbeats] = await Promise.all([
      this.readiness(),
      this.deps.store.deliveryWindow(24),
      this.deps.store.attemptWindow(1),
      this.deps.store.ingest(),
      this.deps.store.listHeartbeats(),
    ]);
    return {
      ...readiness,
      deliveries24h: deliveries,
      attempts1h: attempts,
      ingest: {
        lastMessageAt: ingest.lastMessageAt ? ingest.lastMessageAt.toISOString() : null,
        messagesLast24h: ingest.messagesLast24h,
        accountsTotal: ingest.accountsTotal,
        accountsActive: ingest.accountsActive,
        accountsNeedsReauth: ingest.accountsNeedsReauth,
      },
      heartbeats: heartbeats.map((item) => ({
        name: item.name,
        instance: item.instance,
        lastSeenSeconds: Math.max(0, Math.round((this.now - item.lastSeenAt.getTime()) / 1000)),
        meta: item.meta,
      })),
      staleAfterSeconds: this.staleAfterSeconds,
    };
  }
}
