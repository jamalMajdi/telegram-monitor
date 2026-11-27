/**
 * خدمة إدارة مصادر المراقبة (§4، §12.3).
 *
 * القيود المطبقة:
 * - كل عملية مقيّدة بمالك المصدر والحساب المرتبط به (عزل بين المستخدمين).
 * - لا قراءة إلا عبر عميل الحساب المتصل نفسه (Connection Manager) ولا اتصال ثانٍ للحساب.
 * - لا استيراد تاريخ ولا قراءة رسائل: العمليات هنا وصفية فقط (قائمة المحادثات/حل اسم/عضوية).
 * - الهوية ثابتة: (نوع، معرّف رقمي)، واسم المستخدم للعرض فقط.
 * - مصدر واحد لكل مستخدم لكل هوية (O01)، وفترات التفعيل/الإيقاف مسجّلة.
 */
import { recordAudit } from '../../lib/audit.js';
import { ApiError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { TelegramConnectionManager } from './connectionManager.js';
import type { ConnectionRepository, TelegramAccountStore } from './accountRepository.js';
import { classifyTelegramError } from './errors.js';
import type { AvailableSource, SourcePeerType } from './gateway.js';
import type { TelegramSourceRecord, TelegramSourceStore } from './sourceRepository.js';

export interface SourceView {
  id: string;
  accountId: string;
  accountLabel: string;
  accountStatus: string;
  peerType: SourcePeerType;
  peerId: string;
  title: string;
  username: string | null;
  status: 'active' | 'paused';
  includeOwnMessages: boolean;
  monitoringStartedAt: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  /** حالة اتصال الحساب القارئ كما يراها مدير الاتصالات. */
  connectionPhase: string;
}

export interface AvailableSourceView extends AvailableSource {
  alreadyMonitored: boolean;
  monitoringSourceId: string | null;
}

export interface SourceServiceDeps {
  sources: TelegramSourceStore;
  accounts: TelegramAccountStore & Pick<ConnectionRepository, 'deleteSession'>;
  connections: Pick<TelegramConnectionManager, 'connect' | 'getState' | 'runWithClient'>;
  /** حد عدد المصادر لكل حساب (D11: ملف إطلاق 25 مصدراً لكل حساب، قابل للرفع بعد القياس). */
  maxSourcesPerAccount: number;
}

export class TelegramSourceService {
  constructor(private readonly deps: SourceServiceDeps) {}

  // ── القراءة ──────────────────────────────────────────────────────────────
  async list(userId: string): Promise<SourceView[]> {
    const rows = await this.deps.sources.listByUser(userId);
    return rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      accountLabel: row.accountLabel,
      accountStatus: row.accountStatus,
      peerType: row.peerType,
      peerId: row.peerId,
      title: row.title,
      username: row.username,
      status: row.status,
      includeOwnMessages: row.includeOwnMessages,
      monitoringStartedAt: row.monitoringStartedAt?.toISOString() ?? null,
      lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      createdAt: row.createdAt.toISOString(),
      connectionPhase: this.deps.connections.getState(row.accountId, userId)?.phase ?? 'unknown',
    }));
  }

  async get(userId: string, sourceId: string): Promise<SourceView> {
    const record = await this.requireOwned(sourceId, userId);
    const view = (await this.list(userId)).find((row) => row.id === record.id);
    if (!view) throw notFound('المصدر غير موجود.');
    return view;
  }

  /** قائمة القنوات والمجموعات المتاحة للحساب مع تمييز المُضاف منها. */
  async listAvailable(input: {
    userId: string;
    accountId: string;
    limit?: number;
  }): Promise<AvailableSourceView[]> {
    await this.requireOwnedAccount(input.accountId, input.userId);
    const state = await this.ensureConnected(input.accountId, input.userId);
    void state;
    const existing = await this.deps.sources.listByUser(input.userId);
    const byPeer = new Map(existing.map((row) => [`${row.peerType}:${row.peerId}`, row.id]));

    const available = await this.withTelegramError(() =>
      this.deps.connections.runWithClient(input.accountId, input.userId, (client) =>
        client.listAvailableSources(input.limit ? { limit: input.limit } : {}),
      ),
    );
    return available.map((item) => {
      const sourceId = byPeer.get(`${item.peerType}:${item.peerId}`) ?? null;
      return { ...item, alreadyMonitored: Boolean(sourceId), monitoringSourceId: sourceId };
    });
  }

  // ── الإضافة ──────────────────────────────────────────────────────────────
  /** إضافة مصدر بمعرّف نصي (@username أو t.me/... أو معرّف رقمي). */
  async addByIdentifier(input: { userId: string; accountId: string; identifier: string }): Promise<SourceView> {
    const account = await this.requireAddableAccount(input.accountId, input.userId);
    const resolved = await this.withTelegramError(() => {
      return this.deps.connections.runWithClient(input.accountId, input.userId, (client) =>
        client.resolveSource(input.identifier),
      );
    });
    return this.createSource({
      userId: input.userId,
      accountId: account.id,
      peerType: resolved.peerType,
      peerId: resolved.peerId,
      title: resolved.title,
      username: resolved.username,
      accessible: resolved.accessible,
      reason: resolved.reason,
      identifier: input.identifier,
    });
  }

  /** إضافة مصدر من القائمة المتاحة (بمعرّف ثابت من Telegram). */
  async addFromAvailable(input: {
    userId: string;
    accountId: string;
    peerId: string;
  }): Promise<SourceView> {
    const account = await this.requireAddableAccount(input.accountId, input.userId);
    const resolved = await this.withTelegramError(() =>
      this.deps.connections.runWithClient(input.accountId, input.userId, (client) =>
        client.resolveSource(input.peerId),
      ),
    );
    return this.createSource({
      userId: input.userId,
      accountId: account.id,
      peerType: resolved.peerType,
      peerId: resolved.peerId,
      title: resolved.title,
      username: resolved.username,
      accessible: resolved.accessible,
      reason: resolved.reason,
      identifier: input.peerId,
    });
  }

  private async createSource(input: {
    userId: string;
    accountId: string;
    peerType: SourcePeerType;
    peerId: string;
    title: string;
    username: string | null;
    accessible: boolean;
    reason?: string;
    identifier: string;
  }): Promise<SourceView> {
    if (input.reason === 'unsupported_peer_type') {
      throw badRequest(
        'unsupported_source_type',
        'هذا النوع من المحادثات غير مدعوم حالياً؛ المدعوم هو قنوات البث والمجموعات العظمى.',
      );
    }
    if (!input.peerId || input.peerId === '0') {
      throw notFound('لم يُعثر على القناة أو المجموعة بهذا المعرّف.');
    }
    // دقة المعرّف: نص رقمي موجب داخل نطاق BIGINT الموقّع، ولا يُمرَّر إلى JavaScript Number أبداً.
    if (!/^\d{1,19}$/.test(input.peerId) || BigInt(input.peerId) > 9223372036854775807n) {
      throw badRequest('validation_error', 'معرّف المصدر غير صالح.');
    }
    if (!input.accessible) {
      throw conflict(
        'source_not_accessible',
        input.reason === 'kicked'
          ? 'تم إخراج الحساب من هذا المصدر، فلا يمكن مراقبته.'
          : 'الحساب ليس عضواً في هذا المصدر؛ انضم إليه أولاً ثم أعد المحاولة.',
      );
    }

    const duplicate = await this.deps.sources.findByPeer(input.userId, input.peerType, input.peerId);
    if (duplicate) {
      throw conflict('source_already_monitored', 'هذا المصدر مضاف إلى قائمة المراقبة بالفعل.');
    }

    const count = await this.deps.sources.countByAccount(input.accountId);
    if (count >= this.deps.maxSourcesPerAccount) {
      throw conflict(
        'source_limit_reached',
        `بلغت الحد الأقصى لعدد المصادر لهذا الحساب (${this.deps.maxSourcesPerAccount}).`,
      );
    }

    let record: TelegramSourceRecord;
    try {
      record = await this.deps.sources.insert({
        userId: input.userId,
        accountId: input.accountId,
        peerType: input.peerType,
        peerId: input.peerId,
        // حدود قاعدة البيانات (1–200 للعنوان، 64 لاسم المستخدم) تُطبَّق هنا بدل رمي خطأ 23514.
        title: (input.title || 'بدون عنوان').slice(0, 200),
        username: input.username ? input.username.slice(0, 64) : null,
      });
    } catch (err) {
      // سباق إضافة متزامن: القيد الفريد (user_id, peer_type, peer_id) هو الحكم النهائي.
      if (isUniqueViolation(err)) {
        throw conflict('source_already_monitored', 'هذا المصدر مضاف إلى قائمة المراقبة بالفعل.');
      }
      throw err;
    }

    await recordAudit({
      action: 'telegram.source_added',
      actorUserId: input.userId,
      targetType: 'telegram_source',
      targetId: record.id,
      outcome: 'success',
      metadata: { peerType: record.peerType, accountId: record.accountId },
    });
    logger.info({ sourceId: record.id, peerType: record.peerType }, 'أُضيف مصدر مراقبة');
    return this.get(input.userId, record.id);
  }

  // ── التعديل ──────────────────────────────────────────────────────────────
  async setIncludeOwnMessages(input: {
    userId: string;
    sourceId: string;
    value: boolean;
  }): Promise<SourceView> {
    await this.requireOwned(input.sourceId, input.userId);
    await this.deps.sources.setIncludeOwnMessages(input.sourceId, input.value);
    await recordAudit({
      action: 'telegram.source_settings_updated',
      actorUserId: input.userId,
      targetType: 'telegram_source',
      targetId: input.sourceId,
      outcome: 'success',
      metadata: { includeOwnMessages: input.value },
    });
    return this.get(input.userId, input.sourceId);
  }

  async pause(input: { userId: string; sourceId: string }): Promise<SourceView> {
    const record = await this.requireOwned(input.sourceId, input.userId);
    await this.deps.sources.setStatus(record.id, 'paused', 'user_paused');
    await recordAudit({
      action: 'telegram.source_paused',
      actorUserId: input.userId,
      targetType: 'telegram_source',
      targetId: record.id,
      outcome: 'success',
    });
    return this.get(input.userId, record.id);
  }

  async resume(input: { userId: string; sourceId: string }): Promise<SourceView> {
    const record = await this.requireOwned(input.sourceId, input.userId);
    const account = await this.requireOwnedAccount(record.accountId, input.userId);
    if (account.status === 'revoked' || account.status === 'suspended') {
      throw conflict('account_not_connectable', 'حساب القارئ غير متاح؛ أعد ربطه أو اختر حساباً آخر.');
    }
    await this.deps.sources.setStatus(record.id, 'active', 'user_resumed');
    await recordAudit({
      action: 'telegram.source_resumed',
      actorUserId: input.userId,
      targetType: 'telegram_source',
      targetId: record.id,
      outcome: 'success',
    });
    return this.get(input.userId, record.id);
  }

  /** تحقق فوري من إمكانية الوصول وتحديث البيانات الوصفية (لا يجلب رسائل). */
  async refresh(input: { userId: string; sourceId: string }): Promise<SourceView> {
    const record = await this.requireOwned(input.sourceId, input.userId);
    await this.requireOwnedAccount(record.accountId, input.userId);
    await this.ensureConnected(record.accountId, input.userId);

    try {
      const resolved = await this.withTelegramError(() =>
        this.deps.connections.runWithClient(record.accountId, input.userId, (client) =>
          client.resolveSource(record.peerId),
        ),
      );
      const lostAccess = !resolved.accessible;
      await this.deps.sources.recordVerification({
        sourceId: record.id,
        title: resolved.title || record.title,
        username: resolved.username,
        errorCode: lostAccess ? (resolved.reason === 'kicked' ? 'SOURCE_KICKED' : 'SOURCE_NOT_MEMBER') : null,
      });
      if (lostAccess && record.status === 'active') {
        // لا ندّعي مراقبة مصدر فقدنا الوصول إليه: يُوقَف مع تسجيل السبب.
        await this.deps.sources.setStatus(record.id, 'paused', 'access_lost');
      }
      await recordAudit({
        action: 'telegram.source_verified',
        actorUserId: input.userId,
        targetType: 'telegram_source',
        targetId: record.id,
        outcome: lostAccess ? 'failure' : 'success',
        metadata: { accessible: resolved.accessible },
      });
    } catch (err) {
      const classified = classifyTelegramError(err);
      await this.deps.sources.recordVerification({
        sourceId: record.id,
        title: record.title,
        username: record.username,
        errorCode: classified.code,
      });
      throw this.toApiError(err);
    }
    return this.get(input.userId, record.id);
  }

  async remove(input: { userId: string; sourceId: string }): Promise<void> {
    const record = await this.requireOwned(input.sourceId, input.userId);
    await this.deps.sources.delete(record.id);
    await recordAudit({
      action: 'telegram.source_removed',
      actorUserId: input.userId,
      targetType: 'telegram_source',
      targetId: record.id,
      outcome: 'success',
      metadata: { peerType: record.peerType },
    });
    logger.info({ sourceId: record.id }, 'حُذف مصدر مراقبة');
  }

  // ── داخلي ────────────────────────────────────────────────────────────────
  private async requireOwned(sourceId: string, userId: string): Promise<TelegramSourceRecord> {
    const record = await this.deps.sources.findOwned(sourceId, userId);
    if (!record) throw notFound('المصدر غير موجود أو لا تملك صلاحية الوصول إليه.');
    return record;
  }

  private async requireOwnedAccount(accountId: string, userId: string) {
    const account = await this.deps.accounts.findOwned(accountId, userId);
    if (!account) throw notFound('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.');
    return account;
  }

  private async requireAddableAccount(accountId: string, userId: string) {
    const account = await this.requireOwnedAccount(accountId, userId);
    if (account.status === 'revoked') throw conflict('account_revoked', 'هذا الحساب مفصول؛ أعد ربطه أولاً.');
    if (account.status === 'suspended') {
      throw conflict('account_suspended', 'هذا الحساب موقوف من مدير النظام.');
    }
    await this.ensureConnected(accountId, userId);
    return account;
  }

  /** يطلب توصيل الحساب عبر المدير (لا ينشئ اتصالاً موازياً) ويرفض بوضوح إن لم يكتمل. */
  private async ensureConnected(accountId: string, userId: string): Promise<void> {
    let state;
    try {
      state = await this.deps.connections.connect(accountId, userId);
    } catch (err) {
      if ((err as { code?: string }).code === 'account_not_found') {
        throw notFound('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.');
      }
      throw err;
    }
    if (state.phase !== 'connected') {
      throw new ApiError(
        409,
        'account_not_connected',
        state.phase === 'needs_reauth'
          ? 'جلسة الحساب تحتاج إعادة مصادقة قبل إدارة المصادر.'
          : 'حساب تيليجرام غير متصل حالياً؛ تحقّق من الحالة وأعد المحاولة.',
      );
    }
  }

  /** يحوّل أخطاء المكتبة إلى أخطاء API عربية بلا كشف تفاصيل داخلية. */
  private async withTelegramError<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw this.toApiError(err);
    }
  }

  private toApiError(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    if ((err as { code?: string }).code === 'account_not_found') {
      return notFound('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.');
    }
    if ((err as { code?: string }).code === 'account_not_connected') {
      return new ApiError(409, 'account_not_connected', 'حساب تيليجرام غير متصل حالياً.');
    }
    const classified = classifyTelegramError(err);
    if (classified.kind === 'flood_wait') {
      return new ApiError(429, 'rate_limited', 'طلب تيليجرام الانتظار قبل إعادة المحاولة.', {
        retryAfterSeconds: classified.waitSeconds ?? 60,
      });
    }
    if (classified.kind === 'network') {
      return new ApiError(503, 'telegram_unreachable', 'تعذّر الوصول إلى تيليجرام. أعد المحاولة لاحقاً.');
    }
    if (classified.kind === 'auth_revoked' || classified.kind === 'unauthorized') {
      return new ApiError(409, 'telegram_auth_rejected', 'رفض تيليجرام الجلسة؛ أعد المصادقة.');
    }
    const message = `${(err as { message?: string }).message ?? ''}`.toUpperCase();
    if (message.includes('USERNAME_NOT_OCCUPIED') || message.includes('CHANNEL_PRIVATE')) {
      return notFound('لم يُعثر على قناة أو مجموعة بهذا المعرّف، أو أنها غير متاحة للحساب.');
    }
    if (message.includes('USERNAME_INVALID')) {
      return badRequest('validation_error', 'اسم المستخدم غير صالح.');
    }
    logger.warn({ code: classified.code }, 'خطأ أثناء عملية على مصدر تيليجرام');
    return new ApiError(502, 'telegram_error', 'لم يكتمل الطلب مع تيليجرام. حاول لاحقاً.', {
      telegramCode: classified.code,
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}
