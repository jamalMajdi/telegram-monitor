/**
 * وجهات النشر (الدفعة 7-أ): إضافة قناة/مجموعة، التحقق من صلاحية البوت قبل أي نشر، إيقاف/استئناف/تعطيل.
 *
 * قواعد معتمدة:
 * - التحقق إلزامي: `getChat` لتثبيت الهوية الفنية (chat_id)، و`getChatMember` لإثبات حق النشر (D01).
 * - القناة تتطلب أن يكون البوت مشرفاً بحق `can_post_messages`؛ المجموعة تكفي فيها عضوية البوت.
 * - `403` من تيليجرام (طُرد البوت/سُحبت الصلاحية) ⇒ الحالة `revoked` وتُعطَّل مسارات الوجهة فوراً.
 * - الحذف تعطيل (Q15): يبقى السجل والتاريخ، وتُعطَّل المسارات وتُحذف حوافها.
 * - لا يُعاد أي رمز أو جزء منه في أي استجابة.
 */
import { recordAudit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { withTransaction } from '../../db/pool.js';
import type { BotApiClient, BotChatInfo, BotMemberInfo } from './botApiClient.js';
import { isDestinationChatId, normalizeChatId } from './loopGuard.js';
import type { PublishBotService } from './botService.js';
import type {
  DestinationChatKind,
  DestinationRow,
  DestinationStatus,
  PublishStore,
} from './publishRepository.js';
import { BotApiError } from './botApiClient.js';
import type { DestinationHealthStore } from './destinationHealth.js';

export interface DestinationView {
  id: string;
  chatId: string;
  chatKind: DestinationChatKind;
  title: string;
  username: string | null;
  status: DestinationStatus;
  canPostMessages: boolean;
  canEditMessages: boolean;
  memberStatus: string | null;
  verifiedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  /** إخفاقات متتالية في آخر تسليمات منتهية (0 = سليمة) — P0 تدقيق ما قبل التسليم. */
  failureStreak: number;
  lastFailureAt: string | null;
}

export interface DestinationServiceDeps {
  store: Pick<
    PublishStore,
    | 'listDestinations'
    | 'findDestination'
    | 'findDestinationByChatId'
    | 'countActiveDestinations'
    | 'insertDestination'
    | 'updateDestinationVerification'
    | 'setDestinationStatus'
    | 'listRoutes'
    | 'setRouteStatus'
    | 'deleteRouteEdges'
    | 'lockRoutingGraph'
  >;
  bots: Pick<PublishBotService, 'requireActiveBot' | 'mapBotApiError'>;
  botApi: BotApiClient;
  maxDestinationsPerUser: number;
  /** إحصاء سلاسل الإخفاقات (اختياري في الاختبارات الوحدوية). */
  health?: DestinationHealthStore;
}

export class DestinationService {
  constructor(private readonly deps: DestinationServiceDeps) {}

  toView(row: DestinationRow, stat?: { streak: number; lastFailureAt: Date | null }): DestinationView {
    return {
      id: row.id,
      chatId: row.chatId,
      chatKind: row.chatKind,
      title: row.title,
      username: row.username,
      status: row.status,
      canPostMessages: row.canPostMessages,
      canEditMessages: row.canEditMessages,
      memberStatus: row.memberStatus,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      createdAt: row.createdAt.toISOString(),
      failureStreak: stat?.streak ?? 0,
      lastFailureAt: stat?.lastFailureAt?.toISOString() ?? null,
    };
  }

  /**
   * قائمة الوجهات مع حالة صحتها.
   * إحصاء الإخفاقات **لا يُسقط القائمة**: تعذّر الحساب يعني أصفاراً لا خطأً للعميل.
   */
  async list(userId: string): Promise<DestinationView[]> {
    const rows = await this.deps.store.listDestinations(userId);
    const stats = await this.deps.health?.stats(userId).catch(() => new Map()) ?? new Map();
    return rows.map((row) => this.toView(row, stats.get(row.id)));
  }

  async get(userId: string, destinationId: string): Promise<DestinationView> {
    const row = await this.deps.store.findDestination(destinationId, userId);
    if (!row) throw notFound('الوجهة غير موجودة.');
    return this.toView(row);
  }

  /** إضافة وجهة بمعرّف نصي (@اسم) أو معرّف رقمي، مع تحقق صلاحيات فوري. */
  async add(input: {
    userId: string;
    identifier: string;
    ip?: string | null;
  }): Promise<DestinationView> {
    const bot = await this.deps.bots.requireActiveBot(input.userId);
    const identifier = normalizeIdentifier(input.identifier);

    const existingCount = await this.deps.store.countActiveDestinations(input.userId);
    if (existingCount >= this.deps.maxDestinationsPerUser) {
      throw conflict(
        'destination_limit_reached',
        `بلغت الحد الأقصى لعدد وجهات النشر (${this.deps.maxDestinationsPerUser}).`,
      );
    }

    const chat = await this.fetchChat(bot.token, identifier);
    if (chat.kind !== 'channel' && chat.kind !== 'supergroup' && chat.kind !== 'group') {
      throw badRequest(
        'unsupported_chat_type',
        'الوجهة يجب أن تكون قناة أو مجموعة. المحادثات الخاصة غير مدعومة للنشر.',
      );
    }
    const chatId = normalizeChatId(chat.chatId);
    if (!isDestinationChatId(chatId)) {
      throw badRequest('unsupported_chat_id', 'معرّف الوجهة غير صالح للنشر. استخدم قناة أو مجموعة.');
    }

    const duplicate = await this.deps.store.findDestinationByChatId(input.userId, chatId);
    if (duplicate) {
      throw conflict('destination_exists', 'هذه القناة/المجموعة مضافة مسبقاً كوجهة نشر.');
    }

    const member = await this.fetchMember(bot.token, chatId, bot.telegramId);
    const rights = evaluateRights(chat.kind, member);

    const created = await this.deps.store.insertDestination({
      userId: input.userId,
      botId: bot.bot.id,
      chatId,
      chatKind: chat.kind,
      title: chat.title,
      username: chat.username,
      canPostMessages: rights.canPost,
      canEditMessages: member?.canEditMessages ?? false,
      memberStatus: member?.status ?? null,
      status: rights.canPost ? 'active' : 'error',
      verifiedAt: rights.canPost ? new Date() : null,
      lastErrorCode: rights.canPost ? null : rights.errorCode,
    });

    await recordAudit({
      action: 'publishing.destination_added',
      actorUserId: input.userId,
      targetType: 'destination',
      targetId: created.id,
      ip: input.ip ?? null,
      metadata: { chatKind: chat.kind, status: created.status, errorCode: created.lastErrorCode },
    });
    return this.toView(created);
  }

  /** إعادة التحقق: يحدّث الصلاحيات، ويوقف الوجهة ومساراتها عند فقدها. */
  async verify(input: { userId: string; destinationId: string; ip?: string | null }): Promise<DestinationView> {
    const row = await this.requireOwned(input.userId, input.destinationId);
    const bot = await this.deps.bots.requireActiveBot(input.userId);

    let chat: BotChatInfo;
    try {
      chat = await this.deps.botApi.getChat(bot.token, row.chatId);
    } catch (err) {
      const revoked = err instanceof BotApiError && (err.code === 'chat_not_found' || err.code === 'forbidden');
      const updated = await this.deps.store.updateDestinationVerification({
        id: row.id,
        userId: input.userId,
        title: row.title,
        username: row.username,
        canPostMessages: false,
        canEditMessages: false,
        memberStatus: null,
        status: revoked ? 'revoked' : 'error',
        verifiedAt: null,
        lastErrorCode: err instanceof BotApiError ? err.code : 'unknown',
      });
      if (revoked) await this.pauseRoutesOfDestination(input.userId, row.id, 'destination_revoked');
      await recordAudit({
        action: 'publishing.destination_verified',
        actorUserId: input.userId,
        targetType: 'destination',
        targetId: row.id,
        outcome: 'failure',
        ip: input.ip ?? null,
        metadata: { errorCode: err instanceof BotApiError ? err.code : 'unknown' },
      }).catch(() => undefined);
      if (updated) return this.toView(updated);
      throw this.deps.bots.mapBotApiError(err);
    }

    let member: BotMemberInfo | null = null;
    try {
      member = await this.deps.botApi.getChatMember(bot.token, chat.chatId, bot.telegramId);
    } catch (err) {
      // لا عضوية ⇒ لا نشر؛ تُسجَّل الحالة صراحةً بدل افتراض الصلاحية.
      if (!(err instanceof BotApiError)) throw this.deps.bots.mapBotApiError(err);
      member = null;
    }
    const rights = evaluateRights(chat.kind, member);
    const updated = await this.deps.store.updateDestinationVerification({
      id: row.id,
      userId: input.userId,
      title: chat.title,
      username: chat.username,
      canPostMessages: rights.canPost,
      canEditMessages: member?.canEditMessages ?? false,
      memberStatus: member?.status ?? null,
      status: rights.canPost ? 'active' : 'error',
      verifiedAt: rights.canPost ? new Date() : null,
      lastErrorCode: rights.canPost ? null : rights.errorCode,
    });
    if (!rights.canPost) await this.pauseRoutesOfDestination(input.userId, row.id, 'destination_missing_rights');

    await recordAudit({
      action: 'publishing.destination_verified',
      actorUserId: input.userId,
      targetType: 'destination',
      targetId: row.id,
      outcome: rights.canPost ? 'success' : 'failure',
      ip: input.ip ?? null,
      metadata: { status: updated?.status ?? null, errorCode: updated?.lastErrorCode ?? null },
    });
    if (!updated) throw notFound('الوجهة غير موجودة.');
    return this.toView(updated);
  }

  /** إيقاف النشر إلى الوجهة (يبقى السجل والتحقق). */
  async pause(input: { userId: string; destinationId: string; ip?: string | null }): Promise<DestinationView> {
    const row = await this.requireOwned(input.userId, input.destinationId);
    await this.deps.store.setDestinationStatus(row.id, input.userId, 'paused', null);
    await this.pauseRoutesOfDestination(input.userId, row.id, 'destination_paused');
    await recordAudit({
      action: 'publishing.destination_paused',
      actorUserId: input.userId,
      targetType: 'destination',
      targetId: row.id,
      ip: input.ip ?? null,
    });
    return this.toView({ ...row, status: 'paused' });
  }

  /** استئناف النشر: يتحقق من الصلاحية مجدداً قبل إعادة التفعيل. */
  async resume(input: { userId: string; destinationId: string; ip?: string | null }): Promise<DestinationView> {
    const row = await this.requireOwned(input.userId, input.destinationId);
    const verified = await this.verify({ userId: input.userId, destinationId: input.destinationId, ip: input.ip ?? null });
    if (verified.status === 'active') {
      await recordAudit({
        action: 'publishing.destination_resumed',
        actorUserId: input.userId,
        targetType: 'destination',
        targetId: row.id,
        ip: input.ip ?? null,
      });
    }
    return verified;
  }

  /** حذف الوجهة = تعطيل مع إبقاء السجل (Q15)، مع تعطيل مساراتها وحذف حوافها. */
  async remove(input: { userId: string; destinationId: string; ip?: string | null }): Promise<void> {
    const row = await this.requireOwned(input.userId, input.destinationId);
    await withTransaction(async (client) => {
      await this.deps.store.lockRoutingGraph(client);
      const routes = await this.deps.store.listRoutes(input.userId);
      for (const route of routes.filter((r) => r.destinationId === row.id)) {
        await this.deps.store.deleteRouteEdges(client, route.id);
        await this.deps.store.setRouteStatus(route.id, input.userId, 'paused', 'destination_deleted');
      }
      await this.deps.store.setDestinationStatus(row.id, input.userId, 'deleted', 'deleted_by_user');
    });
    await recordAudit({
      action: 'publishing.destination_deleted',
      actorUserId: input.userId,
      targetType: 'destination',
      targetId: row.id,
      ip: input.ip ?? null,
    });
  }

  private async pauseRoutesOfDestination(userId: string, destinationId: string, code: string): Promise<void> {
    const routes = await this.deps.store.listRoutes(userId);
    for (const route of routes.filter((r) => r.destinationId === destinationId && r.status === 'active')) {
      await withTransaction(async (client) => {
        await this.deps.store.lockRoutingGraph(client);
        await this.deps.store.deleteRouteEdges(client, route.id);
        await this.deps.store.setRouteStatus(route.id, userId, 'paused', code);
      });
    }
  }

  private async requireOwned(userId: string, destinationId: string): Promise<DestinationRow> {
    const row = await this.deps.store.findDestination(destinationId, userId);
    if (!row) throw notFound('الوجهة غير موجودة.');
    return row;
  }

  private async fetchChat(token: string, identifier: string): Promise<BotChatInfo> {
    try {
      return await this.deps.botApi.getChat(token, identifier);
    } catch (err) {
      logger.warn(
        { method: 'getChat', code: err instanceof BotApiError ? err.code : 'unknown' },
        'فشل تحقق وجهة نشر',
      );
      throw this.deps.bots.mapBotApiError(err);
    }
  }

  private async fetchMember(token: string, chatId: string, botTelegramId: string): Promise<BotMemberInfo | null> {
    try {
      return await this.deps.botApi.getChatMember(token, chatId, botTelegramId);
    } catch (err) {
      if (err instanceof BotApiError) {
        logger.warn({ method: 'getChatMember', code: err.code }, 'تعذّر قراءة عضوية البوت في الوجهة');
        return null;
      }
      throw this.deps.bots.mapBotApiError(err);
    }
  }
}

/**
 * قواعد حق النشر:
 * - القناة: يجب أن يكون البوت مشرفاً ويملك `can_post_messages` (منشور القناة ليس عضوية عادية).
 * - المجموعة/المجموعة العظمى: عضوية أو إدارة تكفي، و`can_post_messages` لا ينطبق على الأعضاء العاديين.
 */
export function evaluateRights(
  kind: BotChatInfo['kind'],
  member: BotMemberInfo | null,
): { canPost: boolean; errorCode: string | null } {
  if (!member) return { canPost: false, errorCode: 'bot_not_member' };
  const status = member.status;
  const privileged = status === 'administrator' || status === 'creator';
  if (kind === 'channel') {
    if (privileged && member.canPostMessages) return { canPost: true, errorCode: null };
    if (privileged) return { canPost: false, errorCode: 'missing_post_rights' };
    return { canPost: false, errorCode: 'not_administrator' };
  }
  if (status === 'member' || privileged) return { canPost: true, errorCode: null };
  if (status === 'restricted' && member.canPostMessages) return { canPost: true, errorCode: null };
  return { canPost: false, errorCode: 'bot_not_member' };
}

/** تطبيع معرّف الوجهة: يقبل @name أو t.me/name أو معرّفاً رقمياً سالباً. */
export function normalizeIdentifier(raw: string): string {
  const value = raw.trim();
  if (!value) throw badRequest('invalid_destination_identifier', 'أدخل اسم القناة أو معرّفها.');
  if (/^-?\d{5,20}$/.test(value)) return BigInt(value).toString();
  const withoutUrl = value.replace(/^https?:\/\/t\.me\//i, '').replace(/^t\.me\//i, '');
  const username = withoutUrl.replace(/^@/, '').replace(/\/+$/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) {
    throw badRequest('invalid_destination_identifier', 'اسم القناة غير صالح. استخدم @username أو معرّفاً رقمياً.');
  }
  return `@${username}`;
}
