/**
 * مسارات النشر (الدفعة 7-ب): إنشاء/تعديل/تفعيل/تعطيل/حذف، وفحص الحلقات الذري (O05).
 *
 * ذرّية التفعيل والتعديل: قفل رسم التوجيه ← التحقق من الوجهة والشروط ← (كتابة التعديل) ←
 * بناء الحواف ← فحص الدورات ← تثبيت الحالة، كلها في معاملة واحدة. أي دورة تُلغي كل شيء
 * وتُعيد رفضاً محايداً بلا أي تفاصيل عن مسارات مستخدم آخر.
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import type { AttributionMode } from './attribution.js';
import { CYCLE_REJECTION_MESSAGE, sourceChatId } from './loopGuard.js';
import type {
  DestinationRow,
  PublishStore,
  RouteLengthPolicy,
  RoutePublishMode,
  RouteRow,
  RouteScopeKind,
  RouteStatus,
} from './publishRepository.js';

export interface RouteScopeView {
  kind: RouteScopeKind;
  targetId: string;
  label: string | null;
}

export interface RouteView {
  id: string;
  name: string;
  status: RouteStatus;
  destinationId: string;
  destinationTitle: string | null;
  destinationStatus: string | null;
  scopes: RouteScopeView[];
  templateId: string | null;
  templateName: string | null;
  publishMode: RoutePublishMode;
  lengthPolicy: RouteLengthPolicy;
  maxParts: number;
  /** تجاوز هوية المصدر/المرسل لهذا المسار فقط؛ null = يتبع إعداد المستخدم. */
  attributionMode: AttributionMode | null;
  lastErrorCode: string | null;
  activatedAt: string | null;
  createdAt: string;
  /** عدد حواف الرسم الفعّالة لهذا المسار (0 عندما لا يكون فعّالاً). */
  edgeCount: number;
}

export interface RouteInput {
  name: string;
  destinationId: string;
  scopes: { kind: RouteScopeKind; targetId: string }[];
  templateId?: string | null;
  publishMode?: RoutePublishMode;
  lengthPolicy?: RouteLengthPolicy;
  maxParts?: number;
  attributionMode?: AttributionMode | null;
}

export interface RouteServiceDeps {
  store: Pick<
    PublishStore,
    | 'listRoutes'
    | 'findRoute'
    | 'countRoutes'
    | 'insertRoute'
    | 'updateRoute'
    | 'setRouteStatus'
    | 'deleteRoute'
    | 'listScopes'
    | 'replaceScopes'
    | 'listRouteSources'
    | 'listUserSources'
    | 'findDestination'
    | 'listDestinations'
    | 'describeScopeTargets'
    | 'templateExists'
    | 'lockRoutingGraph'
    | 'replaceRouteEdges'
    | 'deleteRouteEdges'
    | 'findCyclePath'
    | 'countEdgesByRoute'
  >;
  maxRoutesPerUser: number;
}

const DEFAULT_MAX_PARTS = 10;

export class PublishRouteService {
  constructor(private readonly deps: RouteServiceDeps) {}

  async list(userId: string): Promise<RouteView[]> {
    const routes = await this.deps.store.listRoutes(userId);
    const scopes = await this.deps.store.listScopes(routes.map((route) => route.id));
    const destinations = await this.deps.store.listDestinations(userId);
    const byId = new Map(destinations.map((d) => [d.id, d]));
    const edgeCounts = await this.deps.store.countEdgesByRoute(userId);
    return routes.map((route) =>
      this.toView(route, scopes.get(route.id) ?? [], byId.get(route.destinationId) ?? null, edgeCounts.get(route.id) ?? 0),
    );
  }

  async get(userId: string, routeId: string): Promise<RouteView> {
    const route = await this.requireOwned(userId, routeId);
    const scopes = (await this.deps.store.listScopes([route.id])).get(route.id) ?? [];
    const destination = await this.deps.store.findDestination(route.destinationId, userId);
    const edgeCounts = await this.deps.store.countEdgesByRoute(userId);
    return this.toView(route, scopes, destination, edgeCounts.get(route.id) ?? 0);
  }

  async create(input: { userId: string; route: RouteInput; ip?: string | null }): Promise<RouteView> {
    const { userId, route } = input;
    const count = await this.deps.store.countRoutes(userId);
    if (count >= this.deps.maxRoutesPerUser) {
      throw conflict('route_limit_reached', `بلغت الحد الأقصى لعدد المسارات (${this.deps.maxRoutesPerUser}).`);
    }
    const destination = await this.deps.store.findDestination(route.destinationId, userId);
    if (!destination) throw notFound('الوجهة غير موجودة.');
    await this.validateScopes(userId, route.scopes);
    await this.validateTemplate(userId, route.templateId ?? null);

    const created = await this.deps.store.insertRoute({
      userId,
      destinationId: route.destinationId,
      name: route.name.trim(),
      templateId: route.templateId ?? null,
      publishMode: route.publishMode ?? 'auto',
      lengthPolicy: route.lengthPolicy ?? 'split',
      maxParts: route.maxParts ?? DEFAULT_MAX_PARTS,
      attributionMode: route.attributionMode ?? null,
    });
    await this.deps.store.replaceScopes(
      userId,
      created.id,
      route.scopes.map((scope) => ({ kind: scope.kind, targetId: scope.targetId })),
    );

    await recordAudit({
      action: 'publishing.route_created',
      actorUserId: userId,
      targetType: 'publish_route',
      targetId: created.id,
      ip: input.ip ?? null,
      metadata: {
        scopes: route.scopes.length,
        publishMode: created.publishMode,
        lengthPolicy: created.lengthPolicy,
      },
    });
    return this.get(userId, created.id);
  }

  /**
   * تعديل المسار. إن كان فعّالاً تُكتب التغييرات وتُعاد بناء الحواف ويُعاد فحص الدورات
   * في المعاملة نفسها؛ فشل الفحص يلغي التعديل كله (لا مسار فعّال بلا فحص سارٍ).
   */
  async update(input: { userId: string; routeId: string; route: RouteInput; ip?: string | null }): Promise<RouteView> {
    const { userId, routeId, route } = input;
    await this.requireOwned(userId, routeId);
    const destination = await this.deps.store.findDestination(route.destinationId, userId);
    if (!destination) throw notFound('الوجهة غير موجودة.');
    await this.validateScopes(userId, route.scopes);
    await this.validateTemplate(userId, route.templateId ?? null);

    const wasActive = await withTransaction(async (client) => {
      await this.deps.store.lockRoutingGraph(client);
      const existing = await this.deps.store.findRoute(routeId, userId);
      if (!existing) throw notFound('المسار غير موجود.');

      await this.deps.store.updateRoute(
        {
          id: routeId,
          userId,
          name: route.name.trim(),
          templateId: route.templateId ?? null,
          publishMode: route.publishMode ?? 'auto',
          lengthPolicy: route.lengthPolicy ?? 'split',
          maxParts: route.maxParts ?? DEFAULT_MAX_PARTS,
          attributionMode: route.attributionMode ?? null,
        },
        client,
      );
      await this.deps.store.replaceScopes(
        userId,
        routeId,
        route.scopes.map((scope) => ({ kind: scope.kind, targetId: scope.targetId })),
        client,
      );

      if (existing.status !== 'active') return false;
      await this.applyActivation(client, userId, routeId);
      return true;
    });

    await recordAudit({
      action: 'publishing.route_updated',
      actorUserId: userId,
      targetType: 'publish_route',
      targetId: routeId,
      ip: input.ip ?? null,
      metadata: { wasActive },
    });
    return this.get(userId, routeId);
  }

  async activate(input: { userId: string; routeId: string; ip?: string | null }): Promise<RouteView> {
    const { userId, routeId } = input;
    await withTransaction(async (client) => {
      await this.deps.store.lockRoutingGraph(client);
      await this.applyActivation(client, userId, routeId);
    });
    await recordAudit({
      action: 'publishing.route_activated',
      actorUserId: userId,
      targetType: 'publish_route',
      targetId: routeId,
      ip: input.ip ?? null,
    });
    return this.get(userId, routeId);
  }

  async deactivate(input: { userId: string; routeId: string; ip?: string | null }): Promise<RouteView> {
    const { userId, routeId } = input;
    const route = await this.requireOwned(userId, routeId);
    await withTransaction(async (client) => {
      await this.deps.store.lockRoutingGraph(client);
      await this.deps.store.deleteRouteEdges(client, route.id);
      await this.deps.store.setRouteStatus(route.id, userId, 'paused', 'deactivated_by_user', client);
    });
    await recordAudit({
      action: 'publishing.route_deactivated',
      actorUserId: userId,
      targetType: 'publish_route',
      targetId: routeId,
      ip: input.ip ?? null,
    });
    return this.get(userId, routeId);
  }

  async remove(input: { userId: string; routeId: string; ip?: string | null }): Promise<void> {
    const { userId, routeId } = input;
    const route = await this.requireOwned(userId, routeId);
    await withTransaction(async (client) => {
      await this.deps.store.lockRoutingGraph(client);
      await this.deps.store.deleteRouteEdges(client, route.id);
      await this.deps.store.deleteRoute(route.id, userId, client);
    });
    await recordAudit({
      action: 'publishing.route_deleted',
      actorUserId: userId,
      targetType: 'publish_route',
      targetId: routeId,
      ip: input.ip ?? null,
    });
  }

  // ── داخلي ──────────────────────────────────────────────────────────────────

  /**
   * يبني الحواف الفعّالة للمسار ويفحص الدورات ثم يثبّت الحالة `active`.
   * يجب أن يُنادى داخل معاملة تحمل قفل رسم التوجيه.
   */
  private async applyActivation(client: PoolClient, userId: string, routeId: string): Promise<void> {
    const route = await this.deps.store.findRoute(routeId, userId);
    if (!route) throw notFound('المسار غير موجود.');
    const destination: DestinationRow | null = await this.deps.store.findDestination(route.destinationId, userId);
    if (!destination) throw notFound('الوجهة غير موجودة.');
    if (destination.status !== 'active') {
      throw conflict('destination_not_active', 'لا يمكن تفعيل المسار قبل نجاح التحقق من صلاحية النشر في الوجهة.');
    }
    const scopes = (await this.deps.store.listScopes([route.id])).get(route.id) ?? [];
    if (scopes.length === 0) {
      throw badRequest('route_without_scopes', 'أضف شرطاً واحداً على الأقل (مصدر أو فلتر أو تصنيف) قبل التفعيل.');
    }

    // تقريب محافظ: مسار بشرط غير مصدر قد ينطبق على أي مصدر لدى المستخدم ⇒ تُبنى حواف كل مصادره.
    const hasNonSourceScope = scopes.some((scope) => scope.kind !== 'source');
    const sources = hasNonSourceScope
      ? await this.deps.store.listUserSources(userId)
      : await this.deps.store.listRouteSources(route.id);

    const edges = sources.map((source) => ({
      fromChatId: sourceChatId(source.peerType, source.peerId),
      toChatId: destination.chatId,
      sourceId: source.id,
    }));

    // دورة مباشرة: النشر إلى قناة نقرأ منها في المسار نفسه.
    if (edges.some((edge) => edge.fromChatId === edge.toChatId)) {
      throw conflict('routing_cycle_detected', CYCLE_REJECTION_MESSAGE);
    }

    await this.deps.store.replaceRouteEdges(client, {
      routeId: route.id,
      userId,
      destinationId: destination.id,
      edges,
    });
    for (const edge of edges) {
      // هل يمكن الوصول من الوجهة عائدةً إلى المصدر؟ إن نعم، فالحافة تُغلق دورة.
      const cyclic = await this.deps.store.findCyclePath(client, edge.toChatId, edge.fromChatId);
      if (cyclic) throw conflict('routing_cycle_detected', CYCLE_REJECTION_MESSAGE);
    }
    await this.deps.store.setRouteStatus(route.id, userId, 'active', null, client);
  }

  private async validateScopes(userId: string, scopes: { kind: RouteScopeKind; targetId: string }[]): Promise<void> {
    if (scopes.length === 0) {
      throw badRequest('route_without_scopes', 'المسار يحتاج شرطاً واحداً على الأقل.');
    }
    const targets = await this.deps.store.describeScopeTargets(
      userId,
      scopes.map((scope) => scope.targetId),
    );
    for (const scope of scopes) {
      const kind = targets.get(scope.targetId);
      // سبب واحد للرفض: لا نكشف إن كان العنصر موجوداً لمستخدم آخر أم غير موجود.
      if (!kind) throw notFound('أحد شروط المسار غير موجود أو لا تملكه.');
      if (kind !== scope.kind) throw badRequest('scope_kind_mismatch', 'نوع الشرط لا يطابق العنصر المحدَّد.');
    }
  }

  private async validateTemplate(userId: string, templateId: string | null): Promise<void> {
    if (!templateId) return;
    const exists = await this.deps.store.templateExists(userId, templateId);
    if (!exists) throw notFound('القالب غير موجود أو لا تملكه.');
  }

  private async requireOwned(userId: string, routeId: string): Promise<RouteRow> {
    const route = await this.deps.store.findRoute(routeId, userId);
    if (!route) throw notFound('المسار غير موجود.');
    return route;
  }

  private toView(
    route: RouteRow,
    scopes: { kind: RouteScopeKind; sourceId: string | null; ruleSetId: string | null; label: string | null }[],
    destination: { title: string; status: string } | null,
    edgeCount: number,
  ): RouteView {
    return {
      id: route.id,
      name: route.name,
      status: route.status,
      destinationId: route.destinationId,
      destinationTitle: destination?.title ?? null,
      destinationStatus: destination?.status ?? null,
      scopes: scopes.map((scope) => ({
        kind: scope.kind,
        targetId: scope.sourceId ?? scope.ruleSetId ?? '',
        label: scope.label,
      })),
      templateId: route.templateId,
      templateName: route.templateName,
      publishMode: route.publishMode,
      lengthPolicy: route.lengthPolicy,
      maxParts: route.maxParts,
      attributionMode: route.attributionMode,
      lastErrorCode: route.lastErrorCode,
      activatedAt: route.activatedAt?.toISOString() ?? null,
      createdAt: route.createdAt.toISOString(),
      edgeCount,
    };
  }
}
