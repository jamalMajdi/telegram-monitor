/**
 * خدمة ربط حسابات تيليجرام عبر MTProto (الخطوة الثانية من المرحلة الثانية).
 *
 * المبادئ المطبقة:
 * - الحالة المؤقتة تُحفظ في الخادم (قاعدة البيانات) **مشفّرة** وبصلاحية زمنية، ولا تُحفظ في المتصفح.
 * - رمز التحقق وكلمة مرور التحقق بخطوتين يمرّان في الذاكرة فقط ولا يُخزَّنان ولا يُسجَّلان.
 * - كل عملية مقيّدة بمالك الحساب، وتُسلسَل لكل حساب (قفل مفتاحي) لمنع المحاولات المتوازية.
 * - حدود صريحة: مدة صلاحية، عدد محاولات الرمز، عدد محاولات كلمة المرور، وعدد مرات إعادة الإرسال.
 * - بعد نجاح المصادقة تُحفظ الجلسة عبر Session Cipher الحالي، ويُدار الاتصال عبر Connection Manager.
 */
import { recordAudit } from '../../lib/audit.js';
import { ApiError, badRequest, conflict, notFound, tooManyRequests } from '../../lib/errors.js';
import { withTransaction } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import type { ConnectionState, TelegramConnectionManager } from './connectionManager.js';
import type {
  ConnectionRepository,
  TelegramAccountListItem,
  TelegramAccountStore,
} from './accountRepository.js';
import { classifyTelegramError, type ClassifiedTelegramError } from './errors.js';
import type { LoginCodeSent, TelegramGateway, TelegramLoginClient, TelegramSelf } from './gateway.js';
import type { LoginChallenge, LoginChallengeStore } from './loginChallengeStore.js';
import type { TelegramSourceStore } from './sourceRepository.js';
import { hashPhoneNumber, InvalidPhoneNumberError, normalizePhoneNumber, phoneLastDigits } from './phone.js';
import { deleteTelegramSession, saveTelegramSession } from './sessionStore.js';

export interface LoginLimits {
  ttlMinutes: number;
  maxCodeAttempts: number;
  maxPasswordAttempts: number;
  maxResends: number;
  resendIntervalSeconds: number;
}

export interface LoginServiceDeps {
  gateway: TelegramGateway | null;
  accounts: TelegramAccountStore;
  challenges: LoginChallengeStore;
  /** يُستدعى بعد نجاح الربط لتوصيل الحساب عبر مدير الاتصالات الحالي. */
  connections:
    | Pick<TelegramConnectionManager, 'connect' | 'disconnect' | 'getState'>
    | null;
  limits: LoginLimits;
  /** عند فصل الحساب: إيقاف مصادره المفعّلة مع تسجيل الفترة (لا تُحذف قائمة المراقبة). */
  sources?: Pick<TelegramSourceStore, 'pauseForAccount'>;
  now?: () => number;
}

/** ملخّص آمن للمحاولة يُعاد للواجهة: بلا رقم كامل، بلا بصمة رمز، بلا جلسة. */
export interface LoginChallengeSummary {
  accountId: string;
  stage: 'code' | 'password';
  viaApp: boolean | null;
  codeLength: number | null;
  hint: string | null;
  expiresAt: string;
  resendAvailableAt: string | null;
  codeAttemptsRemaining: number;
  passwordAttemptsRemaining: number | null;
  resendsRemaining: number;
}

export interface AccountView {
  id: string;
  label: string;
  status: TelegramAccountListItem['status'];
  telegramUsername: string | null;
  phoneLastDigits: string | null;
  lastConnectedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  connection: {
    phase: ConnectionState['phase'] | 'unknown';
    connectedAt: string | null;
    lastErrorCode: string | null;
    floodWaitSeconds: number | null;
    nextAttemptAt: string | null;
    receivedMessages: number;
  } | null;
}

export class TelegramNotConfiguredError extends ApiError {
  constructor() {
    super(
      503,
      'telegram_not_configured',
      'تكامل تيليجرام غير مهيأ على الخادم (بيانات التطبيق أو مفتاح التشفير مفقود).',
    );
  }
}

/**
 * قفل متسلسل لكل مفتاح (حساب) لمنع تنفيذ خطوتين متوازيتين على المحاولة نفسها.
 *
 * تدقيق 2026-11-26: كان كل مفتاح يبقى في الخريطة إلى الأبد. العدد محصور بعدد الحسابات
 * فليس تسرّباً حاداً، لكنه نموّ لا نهائي بالمبدأ؛ صار المفتاح يُحرَّر عند انتهاء سلسلته.
 */
export class KeyedLock {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      // لا يُحذف إلا إذا لم تُضَف سلسلة أحدث على المفتاح نفسه.
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }

  /** عدد المفاتيح النشطة — للتشخيص والاختبار. */
  get activeKeys(): number {
    return this.chains.size;
  }
}

export class TelegramLoginService {
  private readonly lock = new KeyedLock();
  private readonly clients = new Map<string, TelegramLoginClient>();
  /** آخر استخدام لكل عميل مصادقة، لتنظيف المحاولات المهجورة (تدقيق 2026-11-26). */
  private readonly clientTouched = new Map<string, number>();
  private sweeperTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: LoginServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  // ── القراءة ──────────────────────────────────────────────────────────────
  async listAccounts(userId: string): Promise<AccountView[]> {
    const rows = await this.deps.accounts.listByUser(userId);
    return rows
      .filter((row) => row.status !== 'revoked')
      .map((row) => this.toView(row, userId));
  }

  async getAccount(userId: string, accountId: string): Promise<AccountView> {
    const account = await this.deps.accounts.findOwned(accountId, userId);
    if (!account) throw notFound('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.');
    const items = await this.deps.accounts.listByUser(userId);
    const item = items.find((row) => row.id === accountId);
    if (!item) throw notFound('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.');
    return this.toView(item, userId);
  }

  // ── بدء الربط ────────────────────────────────────────────────────────────
  async startLink(input: {
    userId: string;
    phoneNumber: string;
    label?: string;
    /** عند إعادة المصادقة لحساب قائم. */
    accountId?: string;
  }): Promise<LoginChallengeSummary> {
    const gateway = this.requireGateway();
    // التطبيع شرط لكل ما يلي: البصمة، وآخر رقمان، وطلب Telegram نفسه.
    let phoneNumber: string;
    try {
      phoneNumber = normalizePhoneNumber(input.phoneNumber);
    } catch (err) {
      if (err instanceof InvalidPhoneNumberError) {
        throw badRequest('validation_error', err.message, [
          { field: 'phoneNumber', message: 'استخدم الصيغة الدولية مثل +9677xxxxxxxx.' },
        ]);
      }
      throw err;
    }
    const accountKey = input.accountId ?? `pending:${input.userId}:${phoneNumber}`;

    return this.lock.run(accountKey, async () => {
      const phoneHash = hashPhoneNumber(phoneNumber);
      const existingWithPhone = await this.deps.accounts.findByPhoneHash(input.userId, phoneHash);
      /**
       * سجل بحالة pending_login يعني محاولة ربط لم تكتمل (انتهت صلاحيتها أو فشلت أو أُلغيت محاولتها):
       * نستأنف الربط على السجل نفسه بدل رفضه، فلا يمنع الفهرس الفريد (user_id, phone_hash) بدء محاولة جديدة.
       * أي حالة أخرى لنفس الرقم (active/needs_reauth/suspended) تعني تكراراً فعلياً ويُرفض.
       */
      let resumePendingAccountId: string | undefined;
      if (existingWithPhone && existingWithPhone.id !== input.accountId) {
        if (existingWithPhone.status === 'pending_login' && !input.accountId) {
          resumePendingAccountId = existingWithPhone.id;
        } else {
          throw conflict('account_already_linked', 'هذا الرقم مرتبط بحساب في مساحتك بالفعل.');
        }
      }

      let accountId = input.accountId ?? resumePendingAccountId;
      let created = false;
      if (accountId) {
        const owned = await this.deps.accounts.findOwned(accountId, input.userId);
        if (!owned) throw notFound('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.');
        if (owned.status === 'suspended') {
          throw conflict('account_suspended', 'هذا الحساب موقوف من مدير النظام ولا يمكن ربطه.');
        }
        if (owned.status === 'revoked') {
          throw conflict('account_revoked', 'هذا الحساب مفصول؛ ابدأ ربطاً جديداً.');
        }
      } else if (resumePendingAccountId) {
        // استئناف سجل معلّق: لا ننشئ صفاً جديداً (الفهرس الفريد يمنع ذلك)، ولا نحذفه عند التراجع.
        const owned = await this.deps.accounts.findOwned(resumePendingAccountId, input.userId);
        if (!owned || owned.status !== 'pending_login') {
          throw conflict('account_already_linked', 'تغيّرت حالة الحساب أثناء بدء الربط. أعد تحميل الصفحة.');
        }
      } else {
        const account = await this.deps.accounts.createPendingAccount({
          userId: input.userId,
          label: input.label?.trim() || `حساب ${phoneLastDigits(phoneNumber)}`,
          phoneLastDigits: phoneLastDigits(phoneNumber),
          phoneHash,
        });
        accountId = account.id;
        created = true;
      }

      if (!accountId) {
        // لا يحدث عملياً: كل الفروع أعلاه تُحدد معرّفاً أو ترمي خطأً.
        throw new ApiError(500, 'account_id_missing', 'تعذّر تحديد حساب للربط. حاول مجدداً.');
      }

      const expiresAt = this.expiryFromNow();
      const challenge = await this.deps.challenges.start({
        accountId,
        userId: input.userId,
        payload: { phoneNumber, phoneCodeHash: '', tempSession: '' },
        expiresAt,
      });

      try {
        // لا تستخدم محاولة قديمة أثناء إعادة الربط: أوقف الاتصال القائم قبل المصادقة الجديدة.
        await this.deps.connections?.disconnect(accountId, 'relink');
        const client = await this.getClient(accountId, '');
        await client.connect();
        const sent = await client.requestLoginCode(phoneNumber);
        this.assertSupportedDelivery(sent);
        await this.deps.challenges.update({
          id: challenge.id,
          payload: { phoneNumber, phoneCodeHash: sent.phoneCodeHash, tempSession: client.exportSession().session },
        });
        await recordAudit({
          action: 'telegram.login_code_requested',
          actorUserId: input.userId,
          targetType: 'telegram_account',
          targetId: accountId,
          outcome: 'success',
          metadata: { viaApp: sent.viaApp, relink: Boolean(input.accountId) },
        });
        return this.summary(accountId, 'code', sent, null, expiresAt);
      } catch (err) {
        await this.rollbackStart({ accountId, userId: input.userId, challengeId: challenge.id, created, err });
        throw this.toApiError(err, 'code');
      }
    });
  }

  // ── إعادة إرسال الرمز ────────────────────────────────────────────────────
  async resendCode(input: { userId: string; accountId: string }): Promise<LoginChallengeSummary> {
    return this.lock.run(input.accountId, async () => {
      const challenge = await this.requireChallenge(input.accountId, input.userId, 'code');
      if (challenge.resendCount >= this.deps.limits.maxResends) {
        throw tooManyRequests('تم بلوغ الحد الأقصى لإعادة إرسال الرمز لهذه المحاولة. ابدأ ربطاً جديداً.', 60);
      }
      const earliest = challenge.lastSentAt.getTime() + this.deps.limits.resendIntervalSeconds * 1000;
      if (this.now() < earliest) {
        const retryAfter = Math.max(1, Math.ceil((earliest - this.now()) / 1000));
        throw tooManyRequests('انتظر قليلاً قبل طلب رمز جديد.', retryAfter);
      }

      const client = await this.getClient(input.accountId, challenge.payload.tempSession);
      try {
        await client.connect();
        const sent = await client.requestLoginCode(challenge.payload.phoneNumber);
        this.assertSupportedDelivery(sent);
        await this.deps.challenges.update({
          id: challenge.id,
          payload: {
            phoneNumber: challenge.payload.phoneNumber,
            phoneCodeHash: sent.phoneCodeHash,
            tempSession: client.exportSession().session,
          },
        });
        await this.deps.challenges.registerResend(challenge.id);
        await recordAudit({
          action: 'telegram.login_code_resent',
          actorUserId: input.userId,
          targetType: 'telegram_account',
          targetId: input.accountId,
          outcome: 'success',
        });
        return this.summary(
          input.accountId,
          'code',
          sent,
          null,
          challenge.expiresAt,
          challenge.resendCount + 1,
        );
      } catch (err) {
        throw this.toApiError(err, 'code');
      }
    });
  }

  // ── إدخال الرمز ──────────────────────────────────────────────────────────
  async verifyCode(input: {
    userId: string;
    accountId: string;
    code: string;
  }): Promise<{ status: 'linked'; self: TelegramSelf } | LoginChallengeSummary & { status: 'password_required' }> {
    return this.lock.run(input.accountId, async () => {
      const challenge = await this.requireChallenge(input.accountId, input.userId, 'code');
      if (challenge.codeAttempts >= this.deps.limits.maxCodeAttempts) {
        throw new ApiError(423, 'code_attempts_exceeded', 'تجاوزت عدد المحاولات المسموح. ابدأ ربطاً جديداً.');
      }

      const attempts = await this.deps.challenges.registerAttempt({ id: challenge.id, kind: 'code' });
      const attemptsRemaining = Math.max(0, this.deps.limits.maxCodeAttempts - attempts);
      const client = await this.getClient(input.accountId, challenge.payload.tempSession);

      try {
        await client.connect();
        const outcome = await client.submitLoginCode({
          phoneNumber: challenge.payload.phoneNumber,
          phoneCodeHash: challenge.payload.phoneCodeHash,
          code: input.code,
        });
        if (outcome.status === 'password_required') {
          await this.deps.challenges.update({
            id: challenge.id,
            stage: 'password',
            expiresAt: this.expiryFromNow(),
            payload: {
              phoneNumber: challenge.payload.phoneNumber,
              phoneCodeHash: challenge.payload.phoneCodeHash,
              tempSession: client.exportSession().session,
            },
          });
          await recordAudit({
            action: 'telegram.login_password_required',
            actorUserId: input.userId,
            targetType: 'telegram_account',
            targetId: input.accountId,
            outcome: 'success',
          });
          const summary = this.summary(
            input.accountId,
            'password',
            null,
            outcome.hint,
            this.expiryFromNow(),
          );
          return { ...summary, status: 'password_required' as const };
        }
        await this.finalize(challenge, input.userId, client, outcome.self);
        return { status: 'linked', self: outcome.self };
      } catch (err) {
        throw this.mapCodeError(err, attemptsRemaining, challenge.id);
      }
    });
  }

  // ── كلمة مرور التحقق بخطوتين ─────────────────────────────────────────────
  async submitPassword(input: {
    userId: string;
    accountId: string;
    password: string;
  }): Promise<{ status: 'linked'; self: TelegramSelf }> {
    return this.lock.run(input.accountId, async () => {
      const challenge = await this.requireChallenge(input.accountId, input.userId, 'password');
      if (challenge.passwordAttempts >= this.deps.limits.maxPasswordAttempts) {
        throw new ApiError(423, 'password_attempts_exceeded', 'تجاوزت عدد المحاولات المسموح. ابدأ ربطاً جديداً.');
      }
      const attempts = await this.deps.challenges.registerAttempt({ id: challenge.id, kind: 'password' });
      const attemptsRemaining = Math.max(0, this.deps.limits.maxPasswordAttempts - attempts);
      const client = await this.getClient(input.accountId, challenge.payload.tempSession);

      try {
        await client.connect();
        const { self } = await client.submitPassword(input.password);
        await this.finalize(challenge, input.userId, client, self);
        return { status: 'linked', self };
      } catch (err) {
        throw this.mapPasswordError(err, attemptsRemaining);
      }
    });
  }

  // ── إلغاء محاولة ربط ─────────────────────────────────────────────────────
  async cancelLink(input: { userId: string; accountId: string }): Promise<void> {
    await this.lock.run(input.accountId, async () => {
      const account = await this.deps.accounts.findOwned(input.accountId, input.userId);
      if (!account) throw notFound('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.');
      await this.deps.challenges.closeAll(input.accountId);
      await this.dropClient(input.accountId);
      if (account.status === 'pending_login') {
        await this.deps.accounts.deletePendingAccount(input.accountId, input.userId);
      }
      await recordAudit({
        action: 'telegram.login_cancelled',
        actorUserId: input.userId,
        targetType: 'telegram_account',
        targetId: input.accountId,
        outcome: 'success',
      });
    });
  }

  // ── فصل الحساب ومسح جلسته ────────────────────────────────────────────────
  async unlinkAccount(input: { userId: string; accountId: string }): Promise<void> {
    await this.lock.run(input.accountId, async () => {
      const account = await this.deps.accounts.findOwned(input.accountId, input.userId);
      if (!account) throw notFound('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.');

      // 1) إيقاف القراءة أولاً على مستوى الاتصال (لا تغيير في قاعدة البيانات): لا يبقى قارئ يعمل.
      await this.deps.connections?.disconnect(input.accountId, 'unlink');
      await this.dropClient(input.accountId);

      // 2) كل تغييرات قاعدة البيانات في معاملة واحدة: المحاولات + الجلسة + حالة الحساب + المصادر + التدقيق.
      //    أي فشل في أي جزء يُلغي الكل، فلا يبقى «حساب مفصول ومصادر نشطة» ولا العكس.
      try {
        await withTransaction(async (client) => {
          await this.deps.challenges.closeAll(input.accountId, client);
          await deleteTelegramSession(input.accountId, input.userId, client);
          await this.deps.accounts.markRevoked(input.accountId, client);
          // مصادر الحساب تُوقَف وتُغلق فتراتها (تبقى ظاهرة للمستخدم بحالة paused).
          await this.deps.sources?.pauseForAccount(input.accountId, 'account_unlinked', client);
          await recordAudit(
            {
              action: 'telegram.account_unlinked',
              actorUserId: input.userId,
              targetType: 'telegram_account',
              targetId: input.accountId,
              outcome: 'success',
            },
            client,
          );
        });
      } catch (err) {
        // لا تغيير جزئي: الحالة في القاعدة كما كانت، فيمكن للمستخدم إعادة المحاولة.
        logger.error(
          { accountId: input.accountId, err: (err as Error).message },
          'فشل فصل حساب تيليجرام؛ أُلغيت العملية كاملة',
        );
        throw err;
      }
    });
  }

  /** تحرير العملاء المؤقتين عند إيقاف الخدمة (لا تُبقي اتصالات معلّقة). */
  async shutdown(): Promise<void> {
    const ids = [...this.clients.keys()];
    await Promise.all(ids.map((id) => this.dropClient(id)));
  }

  /**
   * ينظّف عملاء المصادقة المهجورين (تدقيق 2026-11-26).
   *
   * **التسرّب الذي كان قائماً:** كل محاولة ربط تُنشئ عميل MTProto مستقلاً يُحفظ في الذاكرة،
   * ولا يُفصل إلا عند النجاح/الفشل/الإلغاء أو إيقاف الخادم. من يبدأ الربط ويغلق الصفحة
   * يترك اتصالاً حيّاً إلى الأبد؛ عشرة مستخدمين كهؤلاء = عشرة اتصالات معلّقة تتزايد بلا حد.
   * الآن: من تجاوزت مدة صلاحية محاولته + مهلة سماح يُفصل ويُزاح من الذاكرة.
   */
  async sweepIdleClients(): Promise<number> {
    const ttlMs = this.deps.limits.ttlMinutes * 60_000;
    const maxIdleMs = ttlMs + 60_000;
    const now = this.now();
    const expired = [...this.clientTouched.entries()]
      .filter(([, touchedAt]) => now - touchedAt > maxIdleMs)
      .map(([accountId]) => accountId);
    for (const accountId of expired) await this.dropClient(accountId);
    return expired.length;
  }

  /** يبدأ مُنظِّف العملاء المهجورين (نبضة دقيقة واحدة). */
  startSweeper(intervalMs = 60_000): void {
    if (this.sweeperTimer) return;
    if (intervalMs <= 0) return;
    this.sweeperTimer = setInterval(() => {
      void this.sweepIdleClients().catch(() => undefined);
    }, intervalMs);
    this.sweeperTimer.unref?.();
  }

  stopSweeper(): void {
    if (this.sweeperTimer) clearInterval(this.sweeperTimer);
    this.sweeperTimer = null;
  }

  /** عدد عملاء المصادقة الحيّين — للتشخيص والاختبار. */
  get openClients(): number {
    return this.clients.size;
  }

  // ── داخلي ────────────────────────────────────────────────────────────────
  private requireGateway(): TelegramGateway {
    if (!this.deps.gateway) throw new TelegramNotConfiguredError();
    return this.deps.gateway;
  }

  private expiryFromNow(): Date {
    return new Date(this.now() + this.deps.limits.ttlMinutes * 60_000);
  }

  private async getClient(accountId: string, tempSession: string): Promise<TelegramLoginClient> {
    const existing = this.clients.get(accountId);
    if (existing) {
      // كل استخدام يُحدّث الطابع الزمني: محاولة يتابعها المستخدم لا تُعدّ مهجورة.
      this.clientTouched.set(accountId, this.now());
      return existing;
    }
    const client = this.requireGateway().createLoginClient({ accountId, savedSession: tempSession });
    this.clients.set(accountId, client);
    this.clientTouched.set(accountId, this.now());
    return client;
  }

  private async dropClient(accountId: string): Promise<void> {
    const client = this.clients.get(accountId);
    if (!client) return;
    this.clients.delete(accountId);
    this.clientTouched.delete(accountId);
    try {
      await client.disconnect();
    } catch {
      // فصل العميل المؤقت لا يُسقط العملية؛ الحالة النهائية محفوظة في القاعدة.
    }
  }

  private async requireChallenge(
    accountId: string,
    userId: string,
    stage: 'code' | 'password',
  ): Promise<LoginChallenge> {
    const account = await this.deps.accounts.findOwned(accountId, userId);
    if (!account) throw notFound('حساب تيليجرام غير موجود أو لا تملك صلاحية الوصول إليه.');
    const challenge = await this.deps.challenges.findActive({ accountId, userId });
    if (!challenge) {
      throw new ApiError(404, 'challenge_not_found', 'لا توجد محاولة ربط نشطة لهذا الحساب. ابدأ ربطاً جديداً.');
    }
    if (challenge.expiresAt.getTime() <= this.now()) {
      await this.deps.challenges.consume(challenge.id);
      await this.dropClient(accountId);
      throw new ApiError(410, 'challenge_expired', 'انتهت صلاحية محاولة الربط. ابدأ ربطاً جديداً.');
    }
    if (challenge.stage !== stage) {
      throw new ApiError(
        409,
        'unexpected_stage',
        stage === 'password'
          ? 'هذه المحاولة ليست بانتظار كلمة مرور التحقق بخطوتين.'
          : 'تم تجاوز خطوة الرمز لهذا الحساب.',
      );
    }
    return challenge;
  }

  private assertSupportedDelivery(sent: LoginCodeSent): void {
    if (sent.unsupportedDelivery) {
      throw badRequest(
        'unsupported_delivery',
        'يطلب تيليجرام تسجيل الدخول عبر البريد الإلكتروني لهذا الحساب، وهو غير مدعوم في هذه المرحلة.',
      );
    }
  }

  private async finalize(
    challenge: LoginChallenge,
    userId: string,
    client: TelegramLoginClient,
    self: TelegramSelf,
  ): Promise<void> {
    const snapshot = client.exportSession();
    if (!snapshot.session) {
      throw new ApiError(502, 'telegram_session_missing', 'لم تُعد المكتبة جلسة صالحة بعد المصادقة.');
    }
    await saveTelegramSession({
      accountId: challenge.accountId,
      userId,
      payload: { session: snapshot.session, updateState: snapshot.updateState },
    });
    await this.deps.accounts.markActive(challenge.accountId, self);
    await this.deps.challenges.consume(challenge.id);
    await this.dropClient(challenge.accountId);
    await recordAudit({
      action: 'telegram.account_linked',
      actorUserId: userId,
      targetType: 'telegram_account',
      targetId: challenge.accountId,
      outcome: 'success',
      metadata: { telegramUserId: 'present', twoFactor: challenge.stage === 'password' },
    });

    // التحقق من الاتصال يتم عبر مدير الاتصالات الحالي؛ فشله لا يُلغي نجاح الربط.
    if (this.deps.connections) {
      const state = await this.deps.connections.connect(challenge.accountId, userId);
      if (state.phase !== 'connected') {
        logger.warn(
          { accountId: challenge.accountId, phase: state.phase, code: state.lastErrorCode },
          'تم الربط لكن الاتصال لم يكتمل',
        );
      }
    }
  }

  private async rollbackStart(input: {
    accountId: string;
    userId: string;
    challengeId: string;
    created: boolean;
    err: unknown;
  }): Promise<void> {
    await this.deps.challenges.consume(input.challengeId).catch(() => undefined);
    await this.dropClient(input.accountId);
    if (input.created) {
      await deleteTelegramSession(input.accountId, input.userId).catch(() => undefined);
      await this.deps.accounts.deletePendingAccount(input.accountId, input.userId).catch(() => undefined);
    }
    const classified = classifyTelegramError(input.err);
    logger.warn({ code: classified.code, kind: classified.kind }, 'فشل بدء ربط حساب تيليجرام');
  }

  private toApiError(err: unknown, kind: 'code' | 'password'): ApiError {
    if (err instanceof ApiError) return err;
    const classified = classifyTelegramError(err);
    return this.fromClassified(classified, kind, null);
  }

  private mapCodeError(err: unknown, attemptsRemaining: number, _challengeId: string): ApiError {
    if (err instanceof ApiError) return err;
    const code = telegramErrorCode(err);
    if (code === 'PHONE_CODE_EXPIRED') {
      return new ApiError(410, 'code_expired', 'انتهت صلاحية رمز الدخول. اطلب رمزاً جديداً.');
    }
    if (code.startsWith('PHONE_CODE_') || code === 'PHONE_CODE_INVALID') {
      return new ApiError(
        400,
        'code_invalid',
        attemptsRemaining > 0
          ? `رمز الدخول غير صحيح. المحاولات المتبقية: ${attemptsRemaining}.`
          : 'رمز الدخول غير صحيح، ولم تعد هناك محاولات متبقية لهذه المحاولة.',
        { attemptsRemaining },
      );
    }
    return this.fromClassified(classifyTelegramError(err), 'code', attemptsRemaining);
  }

  private mapPasswordError(err: unknown, attemptsRemaining: number): ApiError {
    if (err instanceof ApiError) return err;
    const code = telegramErrorCode(err);
    if (code === 'PASSWORD_HASH_INVALID' || code === 'PASSWORD_EMPTY') {
      return new ApiError(
        400,
        'password_invalid',
        attemptsRemaining > 0
          ? `كلمة مرور التحقق بخطوتين غير صحيحة. المحاولات المتبقية: ${attemptsRemaining}.`
          : 'كلمة المرور غير صحيحة، ولم تعد هناك محاولات متبقية لهذه المحاولة.',
        { attemptsRemaining },
      );
    }
    return this.fromClassified(classifyTelegramError(err), 'password', attemptsRemaining);
  }

  private fromClassified(
    classified: ClassifiedTelegramError,
    kind: 'code' | 'password',
    attemptsRemaining: number | null,
  ): ApiError {
    if (classified.kind === 'flood_wait') {
      return tooManyRequests(
        `طلب تيليجرام الانتظار قبل إعادة المحاولة (${classified.waitSeconds ?? 'غير محدد'} ثانية).`,
        classified.waitSeconds ?? 60,
      );
    }
    if (classified.kind === 'network') {
      return new ApiError(503, 'telegram_unreachable', 'تعذّر الوصول إلى تيليجرام. تحقّق من الشبكة وأعد المحاولة.');
    }
    if (classified.kind === 'auth_revoked' || classified.kind === 'unauthorized') {
      return new ApiError(409, 'telegram_auth_rejected', 'رفض تيليجرام بيانات المصادقة. ابدأ ربطاً جديداً.');
    }
    logger.warn({ code: classified.code, kind, attemptsRemaining }, 'خطأ غير متوقع في ربط تيليجرام');
    return new ApiError(502, 'telegram_error', 'لم يكتمل الطلب مع تيليجرام. حاول لاحقاً.', {
      telegramCode: classified.code,
    });
  }

  private summary(
    accountId: string,
    stage: 'code' | 'password',
    sent: LoginCodeSent | null,
    hint: string | null,
    expiresAt: Date,
    resendCount = 0,
  ): LoginChallengeSummary {
    return {
      accountId,
      stage,
      viaApp: sent ? sent.viaApp : null,
      codeLength: sent?.codeLength ?? null,
      hint,
      expiresAt: expiresAt.toISOString(),
      resendAvailableAt:
        resendCount >= this.deps.limits.maxResends
          ? null
          : new Date(this.now() + this.deps.limits.resendIntervalSeconds * 1000).toISOString(),
      codeAttemptsRemaining: this.deps.limits.maxCodeAttempts,
      passwordAttemptsRemaining: stage === 'password' ? this.deps.limits.maxPasswordAttempts : null,
      resendsRemaining: Math.max(0, this.deps.limits.maxResends - resendCount),
    };
  }

  private toView(row: TelegramAccountListItem, userId: string): AccountView {
    const state = this.deps.connections?.getState(row.id, userId) ?? null;
    return {
      id: row.id,
      label: row.label,
      status: row.status,
      telegramUsername: row.telegramUsername,
      phoneLastDigits: row.phoneLastDigits,
      lastConnectedAt: row.lastConnectedAt ? row.lastConnectedAt.toISOString() : null,
      lastErrorCode: row.lastErrorCode,
      createdAt: row.createdAt.toISOString(),
      connection: state
        ? {
            phase: state.phase,
            connectedAt: state.connectedAt ? state.connectedAt.toISOString() : null,
            lastErrorCode: state.lastErrorCode,
            floodWaitSeconds: state.floodWaitSeconds,
            nextAttemptAt: state.nextAttemptAt ? state.nextAttemptAt.toISOString() : null,
            receivedMessages: state.receivedMessages,
          }
        : null,
    };
  }
}

function telegramErrorCode(err: unknown): string {
  const record = err as { errorMessage?: unknown; message?: unknown };
  if (typeof record?.errorMessage === 'string') return record.errorMessage;
  if (typeof record?.message === 'string') return record.message;
  return '';
}

/** مستخدمة من الطبقة الخارجية للتحقق من صحة الرقم قبل أي عملية. */
export { normalizePhoneNumber };

/** نوع مساعد يُبقي الاتصال بمستودع الاتصالات صريحاً في التهيئة. */
export type LoginServiceRepository = ConnectionRepository;
