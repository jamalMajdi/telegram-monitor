/**
 * بوابة تيليجرام اصطناعية لاختبار **إعادة التشغيل الحقيقية** (عملية API تُقتل ثم تُشغَّل من جديد).
 *
 * تُحاكي جانب الخادم فقط: سجل رسائل ثابت (pts + معرّف رسالة)، وتسليم كل ما هو أحدث من نقطة
 * الاستئناف المستعادة — تماماً كما يعيد تيليجرام ما فات بعد الاتصال من `pts` محفوظ.
 * منطق الحارس المستخدم هنا هو `CheckpointGuard` الإنتاجي نفسه، و`exportSession` يرجع لقطته المحفوظة،
 * فلا تُختبر نسخة ثانية من المنطق.
 */
import { CheckpointGuard } from '../../src/modules/telegram/checkpointGuard.js';
import type {
  AvailableSource,
  ConnectOutcome,
  IncomingTextMessage,
  ResolvedSource,
  SessionSnapshot,
  TelegramAccountClient,
  TelegramGateway,
  TelegramLoginClient,
  TelegramSelf,
} from '../../src/modules/telegram/gateway.js';
import type { StoredUpdateState } from 'teleproto/sessions';

export interface ServerMessage {
  /** ترتيب التحديث في تيليجرام؛ يتقدّم قبل تسليم الرسالة. */
  pts: number;
  messageId: number;
  peerId: string;
  peerKind?: 'channel' | 'group';
  sentAt?: string;
}

export interface DeliveredRecord {
  pts: number;
  messageId: number;
  ok: boolean;
  error?: string;
}

export class RestartAccountClient implements TelegramAccountClient {
  readonly restoredPts: number | undefined;
  readonly delivered: DeliveredRecord[] = [];
  private pts: number;
  private connected = false;
  private replayStarted = false;
  private readonly subscribers = new Set<(message: IncomingTextMessage) => void | Promise<void>>();
  private readonly checkpoint: CheckpointGuard<StoredUpdateState>;

  constructor(
    readonly accountId: string,
    private readonly serverLog: ServerMessage[],
    restoredState?: StoredUpdateState,
  ) {
    this.restoredPts = restoredState?.pts;
    this.pts = restoredState?.pts ?? 0;
    this.checkpoint = new CheckpointGuard<StoredUpdateState>(
      () => this.liveState(),
      () => false,
      restoredState,
    );
  }

  async connect(): Promise<ConnectOutcome> {
    this.connected = true;
    return { authorized: true, self: { id: '999', username: 'restart_reader' } };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.subscribers.clear();
  }

  async checkAuthorization(): Promise<boolean> {
    return true;
  }

  async getSelf(): Promise<TelegramSelf | null> {
    return { id: '999', username: 'restart_reader' };
  }

  async listAvailableSources(): Promise<AvailableSource[]> {
    return [];
  }

  async resolveSource(): Promise<ResolvedSource> {
    return {
      peerId: '0',
      peerType: 'channel',
      title: '',
      username: null,
      accessible: false,
      reason: 'not_found',
    };
  }

  onIncomingText(handler: (message: IncomingTextMessage) => void | Promise<void>): () => void {
    this.subscribers.add(handler);
    // التسليم يبدأ بعد اشتراك المدير، مثل عميل حقيقي يبدأ استقبال التحديثات بعد الاتصال.
    if (this.connected && !this.replayStarted) {
      this.replayStarted = true;
      void this.replay();
    }
    return () => {
      this.subscribers.delete(handler);
    };
  }

  exportSession(): SessionSnapshot {
    return { session: `restart-session-${this.accountId}`, updateState: this.checkpoint.snapshot() };
  }

  checkpointInfo(): { pending: number; pinned: boolean; failures: number } {
    return {
      pending: this.checkpoint.pending,
      pinned: this.checkpoint.isPinned,
      failures: this.checkpoint.failureCount,
    };
  }

  /** اللقطة الحيّة التي تتقدّم قبل التسليم (كما في PtsWaiter). */
  liveState(): StoredUpdateState | undefined {
    return this.pts === 0 ? undefined : ({ pts: this.pts, qts: 0, date: 0, seq: 0 } as StoredUpdateState);
  }

  /**
   * يعيد تسليم كل ما هو أحدث من نقطة الاستئناف المستعادة، واحداً بعد الآخر (sequentialUpdates).
   * فشل معالج رسالة لا يوقف البقية — كما يفعل موزّع المكتبة.
   */
  private async replay(): Promise<void> {
    const floor = this.restoredPts ?? 0;
    const pending = [...this.serverLog].filter((m) => m.pts > floor).sort((a, b) => a.pts - b.pts);
    for (const entry of pending) {
      this.pts = entry.pts;
      this.checkpoint.begin();
      let ok = false;
      try {
        await Promise.all([...this.subscribers].map((subscriber) => subscriber(toMessage(this.accountId, entry))));
        ok = true;
        this.delivered.push({ pts: entry.pts, messageId: entry.messageId, ok: true });
      } catch (err) {
        this.delivered.push({ pts: entry.pts, messageId: entry.messageId, ok: false, error: (err as Error).message });
      } finally {
        // الفشل يُثبّت النقطة عند ما قبل الرسالة (لا تخطّي صامت).
        this.checkpoint.settle(ok);
      }
    }
  }
}

function toMessage(accountId: string, entry: ServerMessage): IncomingTextMessage {
  return {
    accountId,
    peerKey: `${entry.peerKind === 'group' ? 'chat' : 'channel'}:${entry.peerId}`,
    peerKind: entry.peerKind ?? 'channel',
    messageId: entry.messageId,
    text: 'نص لا يُحفظ',
    caption: '',
    hasMedia: false,
    outgoing: false,
    sentAt: new Date(entry.sentAt ?? '2026-11-24T12:00:00Z'),
    missed: false,
  };
}

export class RestartGateway implements TelegramGateway {
  readonly libraryName = 'restart-fake';
  readonly libraryVersion = '1.234.0';
  readonly created: RestartAccountClient[] = [];

  constructor(private readonly serverLog: ServerMessage[] = []) {}

  createAccountClient(input: {
    accountId: string;
    savedSession?: string;
    updateState?: StoredUpdateState;
  }): TelegramAccountClient {
    const client = new RestartAccountClient(input.accountId, this.serverLog, input.updateState);
    this.created.push(client);
    return client;
  }

  createLoginClient(): TelegramLoginClient {
    throw new Error('restart_harness_login_unused');
  }
}
