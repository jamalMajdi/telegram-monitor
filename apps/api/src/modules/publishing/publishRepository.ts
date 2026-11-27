/**
 * مخزن النشر: بوتات، وجهات، مسارات، حواف توجيه، وتسليمات.
 *
 * قواعد ثابتة في كل استعلام:
 * - كل قراءة/كتابة مقيّدة بـ`user_id` (عزل D02/D07).
 * - لا يُعاد أي رمز أو مغلّف رمز إلى طبقة الخدمة إلا عبر `findBot` (التحقق/الإرسال فقط).
 * - بناء الحواف وفحص الحلقات يتمّان داخل معاملة واحدة مع تغيير حالة المسار (ذرّية O05).
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { DEFAULT_ATTRIBUTION_CONFIG, type AttributionConfig, type AttributionMode } from './attribution.js';

type Executor = PoolClient | null;

async function run(sql: string, params: unknown[], client: Executor = null) {
  return client ? client.query(sql, params as never[]) : query(sql, params as never[]);
}

// ── البوتات ──────────────────────────────────────────────────────────────────

export type PublishBotStatus = 'active' | 'invalid' | 'disabled';

export interface PublishBotRow {
  id: string;
  userId: string;
  label: string;
  telegramId: string | null;
  username: string | null;
  status: PublishBotStatus;
  tokenKeyVersion: number;
  tokenFingerprint: string;
  verifiedAt: Date | null;
  lastErrorCode: string | null;
  tokenUpdatedAt: Date;
  createdAt: Date;
}

export interface PublishBotWithSecret extends PublishBotRow {
  tokenCiphertext: Buffer;
}

interface BotDbRow {
  id: string;
  user_id: string;
  label: string;
  telegram_id: string | number | null;
  username: string | null;
  status: PublishBotStatus;
  token_key_version: number;
  token_fingerprint: string;
  token_ciphertext?: Buffer;
  verified_at: Date | null;
  last_error_code: string | null;
  token_updated_at: Date;
  created_at: Date;
}

function mapBot(row: BotDbRow): PublishBotRow {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    telegramId: row.telegram_id === null ? null : String(row.telegram_id),
    username: row.username,
    status: row.status,
    tokenKeyVersion: row.token_key_version,
    tokenFingerprint: row.token_fingerprint,
    verifiedAt: row.verified_at,
    lastErrorCode: row.last_error_code,
    tokenUpdatedAt: row.token_updated_at,
    createdAt: row.created_at,
  };
}

const BOT_COLUMNS = `id, user_id, label, telegram_id, username, status, token_key_version,
  token_fingerprint, verified_at, last_error_code, token_updated_at, created_at`;

// ── الوجهات ──────────────────────────────────────────────────────────────────

export type DestinationStatus = 'pending' | 'active' | 'paused' | 'revoked' | 'error' | 'deleted';
export type DestinationChatKind = 'channel' | 'supergroup' | 'group';

export interface DestinationRow {
  id: string;
  userId: string;
  botId: string;
  chatId: string;
  chatKind: DestinationChatKind;
  title: string;
  username: string | null;
  canPostMessages: boolean;
  canEditMessages: boolean;
  memberStatus: string | null;
  status: DestinationStatus;
  verifiedAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
}

interface DestinationDbRow {
  id: string;
  user_id: string;
  bot_id: string;
  chat_id: string | number;
  chat_kind: DestinationChatKind;
  title: string;
  username: string | null;
  can_post_messages: boolean;
  can_edit_messages: boolean;
  member_status: string | null;
  status: DestinationStatus;
  verified_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
}

function mapDestination(row: DestinationDbRow): DestinationRow {
  return {
    id: row.id,
    userId: row.user_id,
    botId: row.bot_id,
    chatId: String(row.chat_id),
    chatKind: row.chat_kind,
    title: row.title,
    username: row.username,
    canPostMessages: row.can_post_messages,
    canEditMessages: row.can_edit_messages,
    memberStatus: row.member_status,
    status: row.status,
    verifiedAt: row.verified_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
  };
}

const DESTINATION_COLUMNS = `id, user_id, bot_id, chat_id, chat_kind, title, username,
  can_post_messages, can_edit_messages, member_status, status, verified_at, last_error_code, created_at`;

// ── المسارات ─────────────────────────────────────────────────────────────────

export type RouteStatus = 'draft' | 'active' | 'paused';
export type RoutePublishMode = 'auto' | 'review';
export type RouteLengthPolicy = 'split' | 'reject';
export type RouteScopeKind = 'source' | 'filter' | 'classification';

export interface RouteRow {
  id: string;
  userId: string;
  destinationId: string;
  name: string;
  templateId: string | null;
  templateName: string | null;
  publishMode: RoutePublishMode;
  lengthPolicy: RouteLengthPolicy;
  maxParts: number;
  /**
   * تجاوز هوية المصدر/المرسل لهذا المسار: null = وراثة إعداد المستخدم،
   * 'off' = إخفاء لهذه الوجهة وحدها، أو نمط صريح.
   */
  attributionMode: AttributionMode | null;
  status: RouteStatus;
  lastErrorCode: string | null;
  activatedAt: Date | null;
  createdAt: Date;
}

interface RouteDbRow {
  id: string;
  user_id: string;
  destination_id: string;
  name: string;
  template_id: string | null;
  template_name?: string | null;
  publish_mode: RoutePublishMode;
  length_policy: RouteLengthPolicy;
  max_parts: number;
  attribution_mode?: AttributionMode | null;
  status: RouteStatus;
  last_error_code: string | null;
  activated_at: Date | null;
  created_at: Date;
}

function mapRoute(row: RouteDbRow): RouteRow {
  return {
    id: row.id,
    userId: row.user_id,
    destinationId: row.destination_id,
    name: row.name,
    templateId: row.template_id,
    templateName: row.template_name ?? null,
    publishMode: row.publish_mode,
    lengthPolicy: row.length_policy,
    maxParts: row.max_parts,
    attributionMode: row.attribution_mode ?? null,
    status: row.status,
    lastErrorCode: row.last_error_code,
    activatedAt: row.activated_at,
    createdAt: row.created_at,
  };
}

export interface RouteScopeRow {
  id: string;
  kind: RouteScopeKind;
  sourceId: string | null;
  ruleSetId: string | null;
  /** عنوان/اسم العنصر للعرض (مصدر أو فلتر أو تصنيف). */
  label: string | null;
}

export interface RouteSourceRow {
  id: string;
  peerType: 'channel' | 'group';
  peerId: string;
  title: string;
  status: string;
}

export interface RoutingCandidateRow {
  routeId: string;
  destinationId: string;
  templateId: string | null;
  publishMode: RoutePublishMode;
  lengthPolicy: RouteLengthPolicy;
  maxParts: number;
  destinationTitle: string;
}

export interface DeliveryRow {
  id: string;
  userId: string;
  identityId: string;
  destinationId: string;
  routeId: string | null;
  templateId: string | null;
  planVersion: number;
  status: string;
  review: string;
  reviewReason: string | null;
  createdAt: Date;
}

export interface DeliveryListRow extends DeliveryRow {
  destinationTitle: string;
}

export type DeliveryStatus =
  | 'awaiting_review'
  | 'queued'
  | 'sending'
  | 'published'
  | 'partial'
  | 'failed'
  | 'uncertain'
  | 'blocked'
  | 'cancelled';

export interface PlanContext {
  deliveryId: string;
  identityId: string;
  userId: string;
  sourceId: string;
  templateId: string | null;
  lengthPolicy: RouteLengthPolicy;
  maxParts: number;
  planVersion: number;
  status: DeliveryStatus;
  review: string;
  /** نص الرسالة الأصلي (قد يكون null بعد انتهاء الاحتفاظ). */
  messageText: string | null;
  caption: string | null;
  retentionExpiresAt: Date | null;
  classificationName: string | null;
  /** هوية المصدر والمرسل لعرضها أسفل المنشور (مع إعداداتها الفعّالة). */
  /** اختياري دفاعياً: مخزن لا يوفّر السياق يجب ألا يُسقط النشر — الهوية تظهر فقط عند توفر بياناتها. */
  attribution?: AttributionContext;
}

export interface AttributionContext {
  /** تجاوز المسار (null = وراثة). */
  routeMode: AttributionMode | null;
  config: AttributionConfig;
  source: { title: string | null; username: string | null; peerId: string | null };
  sender: { id: string | null; username: string | null; displayName: string | null; postAuthor: string | null };
}

export interface IdentityRoutingContext {
  identityId: string;
  sourceId: string;
  reviewState: 'none' | 'needs_review' | 'reviewed';
  resolvedTemplateId: string | null;
  publishState: 'not_routed' | 'routed' | 'awaiting_review';
}

export interface PublishStore {
  // بوت
  findBot(userId: string): Promise<PublishBotWithSecret | null>;
  listBotView(userId: string): Promise<PublishBotRow | null>;
  upsertBot(input: {
    id: string;
    userId: string;
    label: string;
    telegramId: string | null;
    username: string | null;
    tokenCiphertext: Buffer;
    tokenKeyVersion: number;
    tokenFingerprint: string;
    verifiedAt: Date | null;
    lastErrorCode: string | null;
  }): Promise<PublishBotRow>;
  updateBotVerification(input: {
    userId: string;
    telegramId: string | null;
    username: string | null;
    status: PublishBotStatus;
    verifiedAt: Date | null;
    lastErrorCode: string | null;
  }): Promise<PublishBotRow | null>;
  setBotStatus(userId: string, status: PublishBotStatus, errorCode: string | null): Promise<void>;

  // وجهات
  listDestinations(userId: string): Promise<DestinationRow[]>;
  findDestination(id: string, userId: string): Promise<DestinationRow | null>;
  findDestinationByChatId(userId: string, chatId: string): Promise<DestinationRow | null>;
  countActiveDestinations(userId: string): Promise<number>;
  insertDestination(input: {
    userId: string;
    botId: string;
    chatId: string;
    chatKind: DestinationChatKind;
    title: string;
    username: string | null;
    canPostMessages: boolean;
    canEditMessages: boolean;
    memberStatus: string | null;
    status: DestinationStatus;
    verifiedAt: Date | null;
    lastErrorCode: string | null;
  }): Promise<DestinationRow>;
  updateDestinationVerification(input: {
    id: string;
    userId: string;
    title: string;
    username: string | null;
    canPostMessages: boolean;
    canEditMessages: boolean;
    memberStatus: string | null;
    status: DestinationStatus;
    verifiedAt: Date | null;
    lastErrorCode: string | null;
  }): Promise<DestinationRow | null>;
  setDestinationStatus(
    id: string,
    userId: string,
    status: DestinationStatus,
    errorCode: string | null,
    client?: PoolClient | null,
  ): Promise<void>;

  // مسارات
  listRoutes(userId: string): Promise<RouteRow[]>;
  findRoute(id: string, userId: string): Promise<RouteRow | null>;
  countRoutes(userId: string): Promise<number>;
  insertRoute(input: {
    userId: string;
    destinationId: string;
    name: string;
    templateId: string | null;
    publishMode: RoutePublishMode;
    lengthPolicy: RouteLengthPolicy;
    maxParts: number;
    attributionMode?: AttributionMode | null;
  }): Promise<RouteRow>;
  updateRoute(
    input: {
      id: string;
      userId: string;
      name: string;
      templateId: string | null;
      publishMode: RoutePublishMode;
      lengthPolicy: RouteLengthPolicy;
      maxParts: number;
      attributionMode?: AttributionMode | null;
    },
    client?: PoolClient | null,
  ): Promise<RouteRow | null>;
  setRouteStatus(
    id: string,
    userId: string,
    status: RouteStatus,
    errorCode: string | null,
    client?: PoolClient | null,
  ): Promise<void>;
  deleteRoute(id: string, userId: string, client?: PoolClient | null): Promise<boolean>;
  listScopes(routeIds: string[]): Promise<Map<string, RouteScopeRow[]>>;
  replaceScopes(
    userId: string,
    routeId: string,
    scopes: { kind: RouteScopeKind; targetId: string }[],
    client?: PoolClient | null,
  ): Promise<void>;
  listRouteSources(routeId: string): Promise<RouteSourceRow[]>;
  listUserSources(userId: string): Promise<RouteSourceRow[]>;

  // خطة الأجزاء (7-ج)
  loadPlanContext(deliveryId: string, userId: string): Promise<PlanContext | null>;
  loadExtractionFields(identityId: string): Promise<{ fieldKey: string; value: string; confidence: number }[]>;
  loadContactViews(identityId: string): Promise<{ kind: string; masked: string }[]>;
  loadTemplate(userId: string, templateId: string): Promise<{ id: string; name: string; fields: { fieldKey: string; label: string; enabled: boolean }[] } | null>;
  savePlan(input: {
    deliveryId: string;
    userId: string;
    parts: { index: number; html: string; visibleLength: number; textHash: string }[];
    charsTotal: number;
    maskingRewrites: number;
  }): Promise<void>;
  clearPlan(deliveryId: string, userId: string): Promise<void>;
  setDeliveryStatus(
    deliveryId: string,
    userId: string,
    status: DeliveryStatus,
    errorCode: string | null,
    client?: PoolClient | null,
  ): Promise<void>;

  // تحقق ملكية أهداف المسار والقالب (قبل أي كتابة تعتمد على مفاتيح أجنبية)
  describeScopeTargets(userId: string, ids: string[]): Promise<Map<string, 'source' | 'filter' | 'classification'>>;
  templateExists(userId: string, templateId: string): Promise<boolean>;

  // حواف وحلقات
  lockRoutingGraph(client: PoolClient): Promise<void>;
  replaceRouteEdges(
    client: PoolClient,
    input: {
      routeId: string;
      userId: string;
      destinationId: string;
      edges: { fromChatId: string; toChatId: string; sourceId: string | null }[];
    },
  ): Promise<void>;
  deleteRouteEdges(client: PoolClient, routeId: string): Promise<void>;
  findCyclePath(client: PoolClient, fromChatId: string, toChatId: string): Promise<boolean>;
  countEdges(userId: string): Promise<number>;
  countEdgesByRoute(userId: string): Promise<Map<string, number>>;

  // توجيه وتسليم
  listRoutingCandidates(input: {
    userId: string;
    sourceId: string;
    filterIds: string[];
    classificationId: string | null;
  }): Promise<RoutingCandidateRow[]>;
  identityRoutingContext(identityId: string, userId: string): Promise<IdentityRoutingContext | null>;
  effectiveClassificationId(identityId: string): Promise<string | null>;
  createDelivery(input: {
    userId: string;
    identityId: string;
    destinationId: string;
    routeId: string;
    templateId: string | null;
    reviewRequired: boolean;
    reviewReason: string | null;
    client?: PoolClient | null;
  }): Promise<string | null>;
  setIdentityPublishState(
    identityId: string,
    state: 'not_routed' | 'routed' | 'awaiting_review',
    client?: PoolClient | null,
  ): Promise<void>;
  listDeliveries(userId: string, limit: number): Promise<DeliveryListRow[]>;
}

export class PgPublishStore implements PublishStore {
  async findBot(userId: string): Promise<PublishBotWithSecret | null> {
    const res = await query<BotDbRow>(
      `select ${BOT_COLUMNS}, token_ciphertext from publish_bots where user_id = $1`,
      [userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { ...mapBot(row), tokenCiphertext: row.token_ciphertext! };
  }

  async listBotView(userId: string): Promise<PublishBotRow | null> {
    const res = await query<BotDbRow>(`select ${BOT_COLUMNS} from publish_bots where user_id = $1`, [userId]);
    const row = res.rows[0];
    return row ? mapBot(row) : null;
  }

  async upsertBot(input: {
    id: string;
    userId: string;
    label: string;
    telegramId: string | null;
    username: string | null;
    tokenCiphertext: Buffer;
    tokenKeyVersion: number;
    tokenFingerprint: string;
    verifiedAt: Date | null;
    lastErrorCode: string | null;
  }): Promise<PublishBotRow> {
    const res = await query<BotDbRow>(
      `insert into publish_bots
         (id, user_id, label, telegram_id, username, token_ciphertext, token_key_version,
          token_fingerprint, status, verified_at, last_error_code, token_updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, now())
       on conflict (user_id) do update set
         label = excluded.label,
         telegram_id = excluded.telegram_id,
         username = excluded.username,
         token_ciphertext = excluded.token_ciphertext,
         token_key_version = excluded.token_key_version,
         token_fingerprint = excluded.token_fingerprint,
         status = 'active',
         verified_at = excluded.verified_at,
         last_error_code = excluded.last_error_code,
         token_updated_at = now()
       returning ${BOT_COLUMNS}`,
      [
        input.id,
        input.userId,
        input.label,
        input.telegramId,
        input.username,
        input.tokenCiphertext,
        input.tokenKeyVersion,
        input.tokenFingerprint,
        input.verifiedAt,
        input.lastErrorCode,
      ],
    );
    return mapBot(res.rows[0]!);
  }

  async updateBotVerification(input: {
    userId: string;
    telegramId: string | null;
    username: string | null;
    status: PublishBotStatus;
    verifiedAt: Date | null;
    lastErrorCode: string | null;
  }): Promise<PublishBotRow | null> {
    const res = await query<BotDbRow>(
      `update publish_bots set
         telegram_id = coalesce($2, telegram_id),
         username = coalesce($3, username),
         status = $4,
         verified_at = $5,
         last_error_code = $6
       where user_id = $1
       returning ${BOT_COLUMNS}`,
      [input.userId, input.telegramId, input.username, input.status, input.verifiedAt, input.lastErrorCode],
    );
    const row = res.rows[0];
    return row ? mapBot(row) : null;
  }

  async setBotStatus(userId: string, status: PublishBotStatus, errorCode: string | null): Promise<void> {
    await query('update publish_bots set status = $2, last_error_code = $3 where user_id = $1', [
      userId,
      status,
      errorCode,
    ]);
  }

  async listDestinations(userId: string): Promise<DestinationRow[]> {
    const res = await query<DestinationDbRow>(
      `select ${DESTINATION_COLUMNS} from destinations
        where user_id = $1 and status <> 'deleted'
        order by created_at desc`,
      [userId],
    );
    return res.rows.map(mapDestination);
  }

  async findDestination(id: string, userId: string): Promise<DestinationRow | null> {
    const res = await query<DestinationDbRow>(
      `select ${DESTINATION_COLUMNS} from destinations where id = $1 and user_id = $2 and status <> 'deleted'`,
      [id, userId],
    );
    const row = res.rows[0];
    return row ? mapDestination(row) : null;
  }

  async findDestinationByChatId(userId: string, chatId: string): Promise<DestinationRow | null> {
    const res = await query<DestinationDbRow>(
      `select ${DESTINATION_COLUMNS} from destinations
        where user_id = $1 and chat_id = $2::bigint and status <> 'deleted'`,
      [userId, chatId],
    );
    const row = res.rows[0];
    return row ? mapDestination(row) : null;
  }

  async countActiveDestinations(userId: string): Promise<number> {
    const res = await query<{ c: number }>(
      "select count(*)::int as c from destinations where user_id = $1 and status <> 'deleted'",
      [userId],
    );
    return res.rows[0]?.c ?? 0;
  }

  async insertDestination(input: {
    userId: string;
    botId: string;
    chatId: string;
    chatKind: DestinationChatKind;
    title: string;
    username: string | null;
    canPostMessages: boolean;
    canEditMessages: boolean;
    memberStatus: string | null;
    status: DestinationStatus;
    verifiedAt: Date | null;
    lastErrorCode: string | null;
  }): Promise<DestinationRow> {
    const res = await query<DestinationDbRow>(
      `insert into destinations
         (user_id, bot_id, chat_id, chat_kind, title, username, can_post_messages, can_edit_messages,
          member_status, status, verified_at, last_error_code)
       values ($1, $2, $3::bigint, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning ${DESTINATION_COLUMNS}`,
      [
        input.userId,
        input.botId,
        input.chatId,
        input.chatKind,
        input.title,
        input.username,
        input.canPostMessages,
        input.canEditMessages,
        input.memberStatus,
        input.status,
        input.verifiedAt,
        input.lastErrorCode,
      ],
    );
    return mapDestination(res.rows[0]!);
  }

  async updateDestinationVerification(input: {
    id: string;
    userId: string;
    title: string;
    username: string | null;
    canPostMessages: boolean;
    canEditMessages: boolean;
    memberStatus: string | null;
    status: DestinationStatus;
    verifiedAt: Date | null;
    lastErrorCode: string | null;
  }): Promise<DestinationRow | null> {
    const res = await query<DestinationDbRow>(
      `update destinations set
         title = $3,
         username = $4,
         can_post_messages = $5,
         can_edit_messages = $6,
         member_status = $7,
         status = $8,
         verified_at = $9,
         last_error_code = $10
       where id = $1 and user_id = $2
       returning ${DESTINATION_COLUMNS}`,
      [
        input.id,
        input.userId,
        input.title,
        input.username,
        input.canPostMessages,
        input.canEditMessages,
        input.memberStatus,
        input.status,
        input.verifiedAt,
        input.lastErrorCode,
      ],
    );
    const row = res.rows[0];
    return row ? mapDestination(row) : null;
  }

  async setDestinationStatus(
    id: string,
    userId: string,
    status: DestinationStatus,
    errorCode: string | null,
    client: PoolClient | null = null,
  ): Promise<void> {
    await run(
      'update destinations set status = $3, last_error_code = $4 where id = $1 and user_id = $2',
      [id, userId, status, errorCode],
      client,
    );
  }

  async listRoutes(userId: string): Promise<RouteRow[]> {
    const res = await query<RouteDbRow>(
      `select r.id, r.user_id, r.destination_id, r.name, r.template_id, t.name as template_name,
              r.publish_mode, r.length_policy, r.max_parts, r.attribution_mode, r.status,
              r.last_error_code, r.activated_at, r.created_at
         from publish_routes r
         left join templates t on t.id = r.template_id
        where r.user_id = $1
        order by r.created_at desc`,
      [userId],
    );
    return res.rows.map(mapRoute);
  }

  async findRoute(id: string, userId: string): Promise<RouteRow | null> {
    const res = await query<RouteDbRow>(
      `select r.id, r.user_id, r.destination_id, r.name, r.template_id, t.name as template_name,
              r.publish_mode, r.length_policy, r.max_parts, r.attribution_mode, r.status,
              r.last_error_code, r.activated_at, r.created_at
         from publish_routes r
         left join templates t on t.id = r.template_id
        where r.id = $1 and r.user_id = $2`,
      [id, userId],
    );
    const row = res.rows[0];
    return row ? mapRoute(row) : null;
  }

  async countRoutes(userId: string): Promise<number> {
    const res = await query<{ c: number }>('select count(*)::int as c from publish_routes where user_id = $1', [
      userId,
    ]);
    return res.rows[0]?.c ?? 0;
  }

  async insertRoute(input: {
    userId: string;
    destinationId: string;
    name: string;
    templateId: string | null;
    publishMode: RoutePublishMode;
    lengthPolicy: RouteLengthPolicy;
    maxParts: number;
    attributionMode?: AttributionMode | null;
  }): Promise<RouteRow> {
    const res = await query<RouteDbRow>(
      `insert into publish_routes
         (user_id, destination_id, name, template_id, publish_mode, length_policy, max_parts, attribution_mode, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
       returning id, user_id, destination_id, name, template_id, null::text as template_name,
                 publish_mode, length_policy, max_parts, attribution_mode, status, last_error_code, activated_at, created_at`,
      [
        input.userId,
        input.destinationId,
        input.name,
        input.templateId,
        input.publishMode,
        input.lengthPolicy,
        input.maxParts,
        input.attributionMode ?? null,
      ],
    );
    return mapRoute(res.rows[0]!);
  }

  async updateRoute(
    input: {
      id: string;
      userId: string;
      name: string;
      templateId: string | null;
      publishMode: RoutePublishMode;
      lengthPolicy: RouteLengthPolicy;
      maxParts: number;
      attributionMode?: AttributionMode | null;
    },
    client: PoolClient | null = null,
  ): Promise<RouteRow | null> {
    const res = await run(
      `update publish_routes set
         name = $3, template_id = $4, publish_mode = $5, length_policy = $6, max_parts = $7,
         attribution_mode = $8
       where id = $1 and user_id = $2
       returning id, user_id, destination_id, name, template_id, null::text as template_name,
                 publish_mode, length_policy, max_parts, attribution_mode, status, last_error_code, activated_at, created_at`,
      [
        input.id,
        input.userId,
        input.name,
        input.templateId,
        input.publishMode,
        input.lengthPolicy,
        input.maxParts,
        input.attributionMode ?? null,
      ],
      client,
    );
    const row = res.rows[0] as RouteDbRow | undefined;
    return row ? mapRoute(row) : null;
  }

  async setRouteStatus(
    id: string,
    userId: string,
    status: RouteStatus,
    errorCode: string | null,
    client: PoolClient | null = null,
  ): Promise<void> {
    await run(
      `update publish_routes set status = $3::route_status, last_error_code = $4,
         activated_at = case when $3::text = 'active' then now() else activated_at end
       where id = $1 and user_id = $2`,
      [id, userId, status, errorCode],
      client,
    );
  }

  async deleteRoute(id: string, userId: string, client: PoolClient | null = null): Promise<boolean> {
    const res = await run('delete from publish_routes where id = $1 and user_id = $2', [id, userId], client);
    return (res.rowCount ?? 0) > 0;
  }

  async listScopes(routeIds: string[]): Promise<Map<string, RouteScopeRow[]>> {
    const out = new Map<string, RouteScopeRow[]>();
    if (routeIds.length === 0) return out;
    const res = await query<{
      route_id: string;
      id: string;
      kind: RouteScopeKind;
      source_id: string | null;
      rule_set_id: string | null;
      label: string | null;
    }>(
      `select s.route_id, s.id, s.kind, s.source_id, s.rule_set_id,
              coalesce(src.title, rs.name) as label
         from route_scopes s
         left join telegram_sources src on src.id = s.source_id
         left join rule_sets rs on rs.id = s.rule_set_id
        where s.route_id = any($1::uuid[])
        order by s.kind, label`,
      [routeIds],
    );
    for (const row of res.rows) {
      const list = out.get(row.route_id) ?? [];
      list.push({
        id: row.id,
        kind: row.kind,
        sourceId: row.source_id,
        ruleSetId: row.rule_set_id,
        label: row.label,
      });
      out.set(row.route_id, list);
    }
    return out;
  }

  async replaceScopes(
    userId: string,
    routeId: string,
    scopes: { kind: RouteScopeKind; targetId: string }[],
    client: PoolClient | null = null,
  ): Promise<void> {
    await run('delete from route_scopes where route_id = $1 and user_id = $2', [routeId, userId], client);
    for (const scope of scopes) {
      await run(
        `insert into route_scopes (user_id, route_id, kind, source_id, rule_set_id)
         values ($1, $2, $3, $4, $5)`,
        [
          userId,
          routeId,
          scope.kind,
          scope.kind === 'source' ? scope.targetId : null,
          scope.kind === 'source' ? null : scope.targetId,
        ],
        client,
      );
    }
  }

  async listRouteSources(routeId: string): Promise<RouteSourceRow[]> {
    const res = await query<{
      id: string;
      peer_type: 'channel' | 'group';
      peer_id: string | number;
      title: string;
      status: string;
    }>(
      `select src.id, src.peer_type, src.peer_id, src.title, src.status
         from route_scopes s
         join telegram_sources src on src.id = s.source_id
        where s.route_id = $1 and s.kind = 'source'`,
      [routeId],
    );
    return res.rows.map((row) => ({
      id: row.id,
      peerType: row.peer_type,
      peerId: String(row.peer_id),
      title: row.title,
      status: row.status,
    }));
  }

  async listUserSources(userId: string): Promise<RouteSourceRow[]> {
    const res = await query<{
      id: string;
      peer_type: 'channel' | 'group';
      peer_id: string | number;
      title: string;
      status: string;
    }>('select id, peer_type, peer_id, title, status from telegram_sources where user_id = $1', [userId]);
    return res.rows.map((row) => ({
      id: row.id,
      peerType: row.peer_type,
      peerId: String(row.peer_id),
      title: row.title,
      status: row.status,
    }));
  }

  async loadPlanContext(deliveryId: string, userId: string): Promise<PlanContext | null> {
    const res = await query<{
      delivery_id: string;
      identity_id: string;
      user_id: string;
      source_id: string;
      template_id: string | null;
      length_policy: RouteLengthPolicy;
      max_parts: number;
      plan_version: number;
      status: DeliveryStatus;
      review: string;
      message_text: string | null;
      caption: string | null;
      retention_expires_at: Date | null;
      classification_name: string | null;
      attribution_mode: AttributionMode | null;
      sender_id: string | null;
      sender_username: string | null;
      sender_display_name: string | null;
      post_author: string | null;
      source_title: string | null;
      source_username: string | null;
      source_peer_id: string | null;
      attribution_enabled: boolean | null;
      user_attribution_mode: AttributionConfig['mode'] | null;
      attribution_show_username: boolean | null;
      attribution_show_id: boolean | null;
    }>(
      `select dv.id as delivery_id, dv.identity_id, dv.user_id, mi.source_id, dv.template_id,
              coalesce(r.length_policy, 'split') as length_policy,
              coalesce(r.max_parts, 10) as max_parts,
              r.attribution_mode,
              dv.plan_version, dv.status, dv.review::text as review,
              c.message_text, c.caption, c.retention_expires_at,
              coalesce(man.classification_name, auto.classification_name) as classification_name,
              mi.sender_id::text as sender_id, mi.sender_username, mi.sender_display_name, mi.post_author,
              src.title as source_title, src.username as source_username, src.peer_id::text as source_peer_id,
              us.attribution_enabled, us.attribution_mode as user_attribution_mode,
              us.attribution_show_username, us.attribution_show_id
         from deliveries dv
         join message_identity mi on mi.id = dv.identity_id
         left join telegram_sources src on src.id = mi.source_id
         left join user_settings us on us.user_id = dv.user_id
         left join publish_routes r on r.id = dv.route_id
         left join message_content c on c.identity_id = dv.identity_id
         left join message_classification auto on auto.identity_id = dv.identity_id and auto.origin = 'automatic'
         left join message_classification man on man.identity_id = dv.identity_id and man.origin = 'manual'
        where dv.id = $1 and dv.user_id = $2`,
      [deliveryId, userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      deliveryId: row.delivery_id,
      identityId: row.identity_id,
      userId: row.user_id,
      sourceId: row.source_id,
      templateId: row.template_id,
      lengthPolicy: row.length_policy,
      maxParts: row.max_parts,
      planVersion: row.plan_version,
      status: row.status,
      review: row.review,
      messageText: row.message_text,
      caption: row.caption,
      retentionExpiresAt: row.retention_expires_at,
      classificationName: row.classification_name,
      attribution: {
        routeMode: row.attribution_mode ?? null,
        config: {
          enabled: row.attribution_enabled ?? DEFAULT_ATTRIBUTION_CONFIG.enabled,
          mode: row.user_attribution_mode ?? DEFAULT_ATTRIBUTION_CONFIG.mode,
          showUsername: row.attribution_show_username ?? DEFAULT_ATTRIBUTION_CONFIG.showUsername,
          showId: row.attribution_show_id ?? DEFAULT_ATTRIBUTION_CONFIG.showId,
        },
        source: {
          title: row.source_title ?? null,
          username: row.source_username ?? null,
          peerId: row.source_peer_id ?? null,
        },
        sender: {
          id: row.sender_id ?? null,
          username: row.sender_username ?? null,
          displayName: row.sender_display_name ?? null,
          postAuthor: row.post_author ?? null,
        },
      },
    };
  }

  async loadExtractionFields(identityId: string): Promise<{ fieldKey: string; value: string; confidence: number }[]> {
    const res = await query<{ field_key: string; value_text: string; confidence: string | number }>(
      `select field_key, value_text, confidence from message_extraction
        where identity_id = $1 order by span_start, field_key`,
      [identityId],
    );
    return res.rows.map((row) => ({
      fieldKey: row.field_key,
      value: row.value_text,
      confidence: Number(row.confidence),
    }));
  }

  async loadContactViews(identityId: string): Promise<{ kind: string; masked: string }[]> {
    // قيمة محجوبة فقط في كل الأحوال (O03).
    const res = await query<{ kind: string; masked: string }>(
      `select contact_kind::text as kind, value_masked as masked from message_contacts
        where identity_id = $1 order by span_start`,
      [identityId],
    );
    return res.rows;
  }

  async loadTemplate(
    userId: string,
    templateId: string,
  ): Promise<{ id: string; name: string; fields: { fieldKey: string; label: string; enabled: boolean }[] } | null> {
    const [head, fields] = await Promise.all([
      query<{ id: string; name: string }>('select id, name from templates where id = $1 and user_id = $2', [
        templateId,
        userId,
      ]),
      query<{ field_key: string; label: string; enabled: boolean }>(
        'select field_key, label, enabled from template_fields where template_id = $1 and user_id = $2 order by position',
        [templateId, userId],
      ),
    ]);
    const row = head.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      fields: fields.rows.map((field) => ({ fieldKey: field.field_key, label: field.label, enabled: field.enabled })),
    };
  }

  async savePlan(input: {
    deliveryId: string;
    userId: string;
    parts: { index: number; html: string; visibleLength: number; textHash: string }[];
    charsTotal: number;
    maskingRewrites: number;
  }): Promise<void> {
    await withTransaction(async (client) => {
      await client.query('delete from delivery_parts where delivery_id = $1', [input.deliveryId]);
      for (const part of input.parts) {
        await client.query(
          `insert into delivery_parts (delivery_id, part_index, text, text_hash, char_count, status)
           values ($1, $2, $3, $4, $5, 'pending')`,
          [input.deliveryId, part.index, part.html, part.textHash, part.visibleLength],
        );
      }
      await client.query(
        `update deliveries set chunk_count = $3, chars_total = $4, plan_version = plan_version + 1,
           last_error_code = null
         where id = $1 and user_id = $2`,
        [input.deliveryId, input.userId, input.parts.length, input.charsTotal],
      );
    });
  }

  async clearPlan(deliveryId: string, userId: string): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `delete from delivery_parts
          where delivery_id = (select id from deliveries where id = $1 and user_id = $2)`,
        [deliveryId, userId],
      );
      await client.query('update deliveries set chunk_count = 0, chars_total = 0 where id = $1 and user_id = $2', [
        deliveryId,
        userId,
      ]);
    });
  }

  async setDeliveryStatus(
    deliveryId: string,
    userId: string,
    status: DeliveryStatus,
    errorCode: string | null,
    client: PoolClient | null = null,
  ): Promise<void> {
    await run(
      `update deliveries set status = $3::delivery_status, last_error_code = $4,
         published_at = case when $3::text = 'published' then now() else published_at end
       where id = $1 and user_id = $2`,
      [deliveryId, userId, status, errorCode],
      client,
    );
  }

  async describeScopeTargets(
    userId: string,
    ids: string[],
  ): Promise<Map<string, 'source' | 'filter' | 'classification'>> {
    const out = new Map<string, 'source' | 'filter' | 'classification'>();
    if (ids.length === 0) return out;
    const res = await query<{ id: string; kind: 'source' | 'filter' | 'classification' }>(
      `select id::text as id, 'source'::text as kind from telegram_sources
        where user_id = $1 and id = any($2::uuid[])
       union all
       select id::text as id, kind::text as kind from rule_sets
        where user_id = $1 and id = any($2::uuid[])`,
      [userId, ids],
    );
    for (const row of res.rows) out.set(row.id, row.kind);
    return out;
  }

  async templateExists(userId: string, templateId: string): Promise<boolean> {
    const res = await query('select 1 from templates where id = $1 and user_id = $2', [templateId, userId]);
    return (res.rowCount ?? 0) > 0;
  }

  async lockRoutingGraph(client: PoolClient): Promise<void> {
    // قفل استشاري على مستوى المعاملة: يُسلسل كل تغييرات التوجيه دون قفل جداول الرسائل.
    await client.query("select pg_advisory_xact_lock(hashtext('routing-graph-v1')::bigint)");
  }

  async replaceRouteEdges(
    client: PoolClient,
    input: {
      routeId: string;
      userId: string;
      destinationId: string;
      edges: { fromChatId: string; toChatId: string; sourceId: string | null }[];
    },
  ): Promise<void> {
    await client.query('delete from routing_edges where route_id = $1', [input.routeId]);
    for (const edge of input.edges) {
      await client.query(
        `insert into routing_edges
           (from_chat_id, to_chat_id, route_id, user_id, source_id, destination_id)
         values ($1::bigint, $2::bigint, $3, $4, $5, $6)
         on conflict do nothing`,
        [edge.fromChatId, edge.toChatId, input.routeId, input.userId, edge.sourceId, input.destinationId],
      );
    }
  }

  async deleteRouteEdges(client: PoolClient, routeId: string): Promise<void> {
    await client.query('delete from routing_edges where route_id = $1', [routeId]);
  }

  /**
   * فحص الدورة: هل يمكن الوصول من `fromChatId` (الوجهة) إلى `toChatId` (المصدر) في الرسم الفعّال؟
   * التكرار محدود العمق ومحمي من الدورات داخل المسار نفسه، ويستخدم معرّفات فنية فقط.
   */
  async findCyclePath(client: PoolClient, fromChatId: string, toChatId: string): Promise<boolean> {
    if (fromChatId === toChatId) return true;
    const res = await client.query(
      `with recursive reach(chat_id, depth, path) as (
         select e.to_chat_id, 1, array[e.from_chat_id, e.to_chat_id]
           from routing_edges e
          where e.from_chat_id = $1::bigint
         union all
         select e.to_chat_id, r.depth + 1, r.path || e.to_chat_id
           from reach r
           join routing_edges e on e.from_chat_id = r.chat_id
          where r.depth < 20 and not (e.to_chat_id = any(r.path))
       )
       select 1 from reach where chat_id = $2::bigint limit 1`,
      [fromChatId, toChatId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async countEdgesByRoute(userId: string): Promise<Map<string, number>> {
    const res = await query<{ route_id: string; c: number }>(
      'select route_id, count(*)::int as c from routing_edges where user_id = $1 group by route_id',
      [userId],
    );
    const out = new Map<string, number>();
    for (const row of res.rows) out.set(row.route_id, row.c);
    return out;
  }

  async countEdges(userId: string): Promise<number> {
    const res = await query<{ c: number }>('select count(*)::int as c from routing_edges where user_id = $1', [
      userId,
    ]);
    return res.rows[0]?.c ?? 0;
  }

  async listRoutingCandidates(input: {
    userId: string;
    sourceId: string;
    filterIds: string[];
    classificationId: string | null;
  }): Promise<RoutingCandidateRow[]> {
    const res = await query<{
      route_id: string;
      destination_id: string;
      template_id: string | null;
      publish_mode: RoutePublishMode;
      length_policy: RouteLengthPolicy;
      max_parts: number;
      destination_title: string;
    }>(
      `select r.id as route_id, r.destination_id, r.template_id, r.publish_mode, r.length_policy,
              r.max_parts, d.title as destination_title
         from publish_routes r
         join destinations d on d.id = r.destination_id and d.user_id = r.user_id
        where r.user_id = $1
          and r.status = 'active'
          and d.status = 'active'
          and exists (
            select 1 from route_scopes s
             where s.route_id = r.id
               and (
                 (s.kind = 'source' and s.source_id = $2::uuid)
                 or (s.kind = 'filter' and s.rule_set_id = any($3::uuid[]))
                 or (s.kind = 'classification' and s.rule_set_id = $4::uuid)
               )
          )
        order by r.created_at`,
      [input.userId, input.sourceId, input.filterIds, input.classificationId],
    );
    return res.rows.map((row) => ({
      routeId: row.route_id,
      destinationId: row.destination_id,
      templateId: row.template_id,
      publishMode: row.publish_mode,
      lengthPolicy: row.length_policy,
      maxParts: row.max_parts,
      destinationTitle: row.destination_title,
    }));
  }

  async identityRoutingContext(identityId: string, userId: string): Promise<IdentityRoutingContext | null> {
    const res = await query<{
      identity_id: string;
      source_id: string;
      review_state: 'none' | 'needs_review' | 'reviewed';
      resolved_template_id: string | null;
      publish_state: 'not_routed' | 'routed' | 'awaiting_review';
    }>(
      `select mi.id as identity_id, mi.source_id, mi.review_state, mi.publish_state,
              mtr.template_id as resolved_template_id
         from message_identity mi
         left join message_template_resolution mtr on mtr.identity_id = mi.id
        where mi.id = $1 and mi.user_id = $2`,
      [identityId, userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      identityId: row.identity_id,
      sourceId: row.source_id,
      reviewState: row.review_state,
      resolvedTemplateId: row.resolved_template_id,
      publishState: row.publish_state,
    };
  }

  async effectiveClassificationId(identityId: string): Promise<string | null> {
    const res = await query<{ classification_id: string }>(
      `select classification_id from message_classification
        where identity_id = $1
        order by (origin = 'manual') desc
        limit 1`,
      [identityId],
    );
    return res.rows[0]?.classification_id ?? null;
  }

  async createDelivery(input: {
    userId: string;
    identityId: string;
    destinationId: string;
    routeId: string;
    templateId: string | null;
    reviewRequired: boolean;
    reviewReason: string | null;
    client?: PoolClient | null;
  }): Promise<string | null> {
    const res = (await run(
      `insert into deliveries
         (user_id, identity_id, destination_id, route_id, template_id, status, review, review_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (identity_id, destination_id) do nothing
       returning id`,
      [
        input.userId,
        input.identityId,
        input.destinationId,
        input.routeId,
        input.templateId,
        input.reviewRequired ? 'awaiting_review' : 'queued',
        input.reviewRequired ? 'pending' : 'not_required',
        input.reviewRequired ? (input.reviewReason ?? 'route') : null,
      ],
      input.client ?? null,
    )) as { rows: { id: string }[] };
    return res.rows[0]?.id ?? null;
  }

  async setIdentityPublishState(
    identityId: string,
    state: 'not_routed' | 'routed' | 'awaiting_review',
    client: PoolClient | null = null,
  ): Promise<void> {
    await run('update message_identity set publish_state = $2 where id = $1', [identityId, state], client);
  }

  async listDeliveries(userId: string, limit: number): Promise<DeliveryListRow[]> {
    const res = await query<{
      id: string;
      user_id: string;
      identity_id: string;
      destination_id: string;
      route_id: string | null;
      template_id: string | null;
      plan_version: number;
      status: string;
      review: string;
      review_reason: string | null;
      created_at: Date;
      destination_title: string;
    }>(
      `select dv.id, dv.user_id, dv.identity_id, dv.destination_id, dv.route_id, dv.template_id,
              dv.plan_version, dv.status, dv.review, dv.review_reason, dv.created_at,
              d.title as destination_title
         from deliveries dv
         join destinations d on d.id = dv.destination_id and d.user_id = dv.user_id
        where dv.user_id = $1
        order by dv.created_at desc
        limit $2`,
      [userId, limit],
    );
    return res.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      identityId: row.identity_id,
      destinationId: row.destination_id,
      routeId: row.route_id,
      templateId: row.template_id,
      planVersion: row.plan_version,
      status: row.status,
      review: row.review,
      reviewReason: row.review_reason,
      createdAt: row.created_at,
      destinationTitle: row.destination_title,
    }));
  }
}
