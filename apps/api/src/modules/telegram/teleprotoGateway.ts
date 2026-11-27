/**
 * تنفيذ البوابة فوق teleproto 1.234 (طبقة مخطط 234).
 * لا يُنزَّل أي وسيط: تُقرأ نصوص الرسائل والنصوص المصاحبة فقط، ويُتجاهل الباقي.
 */
import { TelegramClient, Api } from 'teleproto';
// نوع `long` في مخطط المكتبة هو BigInteger؛ نستخدم نفس تحويل المكتبة لتفادي أخطاء النوع.
import bigInt from 'big-integer';
import { sendCode as sendLoginCode } from 'teleproto/client/auth';
import { computeCheck } from 'teleproto/Password';
import { StringSession, type StoredUpdateState } from 'teleproto/sessions';
import { Logger } from 'teleproto/extensions/Logger';
import { LogLevel } from 'teleproto/extensions/Logger';
import type { ClassifiedTelegramError } from './errors.js';
import { classifyTelegramError } from './errors.js';
import { CheckpointGuard } from './checkpointGuard.js';
import { mapIncomingText } from './messageMapper.js';
import {
  SenderIdentityCache,
  resolveSenderIdentity,
  type SenderEntityFields,
  type SenderLookup,
  type SenderResolverStats,
} from './senderResolver.js';
import type {
  AvailableSource,
  ConnectOutcome,
  IncomingTextMessage,
  LoginCodeOutcome,
  LoginCodeSent,
  ResolvedSource,
  SessionSnapshot,
  SourcePeerType,
  TelegramAccountClient,
  TelegramGateway,
  TelegramLoginClient,
  TelegramSelf,
} from './gateway.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { TELEPROTO_VERSION } from './config.js';

/** يحوّل سجلات teleproto إلى سجلنا المنظّم بمستوى محافظ (بلا محتوى رسائل). */
function createLibraryLogger(): Logger {
  const libLogger = new Logger(LogLevel.WARN);
  libLogger.handler = ({ level, message }) => {
    if (level === 'error' || level === 'warn') {
      logger.warn({ library: 'teleproto', level }, String(message));
    }
  };
  return libLogger;
}

export interface TeleprotoGatewayOptions {
  apiId: number;
  apiHash: string;
  testServers: boolean;
  catchUp: boolean;
  connectionRetries: number;
  floodSleepThreshold: number;
}

export class TeleprotoGateway implements TelegramGateway {
  readonly libraryName = 'teleproto';
  readonly libraryVersion = TELEPROTO_VERSION;

  constructor(private readonly options: TeleprotoGatewayOptions) {}

  createAccountClient(input: {
    accountId: string;
    savedSession?: string;
    updateState?: StoredUpdateState;
  }): TelegramAccountClient {
    return new TeleprotoAccountClient(
      input.accountId,
      this.options,
      input.savedSession ?? '',
      input.updateState,
    );
  }

  createLoginClient(input: { accountId: string; savedSession?: string }): TelegramLoginClient {
    return new TeleprotoLoginClient(input.accountId, this.options, input.savedSession ?? '');
  }
}

class TeleprotoAccountClient implements TelegramAccountClient {
  private readonly client: TelegramClient;
  private readonly session: StringSession;
  private initializedState?: StoredUpdateState;
  private unsubscribeUpdates: (() => void) | null = null;
  private readonly subscribers = new Set<(message: IncomingTextMessage) => void | Promise<void>>();
  /**
   * هوية المرسل: كاش محلي لكل عميل (الحساب جزء من المفتاح) + عدّادات تشخيص بلا أي محتوى.
   * تيليجرام لا يُرفق بيانات المستخدم مع التحديث، فبدون هذه الخطوة يُحفظ المعرّف بلا اسم.
   */
  private readonly senderCache = new SenderIdentityCache();
  private readonly senderStats: SenderResolverStats = {
    cacheHits: 0,
    lookups: 0,
    resolved: 0,
    unresolved: 0,
    timeouts: 0,
    failures: 0,
  };
  /**
   * لا يُحفظ تقدّم التحديثات إلا بعد حسم معالجة الرسالة الجارية:
   * مكتبة teleproto تُقدّم pts قبل تسليم التحديث، فحفظ اللقطة الحيّة قد يتجاوز رسالة لم تُحفظ هويتها.
   * يُنشأ في المُنشئ **بعد** استعادة الحالة، لأن قراءته المبكرة تسبق تهيئة الجلسة (كانت تُسقط الإنشاء).
   */
  private readonly checkpoint: CheckpointGuard<StoredUpdateState>;

  constructor(
    private readonly accountId: string,
    options: TeleprotoGatewayOptions,
    savedSession: string,
    savedUpdateState?: StoredUpdateState,
  ) {
    this.session = new StringSession(savedSession);
    // نقطة الاستئناف المحفوظة تُعاد إلى الجلسة **قبل** الاتصال، وإلا بدأ العميل من الصفر
    // وتخطّى تيليجرام كل ما فات أثناء التوقف ("Skipping the updates missed while offline").
    if (savedUpdateState) this.session.setUpdateState(savedUpdateState);
    this.checkpoint = new CheckpointGuard<StoredUpdateState>(
      () => this.session.getUpdateState() ?? this.initializedState,
      () => this.libraryDispatchBusy(),
      savedUpdateState,
    );
    this.client = new TelegramClient(this.session, options.apiId, options.apiHash, {
      connectionRetries: options.connectionRetries,
      floodSleepThreshold: options.floodSleepThreshold,
      catchUp: options.catchUp,
      testServers: options.testServers,
      autoReconnect: true,
      // هوية تطبيق صريحة بدلاً من الافتراضيات المبنية على نظام التشغيل
      deviceModel: 'Telegram Monitor',
      systemVersion: 'server',
      appVersion: '0.2.0',
      langCode: 'ar',
      baseLogger: createLibraryLogger(),
      sequentialUpdates: true,
      timeout: env.TG_REQUEST_TIMEOUT_SECONDS,
    });
  }

  async connect(): Promise<ConnectOutcome> {
    await this.client.connect();
    this.initializedState = this.session.getUpdateState();
    const authorized = await this.client.checkAuthorization();
    if (!authorized) return { authorized: false, self: null };
    const self = await this.getSelf();
    this.attachUpdateHandler();
    return { authorized: true, self };
  }

  async disconnect(): Promise<void> {
    if (this.unsubscribeUpdates) {
      this.unsubscribeUpdates();
      this.unsubscribeUpdates = null;
    }
    await this.client.disconnect();
  }

  /**
   * حال النقل الحقيقي كما تعرفه المكتبة: `connected` getter في teleproto
   * يسأل الـ sender عن اتصاله الفعلي، لا عن نيّة الاتصال.
   */
  isConnected(): boolean {
    return (this.client as unknown as { connected?: boolean }).connected === true;
  }

  async checkAuthorization(): Promise<boolean> {
    try {
      return await this.client.checkAuthorization();
    } catch (err) {
      const classified = classifyTelegramError(err);
      throw Object.assign(new Error(`فشل فحص المصادقة: ${classified.code}`), { telegram: classified });
    }
  }

  async getSelf(): Promise<TelegramSelf | null> {
    const me = (await this.client.getMe()) as Api.User;
    if (!me) return null;
    const id = String(me.id);
    return me.username ? { id, username: me.username } : { id };
  }

  onIncomingText(handler: (message: IncomingTextMessage) => void): () => void {
    this.subscribers.add(handler);
    this.attachUpdateHandler();
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * قائمة المحادثات ثم تصفية القنوات والمجموعات العظمى فقط.
   * لا نطلب سوى بيانات وصفية (dialog + entity)؛ لا رسائل ولا وسائط.
   */
  async listAvailableSources(input?: { limit?: number }): Promise<AvailableSource[]> {
    const limit = Math.min(Math.max(input?.limit ?? 200, 1), 500);
    const dialogs = await this.client.getDialogs({ limit });
    const out: AvailableSource[] = [];
    for (const dialog of dialogs) {
      const mapped = mapEntityToSource(dialog.entity as unknown as ChannelLike);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  /** يحل اسم مستخدم عام (@name) أو معرّفاً رقمياً إلى هوية ثابتة ويتحقق من العضوية. */
  async resolveSource(identifier: string): Promise<ResolvedSource> {
    const parsed = parseSourceIdentifier(identifier);
    if (parsed.kind === 'username') {
      const resolved = await this.client.invoke(new Api.contacts.ResolveUsername({ username: parsed.value }));
      const channel = (resolved.chats ?? []).find((chat) => isChannelLike(chat));
      if (!channel) {
        return { peerId: '0', peerType: 'channel', title: '', username: null, accessible: false, reason: 'not_found' };
      }
      return describeResolvedSource(channel as unknown as ChannelLike);
    }
    if (parsed.kind === 'peer_id') {
      const entity = await this.client.getEntity(BigInt(parsed.value) as unknown as Parameters<TelegramClient['getEntity']>[0]);
      return describeResolvedSource(entity as unknown as ChannelLike);
    }
    return {
      peerId: '0',
      peerType: 'channel',
      title: '',
      username: null,
      accessible: false,
      reason: 'unsupported_peer_type',
    };
  }

  exportSession(): SessionSnapshot {
    return {
      session: this.session.save() ?? '',
      // نقطة الاستئناف المتحفّظة (Checkpoint Guard) وليست اللقطة الحيّة.
      updateState: this.checkpoint.snapshot(),
    };
  }

  /** معلومات تشخيصية عن نقطة الاستئناف (بلا أي بيانات محتوى). */
  getCheckpointInfo(): { pending: number; pinned: boolean; failures: number; busy: boolean } {
    return {
      pending: this.checkpoint.pending,
      pinned: this.checkpoint.isPinned,
      failures: this.checkpoint.failureCount,
      busy: this.libraryDispatchBusy(),
    };
  }

  /**
   * هل ما زالت المكتبة تُفرّغ تحديثات في مسارها غير المتزامن (بين تقدّم `pts` وبدء معالجنا)؟
   *
   * المكتبة لا تُصدّر إشارة خمول عامة؛ نقرأ حقل موزّع التحديثات الداخلي (`_updateDispatcher`):
   * `draining` يبقى true من إدخال التحديث في الطابور حتى انتهاء استدعاء معالجنا (deliver يُنتظر
   * داخل حلقة drain)، ويغطي انتظارات `builder.resolve`/`getMe` الوسيطة.
   * عند غياب الحقل في نسخة مكتبة أخرى نُعيد false (السلوك السابق)، ويوجد اختبار يفشل إذا اختفى الحقل.
   */
  private libraryDispatchBusy(): boolean {
    const dispatcher = (this.client as unknown as {
      _updateDispatcher?: { draining?: boolean; head?: unknown };
    })._updateDispatcher;
    if (!dispatcher) return false;
    return dispatcher.draining === true || dispatcher.head !== undefined;
  }

  /** يسجّل مستمعاً واحداً لكل عميل ويتجاهل الرسائل غير النصية. */
  private attachUpdateHandler(): void {
    if (this.unsubscribeUpdates) return;
    // دالة غير متزامنة تُعيد Promise: مع sequentialUpdates ينتظرها العميل قبل التحديث التالي،
    // فلا يتقدّم pts فعلياً إلى ما بعد رسالة لم تُحسم معاملتها.
    this.unsubscribeUpdates = this.client.updates.on(
      ['newMessage', 'newChannelMessage'],
      async (update: unknown) => {
        let mapped: IncomingTextMessage | null = null;
        try {
          mapped = this.mapUpdate(update);
        } catch (err) {
          logger.error({ accountId: this.accountId, err: (err as Error).message }, 'تعذّر تحويل تحديث وارد');
          return;
        }
        if (!mapped) return;

        this.checkpoint.begin();
        let ok = false;
        try {
          // إثراء هوية المرسل داخل نافذة النقطة: لا يتقدّم pts قبل حسمها، ومهلة قصوى تمنع التعليق.
          await this.enrichSender(mapped);
          await Promise.all([...this.subscribers].map((subscriber) => subscriber(mapped!)));
          ok = true;
        } catch (err) {
          const classified = classifyTelegramError(err);
          logger.error({ accountId: this.accountId, code: classified.code }, 'فشل معالج رسالة واردة');
        } finally {
          // نجاح ⇒ النقطة تتقدّم؛ فشل ⇒ تبقى عند ما قبل الرسالة (تُعاد من تيليجرام).
          this.checkpoint.settle(ok);
        }
      },
    );
  }

  private mapUpdate(update: unknown): IncomingTextMessage | null {
    return mapIncomingText(update as Parameters<typeof mapIncomingText>[0], this.accountId);
  }

  /** يقرأ حقول الاسم/اليوزر من كيان تيليجرام كما هو (بلا أي استنتاج). */
  private static entityFields(entity: unknown): SenderEntityFields | null {
    if (!entity || typeof entity !== 'object') return null;
    const fields = entity as Record<string, unknown>;
    return {
      username: typeof fields.username === 'string' ? fields.username : null,
      firstName: typeof fields.firstName === 'string' ? fields.firstName : null,
      lastName: typeof fields.lastName === 'string' ? fields.lastName : null,
      title: typeof fields.title === 'string' ? fields.title : null,
    };
  }

  /**
   * مصدر الحلّ الفعلي فوق مكتبة teleproto:
   * - `getEntity` يقرأ كاش الجلسة أولاً (بلا شبكة إن كان معروفاً).
   * - `getMessages` بمعرّف الرسالة نفسها يعيد كيانات المرسلين ويُخزّنها في الجلسة.
   * كل الأخطاء تُبتلع هنا: التوقيع التجميلي لا يُسقط التقاط رسالة أبداً.
   */
  private readonly senderLookup: SenderLookup = {
    getEntity: async (userId: string) => {
      try {
        const entity = await this.client.getEntity(
          BigInt(userId) as unknown as Parameters<TelegramClient['getEntity']>[0],
        );
        return TeleprotoAccountClient.entityFields(entity);
      } catch {
        return null;
      }
    },
    warmFromSourceMessage: async (peerKey: string, messageId: number) => {
      try {
        const peer = TeleprotoAccountClient.peerOf(peerKey);
        if (!peer) return;
        await this.client.getMessages(peer as unknown as Parameters<TelegramClient['getMessages']>[0], {
          ids: messageId,
        });
      } catch {
        // لا شيء: الفشل يعني بقاء الهوية بالمعرّف فقط.
      }
    },
  };

  /**
   * يحوّل مفتاح النظير (`channel:123` / `chat:123` / `user:123`) إلى نظير صريح النوع.
   * رقم مجرّد كان يُفسَّر كمستخدم فيفشل حلّ المجموعات — وهذا سبب فشل التدفئة في الفحص الحيّ.
   */
  private static peerOf(peerKey: string): Api.PeerChannel | Api.PeerChat | Api.PeerUser | null {
    const [kind, rawId] = peerKey.split(':');
    if (!rawId || !/^\d{1,20}$/.test(rawId)) return null;
    const id = bigInt(rawId);
    if (kind === 'channel') return new Api.PeerChannel({ channelId: id });
    if (kind === 'chat') return new Api.PeerChat({ chatId: id });
    if (kind === 'user') return new Api.PeerUser({ userId: id });
    return null;
  }

  /** يثري هوية المرسل في الرسالة الواردة (اسم + @username) قبل تمريرها للمعالجة. */
  private async enrichSender(message: IncomingTextMessage): Promise<void> {
    if (!message.sender) return;
    try {
      message.sender = await resolveSenderIdentity(
        {
          accountId: this.accountId,
          sender: message.sender,
          peerKey: message.peerKey,
          messageId: message.messageId,
        },
        this.senderLookup,
        { cache: this.senderCache, stats: this.senderStats },
      );
    } catch {
      // حزام أمان أخير: لا يُسقط الالتقاط بأي حال.
      this.senderStats.failures += 1;
    }
  }

  /** عدّادات حلّ هوية المرسل (أرقام فقط — بلا معرّفات ولا أسماء). */
  getSenderResolutionStats(): SenderResolverStats & { cached: number } {
    return { ...this.senderStats, cached: this.senderCache.size };
  }
}

/** يساعد اختبارات الاتصال الحقيقي على تمييز الأخطاء المصنّفة. */
export function describeTelegramFailure(error: unknown): ClassifiedTelegramError {
  return classifyTelegramError(error);
}

/**
 * عميل مصادقة أولية (قبل وجود جلسة صالحة).
 * يستدعي واجهات teleproto المثبتة فعلياً: sendCode ثم auth.SignIn ثم auth.CheckPassword مع computeCheck.
 * لا يطبع ولا يُرجع رمزاً أو كلمة مرور؛ الجلسة المؤقتة تُعاد فقط عبر exportSession للحفظ المشفّر.
 */
class TeleprotoLoginClient implements TelegramLoginClient {
  private readonly client: TelegramClient;
  private readonly session: StringSession;
  /** كائن كلمة المرور الذي يعيده Telegram قبل حساب SRP؛ لا يُخزَّن خارج الذاكرة. */
  private passwordSrp: Api.account.Password | null = null;

  constructor(
    private readonly accountId: string,
    private readonly options: TeleprotoGatewayOptions,
    savedSession: string,
  ) {
    this.session = new StringSession(savedSession);
    this.client = new TelegramClient(this.session, options.apiId, options.apiHash, {
      connectionRetries: options.connectionRetries,
      floodSleepThreshold: options.floodSleepThreshold,
      testServers: options.testServers,
      autoReconnect: false,
      deviceModel: 'Telegram Monitor',
      systemVersion: 'server',
      appVersion: '0.2.0',
      langCode: 'ar',
      baseLogger: createLibraryLogger(),
      timeout: env.TG_REQUEST_TIMEOUT_SECONDS,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async requestLoginCode(phoneNumber: string): Promise<LoginCodeSent> {
    const sent = await sendLoginCode(
      this.client,
      { apiId: this.options.apiId, apiHash: this.options.apiHash },
      phoneNumber,
    );
    if (sent.emailRequired || sent.emailCodeSent) {
      return {
        phoneCodeHash: sent.phoneCodeHash,
        viaApp: false,
        unsupportedDelivery: sent.emailRequired ? 'email_required' : 'email_code',
      };
    }
    return { phoneCodeHash: sent.phoneCodeHash, viaApp: sent.isCodeViaApp, codeLength: sent.emailOptions?.codeLength };
  }

  async submitLoginCode(input: { phoneNumber: string; phoneCodeHash: string; code: string }): Promise<LoginCodeOutcome> {
    try {
      const result = await this.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: input.phoneNumber,
          phoneCodeHash: input.phoneCodeHash,
          phoneCode: input.code,
        }),
      );
      const self = toSelf(authorizationUser(result));
      return { status: 'authorized', self };
    } catch (err) {
      const message = errorMessageOf(err);
      if (message === 'SESSION_PASSWORD_NEEDED') {
        this.passwordSrp = await this.client.invoke(new Api.account.GetPassword());
        return { status: 'password_required', hint: this.passwordSrp.hint ?? null };
      }
      throw err;
    }
  }

  async submitPassword(password: string): Promise<{ self: TelegramSelf }> {
    const srp = this.passwordSrp ?? (await this.client.invoke(new Api.account.GetPassword()));
    this.passwordSrp = srp;
    const check = await computeCheck(srp, password);
    const result = await this.client.invoke(new Api.auth.CheckPassword({ password: check }));
    this.passwordSrp = null;
    return { self: toSelf(authorizationUser(result)) };
  }

  exportSession(): SessionSnapshot {
    return { session: this.session.save() ?? '', updateState: this.session.getUpdateState() };
  }

  async disconnect(): Promise<void> {
    this.passwordSrp = null;
    await this.client.disconnect();
  }
}

/**
 * استخراج هوية المستخدم من نتيجة التفويض.
 * `auth.authorizationSignUpRequired` يعني أن الرقم غير مسجّل في تيليجرام — لا نُنشئ حسابات.
 */
function authorizationUser(result: unknown): Api.TypeUser | undefined {
  const record = result as { className?: string; user?: Api.TypeUser };
  if (record?.className === 'auth.AuthorizationSignUpRequired') {
    throw Object.assign(new Error('PHONE_NUMBER_UNOCCUPIED'), { errorMessage: 'PHONE_NUMBER_UNOCCUPIED' });
  }
  return record?.user;
}

function toSelf(user: Api.TypeUser | undefined): TelegramSelf {
  const candidate = user as { id?: unknown; username?: string } | undefined;
  const rawId = candidate?.id;
  if (rawId === undefined || rawId === null) {
    throw new Error('لم تُعد المكتبة هوية الحساب بعد المصادقة.');
  }
  return candidate?.username ? { id: String(rawId), username: candidate.username } : { id: String(rawId) };
}

function errorMessageOf(err: unknown): string {
  const record = err as { errorMessage?: unknown; message?: unknown };
  if (typeof record?.errorMessage === 'string') return record.errorMessage;
  if (typeof record?.message === 'string') return record.message;
  return '';
}

/** الحد الأدنى من شكل كيان القناة/المجموعة كما تعيده المكتبة. */
interface ChannelLike {
  className?: string;
  id?: unknown;
  title?: string;
  username?: string;
  megagroup?: boolean;
  broadcast?: boolean;
  left?: boolean;
  deactivated?: boolean;
}

function isChannelLike(entity: unknown): boolean {
  return (entity as ChannelLike)?.className === 'Channel';
}

/**
 * قنوات البث والمجموعات العظمى فقط.
 * المجموعات القديمة (Chat) غير مدعومة في هذه المرحلة وتُستثنى صراحةً.
 */
function mapEntityToSource(entity: ChannelLike): AvailableSource | null {
  if (!isChannelLike(entity)) return null;
  const id = entity.id;
  if (id === undefined || id === null) return null;
  const peerType: SourcePeerType = entity.megagroup ? 'group' : 'channel';
  if (!entity.megagroup && !entity.broadcast) return null;
  return {
    peerType,
    peerId: String(id),
    title: entity.title ?? 'بدون عنوان',
    username: entity.username ?? null,
  };
}

function describeResolvedSource(entity: ChannelLike): ResolvedSource {
  const mapped = mapEntityToSource(entity);
  if (!mapped) {
    return {
      peerId: entity.id !== undefined && entity.id !== null ? String(entity.id) : '0',
      peerType: 'group',
      title: entity.title ?? '',
      username: entity.username ?? null,
      accessible: false,
      reason: 'unsupported_peer_type',
    };
  }
  const left = Boolean(entity.left) || Boolean(entity.deactivated);
  return {
    ...mapped,
    accessible: !left,
    ...(left ? { reason: 'not_member' as const } : {}),
  };
}

/** يقبل @username أو t.me/username أو اسم مستخدم مجرد، أو معرّفاً رقمياً. */
export function parseSourceIdentifier(
  input: string,
): { kind: 'username'; value: string } | { kind: 'peer_id'; value: string } | { kind: 'unsupported' } {
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'unsupported' };
  let candidate = trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?t\.me\//i, '')
    .replace(/^telegram\.me\//i, '');
  if (candidate.startsWith('+') || candidate.toLowerCase().startsWith('joinchat/')) {
    // روابط دعوة خاصة: تحتاج join، وهو خارج نطاق إدارة المصادر الحالية.
    return { kind: 'unsupported' };
  }
  candidate = candidate.replace(/^@/, '').replace(/\/$/, '');
  // معرّفات Telegram موجبة دائماً، وسقف BIGINT الموقّع 19 رقماً: ما دون ذلك مرفوض هنا
  // بدل الوصول إلى قاعدة البيانات (يمنع أخطاء 22003/23514 غير المعالجة).
  if (/^\d{5,19}$/.test(candidate)) return { kind: 'peer_id', value: candidate };
  if (/^-?\d{5,20}$/.test(candidate)) return { kind: 'unsupported' };
  if (/^[A-Za-z0-9_]{4,32}$/.test(candidate)) return { kind: 'username', value: candidate };
  return { kind: 'unsupported' };
}
