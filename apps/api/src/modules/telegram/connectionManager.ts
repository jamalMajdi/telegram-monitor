/**
 * مدير اتصالات تيليجرام: عميل واحد لكل حساب، حدود صارمة على إعادة المحاولة،
 * ومعالجة منفصلة لأخطاء FloodWait وتفويض الجلسة.
 *
 * الضوابط المطبقة:
 * - ملكية الحساب تُتحقق من قاعدة البيانات قبل أي اتصال (عزل بين المستخدمين).
 * - إعادة الاتصال محدودة العدد بتأخير أسّي، ولا تبدأ أصلاً عند خطأ تفويض أو FloodWait.
 * - لا تُسجَّل الجلسات ولا نصوص الرسائل؛ تُسجَّل الرموز التشغيلية فقط.
 * - الحفظ المشفّر للجلسة وحالة التحديثات يتم عند الاتصال وبعد تدفق التحديثات (debounce).
 */
import { recordAudit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { recordErrorEvent } from '../../lib/errorLog.js';
import type { StoredUpdateState } from 'teleproto/sessions';
import type { ConnectionRepository, TelegramAccountRecord } from './accountRepository.js';
import { backoffDelayMs, classifyTelegramError } from './errors.js';
import type { IncomingTextMessage, TelegramAccountClient, TelegramGateway } from './gateway.js';

export type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'needs_reauth' | 'stopped';

export interface ConnectionState {
  accountId: string;
  userId: string;
  phase: ConnectionPhase;
  attempts: number;
  connectedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorKind: string | null;
  floodWaitSeconds: number | null;
  nextAttemptAt: Date | null;
  receivedMessages: number;
  savedSessions: number;
}

export interface ConnectionManagerDeps {
  gateway: TelegramGateway;
  repository: ConnectionRepository;
  /** معالج الرسائل؛ قد يكون غير متزامن ويُنتظر قبل حفظ الجلسة (سلامة نقطة الاستئناف). */
  onMessage?: (message: IncomingTextMessage) => void | Promise<void>;
  /** تأخير تجميع حفظ الجلسة بعد التحديثات. */
  persistDelayMs?: number;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * فترة نبضة الحياة (تدقيق 2026-11-26). الافتراضي 45 ثانية.
   * المكتبة تعيد الاتصال داخلياً بعد الانقطاع، لكن حالتنا المعلنة لا تعرف بذلك:
   * بدون نبضة تبقى الحساب «متصل» في الواجهة وهو مقطوع، أو «متوقف» بعد نفاد المحاولات
   * بينما الرسائل لا تصل. النبضة تُطابق الحالة المعلنة مع الحقيقة وتُعيد الربط بنفسها.
   */
  livenessIntervalMs?: number;
  /** عدد النبضات المفقودة المتتالية قبل اعتبار الاتصال مقطوعاً (افتراضياً 2). */
  livenessMisses?: number;
  /** مهلة إعادة المحاولة البطيئة بعد نفاد المحاولات السريعة (افتراضياً 5 دقائق). */
  slowRetryMs?: number;
}

interface LiveConnection {
  /** قابل للاستبدال: الانقطاع الصامت يُعالَج بعميل جديد من آخر جلسة محفوظة. */
  client: TelegramAccountClient;
  state: ConnectionState;
  unsubscribeMessages: (() => void) | null;
  persistTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  /** مؤقّت نبضة الحياة؛ يُلغى عند الإغلاق كي لا تبقى مؤقّتات معلّقة. */
  watchdogTimer: NodeJS.Timeout | null;
  /** نبضات متتالية رأت النقل مقطوعاً (نحتاج أكثر من واحدة لتجنّب الوميض). */
  missedBeats: number;
  /** سبب التوقف: انتظار إجباري أو مصادقة لا يُعادان تلقائياً، ونفاد المحاولات يُعاد ببطء. */
  stopReason: 'flood_wait' | 'auth' | 'exhausted' | null;
  /** حاجز يمنع تداخل دورتَي استعادة. */
  recovering: boolean;
  session: { session: string; updateState?: StoredUpdateState };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

export class TelegramConnectionManager {
  private readonly live = new Map<string, LiveConnection>();
  private readonly persistDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly livenessIntervalMs: number;
  private readonly livenessMisses: number;
  private readonly slowRetryMs: number;

  constructor(private readonly deps: ConnectionManagerDeps) {
    this.persistDelayMs = deps.persistDelayMs ?? 5_000;
    this.maxReconnectAttempts = deps.maxReconnectAttempts ?? 5;
    this.reconnectBaseDelayMs = deps.reconnectBaseDelayMs ?? 1_000;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => Date.now());
    this.livenessIntervalMs = deps.livenessIntervalMs ?? 45_000;
    this.livenessMisses = Math.max(1, deps.livenessMisses ?? 2);
    this.slowRetryMs = deps.slowRetryMs ?? 300_000;
  }

  /** يحمّل الحساب ويتحقق من الملكية؛ لا يبدأ اتصالاً. */
  async loadOwnedAccount(accountId: string, userId: string): Promise<TelegramAccountRecord> {
    const account = await this.deps.repository.findOwned(accountId, userId);
    if (!account) {
      throw Object.assign(new Error('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.'), {
        code: 'account_not_found',
      });
    }
    return account;
  }

  /**
   * يفتح اتصالاً للحساب. يعيد حالة الاتصال النهائية دون رمي الاستثناءات المتوقعة،
   * حتى تعرض الواجهة الحالة بدقة (متصل / يحتاج إعادة دخول / انتظار إجباري / خطأ).
   */
  async connect(accountId: string, userId: string): Promise<ConnectionState> {
    const existing = this.live.get(accountId);
    if (existing && existing.state.userId !== userId) {
      // لا يُسمح باستخدام اتصال قائم يملكه شخص آخر.
      throw Object.assign(new Error('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.'), {
        code: 'account_not_found',
      });
    }
    if (existing && existing.state.phase === 'connected') return { ...existing.state };
    if (existing) {
      // اتصال قديم غير متصل: يُغلق أولاً حتى لا تبقى نبضته أو اشتراكه يعملان على عميل مهجور.
      await this.disconnect(accountId, 'reconnect');
    }

    const account = await this.loadOwnedAccount(accountId, userId);
    if (account.status === 'suspended') {
      return this.finalState(accountId, userId, 'stopped', 'ACCOUNT_SUSPENDED');
    }
    if (account.status === 'revoked') {
      return this.finalState(accountId, userId, 'stopped', 'ACCOUNT_REVOKED');
    }

    const saved = await this.deps.repository.loadSession(accountId, userId);
    const client = this.deps.gateway.createAccountClient({
      accountId,
      savedSession: saved?.session,
      // نقطة الاستئناف المحفوظة تُمرَّر إلى العميل قبل الاتصال، وإلا تخطّى تيليجرام ما فات أثناء التوقف.
      updateState: saved?.updateState,
    });

    const connection: LiveConnection = {
      client,
      state: {
        accountId,
        userId,
        phase: 'connecting',
        attempts: 0,
        connectedAt: null,
        lastErrorCode: null,
        lastErrorKind: null,
        floodWaitSeconds: null,
        nextAttemptAt: null,
        receivedMessages: 0,
        savedSessions: 0,
      },
      unsubscribeMessages: null,
      persistTimer: null,
      reconnectTimer: null,
      watchdogTimer: null,
      missedBeats: 0,
      stopReason: null,
      recovering: false,
      session: { session: saved?.session ?? '', updateState: saved?.updateState },
    };
    this.live.set(accountId, connection);
    if (saved?.updateState) connection.session.updateState = saved.updateState;

    return this.attemptConnection(connection, account, saved?.session ?? '');
  }

  private async attemptConnection(
    connection: LiveConnection,
    account: TelegramAccountRecord,
    savedSession: string,
  ): Promise<ConnectionState> {
    void savedSession;
    const { client, state } = connection;
    let attempt = 0;
    const maxAttempts = Math.max(1, this.maxReconnectAttempts);

    for (;;) {
      attempt += 1;
      state.attempts = attempt;
      state.phase = attempt === 1 ? 'connecting' : 'reconnecting';
      await this.audit(state, 'telegram.connect_attempt', 'success', { attempt });

      try {
        const outcome = await client.connect();
        if (!outcome.authorized) {
          connection.stopReason = 'auth';
          state.phase = 'needs_reauth';
          state.lastErrorCode = 'NOT_AUTHORIZED';
          state.lastErrorKind = 'unauthorized';
          await this.deps.repository.markNeedsReauth(account.id, 'NOT_AUTHORIZED');
          await this.audit(state, 'telegram.auth_failed', 'failure', { code: 'NOT_AUTHORIZED' });
          // P4-ج: جلسة تحتاج إعادة دخول = خطأ يخص صاحب الحساب، بلا أي رمز أو معرّف محادثة.
          await recordErrorEvent({
            scope: 'telegram',
            kind: 'auth_failed',
            code: 'NOT_AUTHORIZED',
            severity: 'critical',
            userId: account.userId,
          });
          return { ...state };
        }

        state.phase = 'connected';
        state.connectedAt = new Date(this.now());
        state.lastErrorCode = null;
        state.lastErrorKind = null;
        state.floodWaitSeconds = null;
        state.nextAttemptAt = null;

        await this.deps.repository.markConnected(account.id, {
          id: outcome.self?.id ?? account.telegramUserId ?? 'unknown',
          username: outcome.self?.username,
        });
        connection.stopReason = null;
        connection.missedBeats = 0;
        this.attach(connection);
        this.startWatchdog(connection);
        await this.persist(connection, 'connect');
        await this.audit(state, 'telegram.connected', 'success', {
          telegramUserId: outcome.self?.id ? 'present' : 'absent',
        });
        return { ...state };
      } catch (err) {
        const classified = classifyTelegramError(err);
        state.lastErrorCode = classified.code;
        state.lastErrorKind = classified.kind;

        if (classified.kind === 'auth_revoked' || classified.kind === 'unauthorized') {
          connection.stopReason = 'auth';
          state.phase = 'needs_reauth';
          await this.deps.repository.markNeedsReauth(account.id, classified.code);
          await this.audit(state, 'telegram.auth_failed', 'failure', { code: classified.code });
          await recordErrorEvent({
            scope: 'telegram',
            kind: 'auth_failed',
            code: classified.code,
            severity: 'critical',
            userId: account.userId,
          });
          logger.warn({ accountId: account.id, code: classified.code }, 'جلسة تيليجرام تحتاج إعادة دخول');
          return { ...state };
        }

        if (classified.kind === 'flood_wait') {
          connection.stopReason = 'flood_wait';
          state.phase = 'stopped';
          state.floodWaitSeconds = classified.waitSeconds ?? null;
          state.nextAttemptAt = classified.waitSeconds
            ? new Date(this.now() + classified.waitSeconds * 1000)
            : null;
          await this.deps.repository.markError(account.id, 'FLOOD_WAIT');
          await recordErrorEvent({
            scope: 'telegram',
            kind: 'flood_wait',
            code: 'FLOOD_WAIT',
            severity: 'warn',
            userId: account.userId,
          });
          await this.audit(state, 'telegram.flood_wait', 'failure', {
            code: 'FLOOD_WAIT',
            waitSeconds: classified.waitSeconds ?? null,
          });
          logger.warn({ accountId: account.id, waitSeconds: classified.waitSeconds }, 'انتظار إجباري من Telegram');
          // لا إعادة محاولة تلقائية داخل الطلب ولا حلقات سريعة؛ القرار ينتقل لجدولة لاحقة.
          return { ...state };
        }

        if (!classified.retryable || attempt >= maxAttempts) {
          state.phase = attempt >= maxAttempts ? 'stopped' : 'needs_reauth';
          connection.stopReason = attempt >= maxAttempts ? 'exhausted' : 'auth';
          if (attempt >= maxAttempts) {
            // نفاد المحاولات السريعة لا يعني الموت: نبضة الحياة تُعيد المحاولة ببطء.
            state.nextAttemptAt = new Date(this.now() + this.slowRetryMs);
          }
          await this.deps.repository.markError(account.id, classified.code);
          await recordErrorEvent({
            scope: 'telegram',
            kind: 'connection_failed',
            code: classified.code,
            severity: attempt >= maxAttempts ? 'error' : 'warn',
            userId: account.userId,
          });
          await this.audit(state, 'telegram.connection_failed', 'failure', {
            code: classified.code,
            attempt,
            exhausted: !classified.retryable || attempt >= maxAttempts,
          });
          return { ...state };
        }

        const delay = backoffDelayMs(attempt, this.reconnectBaseDelayMs);
        state.nextAttemptAt = new Date(this.now() + delay);
        await this.audit(state, 'telegram.reconnect_scheduled', 'failure', {
          code: classified.code,
          attempt,
          delayMs: delay,
        });
        await this.sleep(delay);
      }
    }
  }

  /** يربط استقبال النصوص ويجدول حفظ حالة التحديثات. */
  private attach(connection: LiveConnection): void {
    if (connection.unsubscribeMessages) return;
    connection.unsubscribeMessages = connection.client.onIncomingText(async (message) => {
      connection.state.receivedMessages += 1;
      try {
        // ننتظر حسم الالتقاط حتى لا يُحفظ تقدّم يتجاوز رسالة غير محسومة (Durable Checkpoint).
        await this.deps.onMessage?.(message);
      } catch (err) {
        // الفشل يُبقي نقطة الاستئناف عند ما قبل الرسالة؛ لا نُسقط الاتصال لأجله.
        logger.error(
          { accountId: connection.state.accountId, err: (err as Error).message },
          'فشل معالجة رسالة واردة',
        );
        // يُعاد رفع الخطأ إلى طبقة العميل ليثبّت حرس نقطة الاستئناف النقطة (لا تخطّي صامت).
        throw err;
      } finally {
        this.schedulePersist(connection);
      }
    });
  }

  /**
   * نبضة الحياة: تُطابق الحالة المعلنة مع حال النقل الحقيقي (تدقيق 2026-11-26).
   *
   * الحاجة القائمة: المكتبة تعيد الاتصال داخلياً بلا حد، لكن مدير الاتصال لا يعلم بذلك.
   * فيصير الوضع أحد أمرين: (أ) الحساب «متصل» في الواجهة وهو منقطع منذ ساعات، أو
   * (ب) الحساب «متوقف» بعد نفاد خمس محاولات والرسائل تصل فعلاً. كلاهما يكسر الثقة بالحالة.
   */
  private startWatchdog(connection: LiveConnection): void {
    if (connection.watchdogTimer) return;
    if (this.livenessIntervalMs <= 0) return;
    connection.watchdogTimer = setInterval(() => {
      void this.checkLiveness(connection).catch((err: unknown) => {
        logger.warn(
          { accountId: connection.state.accountId, err: (err as Error).message },
          'تعذّر تنفيذ نبضة اتصال تيليجرام',
        );
      });
    }, this.livenessIntervalMs);
    connection.watchdogTimer.unref?.();
  }

  /**
   * نبضة واحدة فورية لحساب (تُستخدم في الاختبارات وللفحص اليدوي من التشغيل).
   * لا تُنشئ اتصالاً ولا تعيد المحاولة إن كانت الحالة لا تستدعي ذلك.
   */
  async probeLiveness(accountId: string): Promise<void> {
    const connection = this.live.get(accountId);
    if (!connection) return;
    await this.checkLiveness(connection);
  }

  private stopWatchdog(connection: LiveConnection): void {
    if (connection.watchdogTimer) clearInterval(connection.watchdogTimer);
    connection.watchdogTimer = null;
  }

  /** دورة نبضة واحدة. عميل لا يُفصح عن حالته لا يُخترع له سلوك. */
  private async checkLiveness(connection: LiveConnection): Promise<void> {
    if (connection.recovering) return;
    const probe = connection.client.isConnected;
    if (typeof probe !== 'function') return;
    let alive: boolean;
    try {
      alive = probe.call(connection.client);
    } catch {
      alive = false;
    }
    const { state } = connection;

    if (state.phase === 'connected') {
      if (alive) {
        connection.missedBeats = 0;
        return;
      }
      connection.missedBeats += 1;
      if (connection.missedBeats < this.livenessMisses) return; // نبضة واحدة قد تكون وميضاً
      connection.missedBeats = 0;
      await this.recover(connection, 'dropped');
      return;
    }

    // نفاد المحاولات السريعة: محاولة بطيئة واحدة عند استحقاقها فقط.
    if (state.phase === 'stopped' && connection.stopReason === 'exhausted') {
      const due = state.nextAttemptAt ? state.nextAttemptAt.getTime() <= this.now() : true;
      if (!due) return;
      await this.recover(connection, 'slow_retry');
    }
  }

  /**
   * استعادة الاتصال: عميل جديد من آخر جلسة محفوظة ثم دورة اتصال محدودة.
   * العميل القديم قد يكون عالقاً في حلقة إعادة اتصال داخلية أو على مقبس ميت،
   * لذا لا يُعاد استخدامه. نقطة الاستئناف محفوظة تُمرَّر للعميل الجديد فلا تُفقد رسالة.
   */
  private async recover(connection: LiveConnection, reason: 'dropped' | 'slow_retry'): Promise<void> {
    if (connection.recovering) return;
    connection.recovering = true;
    const { state } = connection;
    try {
      state.phase = 'reconnecting';
      if (reason === 'dropped') state.lastErrorCode = 'CONNECTION_DROPPED';
      await this.audit(state, reason === 'dropped' ? 'telegram.connection_dropped' : 'telegram.reconnect_retry', 'failure', {
        code: reason === 'dropped' ? 'CONNECTION_DROPPED' : (state.lastErrorCode ?? 'UNKNOWN'),
      });
      await this.replaceClient(connection);
      const account = await this.loadOwnedAccount(state.accountId, state.userId);
      const next = await this.attemptConnection(connection, account, connection.session.session);
      if (next.phase === 'connected') {
        logger.info({ accountId: state.accountId, reason }, 'استُعيد اتصال تيليجرام تلقائياً');
      }
    } catch (err) {
      logger.error(
        { accountId: state.accountId, reason, err: (err as Error).message },
        'فشل استعادة اتصال تيليجرام',
      );
      state.phase = 'stopped';
      connection.stopReason = 'exhausted';
      state.lastErrorCode = 'RECONNECT_FAILED';
      state.nextAttemptAt = new Date(this.now() + this.slowRetryMs);
    } finally {
      connection.recovering = false;
      this.startWatchdog(connection);
    }
  }

  /** يستبدل العميل بآخر جديد مع الحفاظ على Session وupdateState. */
  private async replaceClient(connection: LiveConnection): Promise<void> {
    let snapshot = connection.session;
    try {
      const exported = connection.client.exportSession();
      if (exported.session) snapshot = exported;
    } catch {
      // تعذّر التصدير: نستخدم آخر لقطة محفوظة في الذاكرة.
    }
    connection.session = snapshot;
    connection.unsubscribeMessages?.();
    connection.unsubscribeMessages = null;
    try {
      await connection.client.disconnect();
    } catch {
      // إغلاق عميل ميت قد يرمي؛ لا يمنع الاستعادة.
    }
    connection.client = this.deps.gateway.createAccountClient({
      accountId: connection.state.accountId,
      savedSession: snapshot.session,
      ...(snapshot.updateState ? { updateState: snapshot.updateState } : {}),
    });
  }

  private schedulePersist(connection: LiveConnection): void {
    if (connection.persistTimer) return;
    connection.persistTimer = setTimeout(() => {
      connection.persistTimer = null;
      void this.persist(connection, 'update_state');
    }, this.persistDelayMs);
    connection.persistTimer.unref?.();
  }

  private async persist(connection: LiveConnection, reason: 'connect' | 'update_state' | 'disconnect'): Promise<void> {
    try {
      const snapshot = connection.client.exportSession();
      if (!snapshot.session) return;
      connection.session = snapshot;
      await this.deps.repository.saveSession(connection.state.accountId, connection.state.userId, {
        session: snapshot.session,
        updateState: snapshot.updateState,
      });
      connection.state.savedSessions += 1;
      await this.audit(connection.state, 'telegram.session_saved', 'success', { reason });
    } catch (err) {
      const classified = classifyTelegramError(err);
      logger.error(
        { accountId: connection.state.accountId, code: classified.code },
        'فشل حفظ جلسة تيليجرام المشفّرة',
      );
    }
  }

  async disconnect(accountId: string, reason = 'manual'): Promise<void> {
    const connection = this.live.get(accountId);
    if (!connection) return;
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    if (connection.persistTimer) clearTimeout(connection.persistTimer);
    this.stopWatchdog(connection);
    try {
      await this.persist(connection, 'disconnect');
    } finally {
      connection.unsubscribeMessages?.();
      connection.unsubscribeMessages = null;
      await connection.client.disconnect();
      connection.state.phase = 'idle';
      this.live.delete(accountId);
      await this.deps.repository.markDisconnected(accountId);
      await this.audit(connection.state, 'telegram.disconnected', 'success', { reason });
    }
  }

  async disconnectAll(reason = 'shutdown'): Promise<void> {
    const ids = [...this.live.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id, reason)));
  }

  getState(accountId: string, userId: string): ConnectionState | null {
    const connection = this.live.get(accountId);
    if (!connection || connection.state.userId !== userId) return null;
    return { ...connection.state };
  }

  /**
   * ينفّذ عملية قراءة على عميل الحساب المتصل نفسه (بلا إنشاء اتصال ثانٍ).
   * تُستخدم لعمليات وصفية مثل جلب قائمة المصادر أو حل معرّف قناة.
   */
  async runWithClient<T>(
    accountId: string,
    userId: string,
    fn: (client: TelegramAccountClient) => Promise<T>,
  ): Promise<T> {
    const connection = this.live.get(accountId);
    if (!connection || connection.state.userId !== userId) {
      throw Object.assign(new Error('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.'), {
        code: 'account_not_found',
      });
    }
    if (connection.state.phase !== 'connected') {
      throw Object.assign(new Error('حساب تيليجرام غير متصل؛ وصّله أولاً ثم أعد المحاولة.'), {
        code: 'account_not_connected',
      });
    }
    return fn(connection.client);
  }

  /** يحفظ يدوياً (يُستخدم في الاختبارات ولإيقاف التشغيل الآمن). */
  async flushSession(accountId: string, userId: string): Promise<boolean> {
    const connection = this.live.get(accountId);
    if (!connection || connection.state.userId !== userId) return false;
    await this.persist(connection, 'update_state');
    return true;
  }

  private finalState(accountId: string, userId: string, phase: ConnectionPhase, code: string): ConnectionState {
    return {
      accountId,
      userId,
      phase,
      attempts: 0,
      connectedAt: null,
      lastErrorCode: code,
      lastErrorKind: 'rpc',
      floodWaitSeconds: null,
      nextAttemptAt: null,
      receivedMessages: 0,
      savedSessions: 0,
    };
  }

  private async audit(
    state: ConnectionState,
    action: string,
    outcome: 'success' | 'failure' | 'denied',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await recordAudit({
        action,
        actorUserId: state.userId,
        targetType: 'telegram_account',
        targetId: state.accountId,
        outcome,
        metadata,
      });
    } catch {
      // سجل التدقيق لا يُسقط إدارة الاتصال؛ الفشل يظهر في سجل التطبيق.
    }
  }
}
