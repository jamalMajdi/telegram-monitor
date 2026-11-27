/**
 * تركيب وحدة النشر: بوت واحد + وجهات + مسارات + محرك توجيه، بمخزن واحد وعميل Bot API واحد.
 *
 * الوضع «غير مهيأ»: إن غاب مفتاح تشفير رموز البوتات (`TG_BOT_ENC_KEY`)، تبقى القراءة متاحة
 * وتُرفض أي عملية ربط/تحقق بخطأ 503 صريح دون أي طلب خارجي (نفس نمط تكامل تيليجرام).
 */
import { env } from '../../config/env.js';
import { isBotCipherConfigured } from './botCipher.js';
import { HttpBotApiClient, type BotApiClient } from './botApiClient.js';
import { PublishBotService } from './botService.js';
import { PgDeliveryStore } from './deliveryStore.js';
import { DeliveryPlanner } from './deliveryPlanner.js';
import { DeliveryService } from './deliveryService.js';
import { DeliveryWorker } from './deliveryWorker.js';
import { DestinationService } from './destinationService.js';
import { PgDestinationHealth } from './destinationHealth.js';
import { PgPublishStore, type PublishStore } from './publishRepository.js';
import { PublishRouteService } from './routeService.js';
import { RoutingService } from './routingService.js';

export interface PublishingStatus {
  ready: boolean;
  reason: string | null;
  bot: Awaited<ReturnType<PublishBotService['view']>>;
  destinations: { total: number; active: number };
  routes: { total: number; active: number };
  deliveries: { total: number; awaitingReview: number };
}

export interface PublishingRuntimeOptions {
  botApi?: BotApiClient;
  store?: PublishStore;
  /** مخزن التنفيذ (7-د) — يُحقن في الاختبارات. */
  deliveryStore?: PgDeliveryStore;
  /** تعطيل العامل الافتراضي (الاختبارات لا تُشغّله إلا صراحة). */
  workerEnabled?: boolean;
  /** نبض حياة العامل (P4-ب) — يُمرَّر من كائن التشغيل. */
  heartbeat?: (meta: Record<string, unknown>) => Promise<void>;
}

export class PublishingRuntime {
  readonly ready: boolean;
  readonly reason: string | null;
  readonly bots: PublishBotService;
  readonly destinations: DestinationService;
  readonly routes: PublishRouteService;
  readonly routing: RoutingService;
  readonly planner: DeliveryPlanner;
  readonly deliveries: DeliveryService;
  /** عامل الإرسال (7-د): موجود دائماً، ولا يعمل إلا بـ startWorker(). */
  readonly worker: DeliveryWorker;
  private readonly workerEnabled: boolean;
  private readonly store: PublishStore;

  constructor(options: PublishingRuntimeOptions = {}) {
    const store = options.store ?? new PgPublishStore();
    const cipherConfigured = isBotCipherConfigured();
    const botApi = options.botApi ?? new HttpBotApiClient();
    this.store = store;
    this.ready = cipherConfigured;
    this.reason = cipherConfigured ? null : 'مفتاح تشفير رموز البوتات (TG_BOT_ENC_KEY) غير مهيأ.';

    this.bots = new PublishBotService({ store, botApi, cipherConfigured });
    this.destinations = new DestinationService({
      store,
      bots: this.bots,
      botApi,
      maxDestinationsPerUser: env.TG_MAX_DESTINATIONS_PER_USER,
    health: new PgDestinationHealth(),
    });
    this.routes = new PublishRouteService({ store, maxRoutesPerUser: env.TG_MAX_ROUTES_PER_USER });
    this.planner = new DeliveryPlanner({ store });
    this.routing = new RoutingService({ store, enabled: env.TG_ROUTING_ENABLED, planner: this.planner });

    const deliveryStore = options.deliveryStore ?? new PgDeliveryStore();
    // المخطِّط نفسه للتوجيه وإعادة النشر: مصدر واحد لبناء الأجزاء.
    this.deliveries = new DeliveryService({ store: deliveryStore, planner: this.planner });
    this.workerEnabled = options.workerEnabled ?? env.TG_PUBLISH_WORKER_ENABLED;
    this.worker = new DeliveryWorker({
      store: deliveryStore,
      botApi,
      bots: this.bots,
      leaseMs: env.TG_PUBLISH_LEASE_SECONDS * 1000,
      ...(options.heartbeat ? { heartbeat: options.heartbeat } : {}),
    });
  }

  async status(userId: string): Promise<PublishingStatus> {
    const [bot, destinations, routes, deliveries] = await Promise.all([
      this.bots.view(userId),
      this.destinations.list(userId),
      this.routes.list(userId),
      this.store.listDeliveries(userId, 100),
    ]);
    return {
      ready: this.ready,
      reason: this.reason,
      bot,
      destinations: {
        total: destinations.length,
        active: destinations.filter((d) => d.status === 'active').length,
      },
      routes: {
        total: routes.length,
        active: routes.filter((r) => r.status === 'active').length,
      },
      deliveries: {
        total: deliveries.length,
        awaitingReview: deliveries.filter((d) => d.status === 'awaiting_review').length,
      },
    };
  }

  /** يبدأ عامل الإرسال إن كان ممكناً: يحتاج مفتاح التشفير وعاملاً ممكّناً. */
  startWorker(): boolean {
    if (!this.workerEnabled || !this.ready) return false;
    this.worker.start(env.TG_PUBLISH_WORKER_INTERVAL_MS);
    return true;
  }

  stopWorker(): void {
    this.worker.stop();
  }

  async listDeliveries(userId: string, limit: number) {
    const rows = await this.store.listDeliveries(userId, limit);
    return rows.map((row) => ({
      id: row.id,
      identityId: row.identityId,
      destinationId: row.destinationId,
      destinationTitle: row.destinationTitle,
      routeId: row.routeId,
      status: row.status,
      review: row.review,
      reviewReason: row.reviewReason,
      planVersion: row.planVersion,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
