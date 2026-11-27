/**
 * محاكاة بوابة تيليجرام ومستودع الحسابات — تُستخدم في اختبارات مدير الاتصالات
 * بلا أي اتصال حقيقي. هذه الأصناف للاختبار فقط ولا تُستخدم في تشغيل الإنتاج.
 */
import type { StoredUpdateState } from 'teleproto/sessions';
import type { ConnectionRepository, TelegramAccountRecord } from '../src/modules/telegram/accountRepository.js';
import { CheckpointGuard } from '../src/modules/telegram/checkpointGuard.js';
import type {
  AvailableSource,
  ConnectOutcome,
  IncomingTextMessage,
  LoginCodeOutcome,
  LoginCodeSent,
  ResolvedSource,
  SessionSnapshot,
  TelegramAccountClient,
  TelegramGateway,
  TelegramLoginClient,
  TelegramSelf,
} from '../src/modules/telegram/gateway.js';

export type ConnectScript = Array<() => Promise<ConnectOutcome>>;

const defaultOutcome = async (): Promise<ConnectOutcome> => ({
  authorized: true,
  self: { id: '999', username: 'fake_user' },
});

export class FakeAccountClient implements TelegramAccountClient {
  connectCalls = 0;
  disconnectCalls = 0;
  /** حال النقل كما يراه المدير عبر `isConnected` (محاكاة لانقطاع صامت). */
  transportUp = false;
  subscribers = new Set<(m: IncomingTextMessage) => void | Promise<void>>();
  savedUpdateState: StoredUpdateState | undefined;
  sessionString: string;
  /** عدّاد pts محاكى: يتقدّم قبل التسليم كما تفعل المكتبة الحقيقية. */
  private pts: number;
  /** نقطة الاستئناف التي وصلت من قاعدة البيانات عند إنشاء العميل (إن وُجدت). */
  readonly restoredPts: number | undefined;
  /** آخر لقطة حيّة (قبل الحرس) — تُستخدم لإثبات أن الحرس يمنع تقدّم المحفوظ. */
  private readonly checkpoint = new CheckpointGuard<StoredUpdateState>(() => this.liveState());

  constructor(
    readonly accountId: string,
    private readonly nextOutcome: () => Promise<ConnectOutcome>,
    session?: string,
    private readonly sourceConfig: FakeSourceConfig = defaultSourceConfig(),
    /** نقطة الاستئناف المحفوظة: تُحاكي عميلاً يعيد الاتصال من حالة تحديثات محفوظة. */
    restoredState?: StoredUpdateState,
  ) {
    this.sessionString = session ?? `fake-session-${accountId}`;
    this.restoredPts = restoredState?.pts;
    this.pts = restoredState?.pts ?? 0;
    if (restoredState) this.savedUpdateState = restoredState;
  }

  async listAvailableSources(): Promise<AvailableSource[]> {
    if (this.sourceConfig.listError) throw this.sourceConfig.listError;
    return [...this.sourceConfig.available];
  }

  async resolveSource(identifier: string): Promise<ResolvedSource> {
    if (this.sourceConfig.resolveError) throw this.sourceConfig.resolveError;
    // تُحاكي المحاكاة تطبيع المعرّف كما يفعل التنفيذ الحقيقي (@name / t.me/name / رقم).
    const normalized = identifier
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^(www\.)?t\.me\//i, '')
      .replace(/^@/, '');
    // يحاكي قواعد التحليل الحقيقية: المعرّفات السالبة وروابط الدعوة غير مدعومة.
    if (/^-\d{5,20}$/.test(normalized) || normalized.startsWith('+') || /^joinchat\//i.test(normalized)) {
      return { peerId: '0', peerType: 'channel', title: '', username: null, accessible: false, reason: 'unsupported_peer_type' };
    }
    const found = this.sourceConfig.resolved.get(identifier) ?? this.sourceConfig.resolved.get(normalized);
    if (!found) {
      return { peerId: '0', peerType: 'channel', title: '', username: null, accessible: false, reason: 'not_found' };
    }
    return found;
  }

  async connect(): Promise<ConnectOutcome> {
    this.connectCalls += 1;
    const outcome = await this.nextOutcome();
    this.transportUp = outcome.authorized;
    return outcome;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.transportUp = false;
    this.subscribers.clear();
  }

  /** حال النقل الحقيقي؛ يعيد false بعد انقطاع صامت أو إغلاق. */
  isConnected(): boolean {
    return this.transportUp;
  }

  /** محاكاة انقطاع صامت: المقبس مات والمكتبة لم تُبلّغ المدير. */
  dropTransport(): void {
    this.transportUp = false;
  }

  async checkAuthorization(): Promise<boolean> {
    return (await this.connect()).authorized;
  }

  async getSelf() {
    return { id: '999', username: 'fake_user' };
  }

  onIncomingText(handler: (message: IncomingTextMessage) => void | Promise<void>): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  exportSession(): SessionSnapshot {
    // كما في التنفيذ الحقيقي: تُحفظ نقطة الاستئناف المتحفّظة لا اللقطة الحيّة.
    return { session: this.sessionString, updateState: this.checkpoint.snapshot() };
  }

  /** معلومات الحرس للتشخيص والاختبار. */
  checkpointInfo(): { pending: number; pinned: boolean; failures: number } {
    return {
      pending: this.checkpoint.pending,
      pinned: this.checkpoint.isPinned,
      failures: this.checkpoint.failureCount,
    };
  }

  /** اللقطة الحيّة (pts) التي تتقدّم فور وصول التحديث — قبل حسم المعالجة. */
  liveState(): StoredUpdateState | undefined {
    // إن حدّد الاختبار حالة صريحة فهي «اللقطة الحيّة»؛ وإلا نستخدم عدّاد pts المحاكى.
    if (this.savedUpdateState) return this.savedUpdateState;
    return this.pts === 0 ? undefined : ({ pts: this.pts, qts: 0, date: 0, seq: 0 } as StoredUpdateState);
  }

  /**
   * محاكاة وصول رسالة نصية من المكتبة:
   * يتقدّم pts أولاً (كما في PtsWaiter)، ثم تُسلَّم الرسالة، ثم تُحسم النقطة عند النجاح فقط.
   */
  async emit(message: Partial<IncomingTextMessage> = {}): Promise<void> {
    const full: IncomingTextMessage = {
      accountId: this.accountId,
      peerKey: 'channel:1001',
      peerKind: 'channel',
      messageId: 5,
      text: 'نص تجريبي',
      caption: '',
      hasMedia: false,
      outgoing: false,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      missed: false,
      ...message,
    };

    this.pts += 1;
    this.checkpoint.begin();
    let ok = false;
    try {
      await Promise.all([...this.subscribers].map((subscriber) => subscriber(full)));
      ok = true;
    } finally {
      this.checkpoint.settle(ok);
    }
  }
}

/** سلوك عميل مصادقة محاكى: يمكن تخصيص كل خطوة أو إفشالها بخطأ RPC مصطنع. */
export interface FakeLoginBehaviour {
  requestCode?: (phoneNumber: string) => LoginCodeSent | Promise<LoginCodeSent>;
  submitCode?: (input: { phoneNumber: string; phoneCodeHash: string; code: string }) => LoginCodeOutcome | Promise<LoginCodeOutcome>;
  submitPassword?: (password: string) => { self: TelegramSelf } | Promise<{ self: TelegramSelf }>;
  session?: string;
}

/** خطأ RPC مصطنع يُحاكي أخطاء teleproto بالشكل (بلا اتصال). */
export function fakeTelegramError(errorMessage: string, code = 400): Error {
  const err = new Error(errorMessage);
  err.name = 'RPCError';
  return Object.assign(err, { errorMessage, code });
}

export const defaultLoginBehaviour: FakeLoginBehaviour = {
  requestCode: (phoneNumber) => ({
    phoneCodeHash: `hash-${phoneNumber.slice(-4)}`,
    viaApp: true,
    codeLength: 5,
  }),
  submitCode: ({ code }) =>
    code === '12345'
      ? { status: 'authorized', self: { id: '777', username: 'fake_login_user' } }
      : (() => {
          throw fakeTelegramError('PHONE_CODE_INVALID');
        })(),
  submitPassword: () => ({ self: { id: '777', username: 'fake_login_user' } }),
};

export class FakeLoginClient implements TelegramLoginClient {
  connectCalls = 0;
  disconnectCalls = 0;
  requestedPhones: string[] = [];
  submittedCodes: { phoneCodeHash: string; code: string }[] = [];
  submittedPasswords: string[] = [];
  sessionString: string;

  constructor(
    readonly accountId: string,
    private readonly behaviour: FakeLoginBehaviour,
    savedSession = '',
  ) {
    this.sessionString = savedSession || `fake-login-session-${accountId}`;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async requestLoginCode(phoneNumber: string): Promise<LoginCodeSent> {
    this.requestedPhones.push(phoneNumber);
    const handler = this.behaviour.requestCode ?? defaultLoginBehaviour.requestCode!;
    return handler(phoneNumber);
  }

  async submitLoginCode(input: {
    phoneNumber: string;
    phoneCodeHash: string;
    code: string;
  }): Promise<LoginCodeOutcome> {
    this.submittedCodes.push({ phoneCodeHash: input.phoneCodeHash, code: input.code });
    const handler = this.behaviour.submitCode ?? defaultLoginBehaviour.submitCode!;
    return handler(input);
  }

  async submitPassword(password: string): Promise<{ self: TelegramSelf }> {
    this.submittedPasswords.push(password);
    const handler = this.behaviour.submitPassword ?? defaultLoginBehaviour.submitPassword!;
    return handler(password);
  }

  exportSession(): SessionSnapshot {
    return { session: this.sessionString };
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }
}

/** إعدادات محاكاة المصادر: قائمة متاحة + خريطة حلّ معرّفات + أخطاء محتملة. */
export interface FakeSourceConfig {
  available: AvailableSource[];
  /** المفتاح: المعرّف كما يُرسله المستخدم (اسم مستخدم أو معرّف رقمي). */
  resolved: Map<string, ResolvedSource>;
  listError?: unknown;
  resolveError?: unknown;
}

export function defaultSourceConfig(): FakeSourceConfig {
  return { available: [], resolved: new Map() };
}

/** مصدر متاح/محلول جاهز للاختبار. */
export function fakeSource(input: {
  peerType?: 'channel' | 'group';
  peerId: string;
  title: string;
  username?: string | null;
  accessible?: boolean;
  reason?: ResolvedSource['reason'];
}): ResolvedSource {
  return {
    peerType: input.peerType ?? 'channel',
    peerId: input.peerId,
    title: input.title,
    username: input.username ?? null,
    accessible: input.accessible ?? true,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

export class FakeGateway implements TelegramGateway {
  readonly libraryName = 'fake-teleproto';
  readonly libraryVersion = '1.234.0';
  readonly created: FakeAccountClient[] = [];
  readonly loginCreated: FakeLoginClient[] = [];
  /** سلوكيات عميل المصادقة تُستهلك بالترتيب عند كل إنشاء عميل. */
  loginBehaviours: FakeLoginBehaviour[] = [];
  loginSessions = new Map<string, string>();
  /** إعدادات المصادر المشتركة بين عملاء الحسابات في هذه المحاكاة. */
  sourceConfig: FakeSourceConfig = defaultSourceConfig();
  /** هوية الحساب التي تعيدها المحاكاة عند الاتصال (افتراضياً 999). */
  outcomeSelf: TelegramSelf = { id: '999', username: 'fake_user' };
  /** حالة تحديثات أولية تُسلَّم للعميل الذي لا تصل إليه حالة محفوظة (لتهيئة سيناريو استئناف). */
  initialUpdateState: StoredUpdateState | undefined;

  constructor(
    private readonly script: ConnectScript = [],
    private readonly sessions = new Map<string, string>(),
  ) {}

  createAccountClient(input: {
    accountId: string;
    savedSession?: string;
    updateState?: StoredUpdateState;
  }): TelegramAccountClient {
    const client = new FakeAccountClient(
      input.accountId,
      // كل محاولة اتصال تستهلك الخطوة التالية من السيناريو، مثل عميل حقيقي يُعاد عليه connect()
      () => this.script.shift()?.() ?? Promise.resolve({ authorized: true, self: this.outcomeSelf }),
      input.savedSession ?? this.sessions.get(input.accountId),
      this.sourceConfig,
      // المحفوظ في قاعدة البيانات له الأولوية على الحالة الابتدائية المحاكاة.
      input.updateState ?? this.initialUpdateState,
    );
    this.created.push(client);
    return client;
  }

  createLoginClient(input: { accountId: string; savedSession?: string }): TelegramLoginClient {
    const behaviour = this.loginBehaviours.shift() ?? defaultLoginBehaviour;
    const client = new FakeLoginClient(
      input.accountId,
      behaviour,
      input.savedSession || this.loginSessions.get(input.accountId) || '',
    );
    this.loginSessions.set(input.accountId, client.sessionString);
    this.loginCreated.push(client);
    return client;
  }

  /** إضافة نتائج اتصال إلى السيناريو (للاختبارات التي تُشغّل الاتصال بعد البدء). */
  queueOutcome(...outcomes: ConnectOutcome[]): void {
    for (const outcome of outcomes) this.script.push(async () => outcome);
  }

  /** إضافة فشل اتصال (انقطاع شبكة/خطأ RPC) إلى السيناريو. */
  queueFailure(error: unknown): void {
    this.script.push(async () => {
      throw error;
    });
  }

  /** عدد العملاء المنشأين لحساب معيّن (لاختبار منع التكرار). */
  loginClientsFor(accountId: string): FakeLoginClient[] {
    return this.loginCreated.filter((c) => c.accountId === accountId);
  }
}

export class FakeRepository implements ConnectionRepository {
  accounts = new Map<string, TelegramAccountRecord>();
  sessions = new Map<string, { session: string; updateState?: StoredUpdateState }>();
  saveSessionCalls = 0;
  markConnectedCalls = 0;
  markNeedsReauthCalls = 0;
  markErrorCalls: string[] = [];
  deletedSessions = 0;

  addAccount(record: Partial<TelegramAccountRecord> & { id: string; userId: string }): TelegramAccountRecord {
    const full: TelegramAccountRecord = {
      label: 'حساب اختبار',
      status: 'active',
      telegramUserId: '999',
      telegramUsername: 'fake_user',
      ...record,
    };
    this.accounts.set(full.id, full);
    return full;
  }

  async findOwned(accountId: string, userId: string): Promise<TelegramAccountRecord | null> {
    const account = this.accounts.get(accountId);
    return account && account.userId === userId ? account : null;
  }

  async markConnected(accountId: string): Promise<void> {
    this.markConnectedCalls += 1;
    const account = this.accounts.get(accountId);
    if (account) account.status = 'active';
  }

  async markNeedsReauth(accountId: string, code: string): Promise<void> {
    this.markNeedsReauthCalls += 1;
    const account = this.accounts.get(accountId);
    if (account) {
      account.status = 'needs_reauth';
    }
    void code;
  }

  async markDisconnected(): Promise<void> {}

  async markError(_accountId: string, code: string): Promise<void> {
    this.markErrorCalls.push(code);
  }

  async loadSession(accountId: string) {
    const session = this.sessions.get(accountId);
    return session ? { ...session, keyVersion: 1 } : null;
  }

  async saveSession(accountId: string, _userId: string, payload: { session: string; updateState?: StoredUpdateState }) {
    this.saveSessionCalls += 1;
    this.sessions.set(accountId, payload);
  }

  async deleteSession(accountId: string): Promise<boolean> {
    this.deletedSessions += 1;
    return this.sessions.delete(accountId);
  }
}
