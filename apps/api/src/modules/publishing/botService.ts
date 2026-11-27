/**
 * إدارة بوت النشر (الدفعة 7-أ): ربط رمز البوت، التحقق منه بـ`getMe`، وحفظه مشفّراً فقط.
 *
 * - الرمز يُدخل مرة واحدة ولا يُعاد إظهاره أبداً (لا في الاستجابة ولا في السجل ولا في التدقيق).
 * - الربط/التحقق يتطلبان أن يكون مفتاح التشفير `TG_BOT_ENC_KEY` مهيأً؛ وإلا 503 صريح بلا أي طلب خارجي.
 * - بوت واحد فعّال لكل مستخدم (Q9): إضافة بوت جديد تستبدل الرمز والبيانات في الصف نفسه (مع تدقيق).
 */
import { createHash } from 'node:crypto';
import { recordAudit } from '../../lib/audit.js';
import { ApiError, badRequest, conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { BotApiError, type BotApiClient, type BotIdentity } from './botApiClient.js';
import { BotCipherError, isBotCipherConfigured, openBotToken, sealBotToken } from './botCipher.js';
import type { PublishBotRow, PublishBotWithSecret, PublishStore } from './publishRepository.js';

/** صيغة رمز Bot API: `<معرّف رقمي>:<سلسلة>`. التحقق شكلي فقط؛ الصلاحية تُثبت بـgetMe. */
const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,80}$/;

export interface BotView {
  configured: boolean;
  status: PublishBotRow['status'] | null;
  label: string | null;
  username: string | null;
  telegramId: string | null;
  verifiedAt: string | null;
  lastErrorCode: string | null;
  tokenUpdatedAt: string | null;
}

export interface PublishBotServiceDeps {
  store: Pick<PublishStore, 'findBot' | 'listBotView' | 'upsertBot' | 'updateBotVerification' | 'setBotStatus'>;
  botApi: BotApiClient;
  /** هل مفتاح تشفير الرموز مهيأ في البيئة؟ */
  cipherConfigured?: boolean;
}

export class PublishBotService {
  private readonly cipherConfigured: boolean;

  constructor(private readonly deps: PublishBotServiceDeps) {
    this.cipherConfigured = deps.cipherConfigured ?? isBotCipherConfigured();
  }

  get ready(): boolean {
    return this.cipherConfigured;
  }

  toView(bot: PublishBotRow | null): BotView {
    if (!bot) {
      return {
        configured: false,
        status: null,
        label: null,
        username: null,
        telegramId: null,
        verifiedAt: null,
        lastErrorCode: null,
        tokenUpdatedAt: null,
      };
    }
    return {
      configured: true,
      status: bot.status,
      label: bot.label,
      username: bot.username,
      telegramId: bot.telegramId,
      verifiedAt: bot.verifiedAt?.toISOString() ?? null,
      lastErrorCode: bot.lastErrorCode,
      tokenUpdatedAt: bot.tokenUpdatedAt.toISOString(),
    };
  }

  async view(userId: string): Promise<BotView> {
    return this.toView(await this.deps.store.listBotView(userId));
  }

  /** ربط بوت (أو استبدال رمز البوت الحالي) بعد تحقق getMe إلزامي. */
  async connect(input: { userId: string; label?: string; token: string; ip?: string | null }): Promise<BotView> {
    this.requireCipher();
    const token = input.token.trim();
    if (!TOKEN_PATTERN.test(token)) {
      throw badRequest('invalid_bot_token_format', 'صيغة رمز البوت غير صحيحة. انسخ الرمز كاملاً من BotFather.');
    }
    const identity = await this.callBotApi(() => this.deps.botApi.getMe(token), 'getMe');

    let sealed: { ciphertext: Buffer; keyVersion: number; fingerprint: string };
    try {
      // المعرّف يُولَّد هنا لأن AAD يربط المغلّف بمعرّف الصف.
      sealed = sealBotToken(botRowId(input.userId), token);
    } catch (err) {
      throw this.mapCipherError(err);
    }

    const bot = await this.deps.store.upsertBot({
      id: botRowId(input.userId),
      userId: input.userId,
      label: (input.label?.trim() || 'بوت النشر').slice(0, 60),
      telegramId: identity.telegramId,
      username: identity.username,
      tokenCiphertext: sealed.ciphertext,
      tokenKeyVersion: sealed.keyVersion,
      tokenFingerprint: sealed.fingerprint,
      verifiedAt: new Date(),
      lastErrorCode: null,
    });

    await recordAudit({
      action: 'publishing.bot_connected',
      actorUserId: input.userId,
      targetType: 'publish_bot',
      targetId: bot.id,
      ip: input.ip ?? null,
      metadata: { username: identity.username, telegramId: identity.telegramId },
    });
    return this.toView(bot);
  }

  /** إعادة التحقق من الرمز المحفوظ (بلا إظهاره) وتحديث الحالة. */
  async verify(input: { userId: string; ip?: string | null }): Promise<BotView> {
    this.requireCipher();
    const bot = await this.requireBot(input.userId);
    const token = this.openToken(bot);
    let identity: BotIdentity;
    try {
      identity = await this.deps.botApi.getMe(token);
    } catch (err) {
      const mapped = this.mapBotApiError(err);
      const status = mapped.code === 'invalid_bot_token' ? 'invalid' : bot.status;
      const updated = await this.deps.store.updateBotVerification({
        userId: input.userId,
        telegramId: null,
        username: null,
        status,
        verifiedAt: null,
        lastErrorCode: mapped.code,
      });
      await recordAudit({
        action: 'publishing.bot_verified',
        actorUserId: input.userId,
        targetType: 'publish_bot',
        targetId: bot.id,
        outcome: 'failure',
        ip: input.ip ?? null,
        metadata: { errorCode: mapped.code },
      }).catch(() => undefined);
      if (updated) return this.toView(updated);
      throw mapped;
    }

    const updated = await this.deps.store.updateBotVerification({
      userId: input.userId,
      telegramId: identity.telegramId,
      username: identity.username,
      status: 'active',
      verifiedAt: new Date(),
      lastErrorCode: null,
    });
    await recordAudit({
      action: 'publishing.bot_verified',
      actorUserId: input.userId,
      targetType: 'publish_bot',
      targetId: bot.id,
      ip: input.ip ?? null,
      metadata: { username: identity.username },
    });
    return this.toView(updated);
  }

  /** تعطيل البوت: يتوقف النشر، ويبقى الرمز مشفّراً ليُعاد التحقق لاحقاً. */
  async disable(input: { userId: string; ip?: string | null }): Promise<void> {
    const bot = await this.requireBot(input.userId);
    await this.deps.store.setBotStatus(input.userId, 'disabled', null);
    await recordAudit({
      action: 'publishing.bot_disabled',
      actorUserId: input.userId,
      targetType: 'publish_bot',
      targetId: bot.id,
      ip: input.ip ?? null,
    });
  }

  /** للاستخدام الداخلي (الوجهات/النشر): رمز صريح + هوية البوت، أو خطأ واضح. */
  async requireActiveBot(userId: string): Promise<{ bot: PublishBotRow; token: string; telegramId: string }> {
    this.requireCipher();
    const bot = await this.deps.store.listBotView(userId);
    if (!bot) throw conflict('bot_required', 'أضف بوت النشر أولاً ثم أعد المحاولة.');
    if (bot.status !== 'active') {
      throw conflict('bot_not_active', 'بوت النشر غير فعّال. أعد التحقق منه أولاً.');
    }
    if (!bot.telegramId) {
      throw conflict('bot_not_verified', 'لم تُثبت هوية بوت النشر بعد. أعد التحقق منه.');
    }
    const secret = await this.deps.store.findBot(userId);
    if (!secret) throw conflict('bot_required', 'أضف بوت النشر أولاً ثم أعد المحاولة.');
    return { bot, token: this.openToken(secret), telegramId: bot.telegramId };
  }

  private openToken(bot: PublishBotWithSecret): string {
    try {
      return openBotToken(bot.id, bot.tokenCiphertext).token;
    } catch (err) {
      throw this.mapCipherError(err);
    }
  }

  private async requireBot(userId: string): Promise<PublishBotWithSecret> {
    const bot = await this.deps.store.findBot(userId);
    if (!bot) throw new ApiError(404, 'bot_not_configured', 'لا يوجد بوت نشر مربوط بهذا الحساب.');
    return bot;
  }

  private requireCipher(): void {
    if (!this.cipherConfigured) {
      throw new ApiError(
        503,
        'publishing_not_configured',
        'ميزة النشر غير مهيأة على الخادم (مفتاح تشفير رموز البوتات مفقود).',
      );
    }
  }

  private async callBotApi<T>(fn: () => Promise<T>, method: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      logger.warn({ method, code: err instanceof BotApiError ? err.code : 'unknown' }, 'فشل تحقق بوت النشر');
      throw this.mapBotApiError(err);
    }
  }

  mapBotApiError(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    if (err instanceof BotApiError) {
      if (err.code === 'unauthorized') {
        return badRequest('invalid_bot_token', 'رمز البوت غير صالح أو تم إلغاؤه من BotFather.');
      }
      if (err.code === 'network' || err.code === 'timeout') {
        return new ApiError(503, 'bot_api_unavailable', 'تعذّر الوصول إلى تيليجرام للتحقق من البوت. حاول لاحقاً.');
      }
      if (err.code === 'flood_wait') {
        return new ApiError(429, 'bot_api_flood_wait', 'تيليجرام يحدّ من الطلبات حالياً. أعد المحاولة بعد قليل.');
      }
      return new ApiError(502, 'bot_api_error', 'رفض تيليجرام طلب التحقق من البوت.');
    }
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'خطأ غير متوقع في تحقق البوت');
    return new ApiError(502, 'bot_api_error', 'تعذّر التحقق من البوت.');
  }

  private mapCipherError(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    if (err instanceof BotCipherError) {
      if (err.code === 'not_configured') {
        return new ApiError(503, 'publishing_not_configured', 'مفتاح تشفير رموز البوتات غير مهيأ على الخادم.');
      }
      logger.error({ code: err.code }, 'تعذّر فك مغلّف رمز البوت');
      return new ApiError(500, 'bot_token_unreadable', 'تعذّر قراءة رمز البوت المحفوظ. أعد ربط البوت.');
    }
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'خطأ غير متوقع في مغلّف رمز البوت');
    return new ApiError(500, 'bot_token_unreadable', 'تعذّر معالجة رمز البوت.');
  }
}

/**
 * معرّف صف البوت مشتق حتمياً من معرّف المستخدم (بوت واحد لكل مستخدم — Q9).
 * الثبات شرط لفتح المغلّف: AAD يحمل معرّف الصف، فلو تغيّر عند استبدال الرمز لفشل الفك لاحقاً.
 */
export function botRowId(userId: string): string {
  const hash = createHash('sha256').update(`publish-bot:${userId}`, 'utf8').digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
