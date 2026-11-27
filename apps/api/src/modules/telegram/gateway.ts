/**
 * عقد البوابة: واجهة مستقلة عن مكتبة MTProto.
 * هذا الفصل يسمح باختبار مدير الاتصالات بمحاكاة كاملة، ويُبقي الاحتياط (TDLib)
 * ممكناً بتنفيذ نفس العقد دون لمس بقية النظام.
 */
import type { StoredUpdateState } from 'teleproto/sessions';

export interface TelegramSelf {
  id: string;
  username?: string;
}

/** هوية مرسل الرسالة كما تصل من MTProto (بلا أي طلب شبكة إضافي). */
export interface IncomingSender {
  /** معرّف المستخدم الرقمي (PeerUser) إن كان المرسل مستخدماً. */
  id: string | null;
  /** اسم المستخدم العام (@) إن أرفقه التحديث. */
  username: string | null;
  /** الاسم المعروض (اسم + لقب، أو عنوان الجهة). */
  displayName: string | null;
  /** توقيع المنشور في القنوات (postAuthor) إن وُجد. */
  postAuthor: string | null;
}

export interface IncomingTextMessage {
  /** معرّف الحساب الداخلي (وليس حساب تيليجرام). */
  accountId: string;
  /** معرّف المحادثة بشكل مستقر: channel:<id> | chat:<id> | user:<id>. */
  peerKey: string;
  peerKind: 'channel' | 'group' | 'user' | 'unknown';
  messageId: number;
  /** نص الرسالة إن وُجد. */
  text: string;
  /** نص مصاحب لوسائط فقط؛ لا يُنزَّل أي وسيط (§5، D06). */
  caption: string;
  hasMedia: boolean;
  outgoing: boolean;
  sentAt: Date;
  /** true عند استلامها لاحقاً بعد انقطاع أو إعادة تشغيل (D03/O09). */
  missed: boolean;
  /** هوية المرسل (اختيارية: قد يغيب في تحديثات لا تُرفق بيانات المرسل). */
  sender?: IncomingSender | null;
}

export interface ConnectOutcome {
  authorized: boolean;
  self: TelegramSelf | null;
}

export interface SessionSnapshot {
  session: string;
  updateState?: StoredUpdateState;
}

/** نوع المصدر المدعوم في المرحلة الحالية: قناة بث أو مجموعة عظمى (megagroup). */
export type SourcePeerType = 'channel' | 'group';

/** مصدر متاح من قائمة محادثات الحساب (بيانات وصفية فقط، بلا محتوى رسائل). */
export interface AvailableSource {
  peerType: SourcePeerType;
  /** المعرّف الثابت من Telegram (نصي لأن bigint أكبر من Number الآمن). */
  peerId: string;
  title: string;
  username: string | null;
}

export interface ResolvedSource extends AvailableSource {
  /** هل الحساب عضو قادر على القراءة؟ */
  accessible: boolean;
  /** سبب تعذّر الوصول عند accessible=false. */
  reason?: 'not_member' | 'kicked' | 'unsupported_peer_type' | 'not_found';
}

export interface TelegramAccountClient {
  connect(): Promise<ConnectOutcome>;
  disconnect(): Promise<void>;
  checkAuthorization(): Promise<boolean>;
  getSelf(): Promise<TelegramSelf | null>;
  /**
   * اشتراك في الرسائل النصية الجديدة؛ يُعيد دالة إلغاء الاشتراك.
   * يجوز للمعالج أن يعيد Promise؛ حينها ينتظره العميل قبل تسليم التحديث التالي
   * (sequentialUpdates) وهذا شرط سلامة نقطة الاستئناف.
   */
  onIncomingText(handler: (message: IncomingTextMessage) => void | Promise<void>): () => void;
  /**
   * هل النقل متصل **الآن**؟ (تدقيق 2026-11-26)
   * المكتبة تعيد الاتصال داخلياً بلا إشعار، فبدون هذا الفحص لا يعرف مدير الاتصال
   * أن الحساب انقطع، وتبقى الواجهة تعرض «متصل» كذباً. اختياري: عميل لا يُفصح يُتجاهل.
   */
  isConnected?(): boolean;
  /** حالة التحديثات + سلسلة الجلسة للحفظ المشفّر. */
  exportSession(): SessionSnapshot;
  /**
   * قائمة القنوات والمجموعات المتاحة لهذا الحساب (بيانات وصفية فقط).
   * لا يجلب رسائل ولا تاريخاً ولا ينزّل وسائط.
   */
  listAvailableSources(input?: { limit?: number }): Promise<AvailableSource[]>;
  /**
   * يحل معرّفاً (اسم مستخدم عام أو معرّف رقمي) إلى هوية مصدر ثابتة ويتحقق من إمكانية القراءة.
   * لا يُنشئ عضوية ولا يرسل أي رسالة.
   */
  resolveSource(identifier: string): Promise<ResolvedSource>;
}

/** نتيجة إرسال رمز الدخول كما تعيدها المكتبة. */
export interface LoginCodeSent {
  /** بصمة الرمز المطلوبة لإكمال التسجيل — سرّية ولا تُعرض للواجهة ولا تُسجَّل. */
  phoneCodeHash: string;
  /** true إذا وصل الرمز إلى تطبيق تيليجرام بدل SMS. */
  viaApp: boolean;
  /** طول الرمز إن أعلنته المكتبة. */
  codeLength?: number;
  /** أنواع تسليم غير مدعومة في هذه المرحلة (بريد إلكتروني). */
  unsupportedDelivery?: 'email_required' | 'email_code';
}

/** نتيجة خطوة إدخال الرمز. */
export type LoginCodeOutcome =
  | { status: 'authorized'; self: TelegramSelf }
  | { status: 'password_required'; hint: string | null };

/**
 * عميل مصادقة أولية لحساب لم يكتمل تسجيله بعد.
 * منفصل عن TelegramAccountClient لأن دورة حياته (قبل وجود جلسة) مختلفة ولا تُخلط بالاتصالات.
 */
export interface TelegramLoginClient {
  connect(): Promise<void>;
  /** يطلب رمز الدخول ويعيد بصمة الرمز (لا يُخزَّن الرمز نفسه). */
  requestLoginCode(phoneNumber: string): Promise<LoginCodeSent>;
  /** يكمل التسجيل بالرمز؛ يعيد حاجة كلمة تحقق ثانية أو نجاحاً مع هوية الحساب. */
  submitLoginCode(input: { phoneNumber: string; phoneCodeHash: string; code: string }): Promise<LoginCodeOutcome>;
  /** يكمل التحقق بخطوتين؛ SRP يُحسب داخل المكتبة. */
  submitPassword(password: string): Promise<{ self: TelegramSelf }>;
  /** جلسة MTProto المؤقتة لحفظها مشفّرة (لا تُعرض ولا تُسجَّل). */
  exportSession(): SessionSnapshot;
  disconnect(): Promise<void>;
}

export interface TelegramGateway {
  /** ينشئ عميلاً مستقلاً لحساب واحد؛ لا يشارك العملاء بين الحسابات. */
  createAccountClient(input: {
    accountId: string;
    savedSession?: string;
    updateState?: StoredUpdateState;
  }): TelegramAccountClient;
  /** ينشئ عميل مصادقة أولية لحساب قيد الربط؛ لا يشاركه مع أي حساب آخر. */
  createLoginClient(input: { accountId: string; savedSession?: string }): TelegramLoginClient;
  readonly libraryName: string;
  readonly libraryVersion: string;
}
