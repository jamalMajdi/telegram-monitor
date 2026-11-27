/**
 * عميل API: كل الطلبات نسبية إلى أصل الواجهة (يمرّرها Vite إلى خدمة API في التطوير).
 * يحتفظ برمز CSRF في الذاكرة فقط، ويجدّده تلقائياً عند انتهاء الجلسة أو رفض الرمز.
 */

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: { field: string; message: string }[];
  retryAfterSeconds?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: { field: string; message: string }[];

  constructor(status: number, shape: ApiErrorShape) {
    super(shape.message);
    this.status = status;
    this.code = shape.code;
    this.details = shape.details;
  }
}

let csrfToken: string | null = null;
/**
 * رمز جلسة بديل يُحفظ في ذاكرة الصفحة فقط (لا في تخزين دائم):
 * يُستخدم حين يحجب المتصفح ملف تعريف الجلسة داخل إطار محجوز (بيئة المعاينة).
 * إن لم يمنحه الخادم يبقى null ويعمل مسار الكوكيز العادي كما هو.
 */
const TOKEN_KEY = 'tg_preview_token';

function readStoredToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // إطار محجوز: التخزين غير متاح ⇒ يبقى الرمز في الذاكرة فقط.
    return null;
  }
}

let accessToken: string | null = readStoredToken();

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // تجاهل: الرمز محفوظ في الذاكرة على أي حال.
  }
}

/**
 * تُرسل ترويستان: `x-session-token` (اسم مخصّص يعبر وكلاء المعاينة عادةً)
 * و`authorization: Bearer` (المعيار). الخادم يقبل أيّهما.
 */
function authHeaders(): Record<string, string> {
  if (!accessToken) return {};
  return { authorization: `Bearer ${accessToken}`, 'x-session-token': accessToken };
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  retryOnCsrfFailure?: boolean;
}

async function rawRequest(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders() };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken && options.method && options.method !== 'GET') headers['x-csrf-token'] = csrfToken;
  return fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function refreshCsrf(): Promise<boolean> {
  const res = await fetch('/api/v1/auth/session', {
    credentials: 'include',
    headers: { accept: 'application/json', ...authHeaders() },
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { authenticated: boolean; csrfToken?: string };
  if (data.authenticated && data.csrfToken) {
    csrfToken = data.csrfToken;
    return true;
  }
  csrfToken = null;
  return false;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await rawRequest(path, options);
  // 401 مع وجود رمز في الذاكرة: إعادة محاولة واحدة بترويسات محدَّثة قبل إعلان الفشل
  if (res.status === 401 && accessToken) {
    res = await rawRequest(path, options);
  }
  if (res.status === 403 && (options.method ?? 'GET') !== 'GET' && options.retryOnCsrfFailure !== false) {
    const body = (await res.clone().json().catch(() => null)) as { error?: ApiErrorShape } | null;
    if (body?.error?.code === 'csrf_failed' && (await refreshCsrf())) {
      res = await rawRequest(path, options);
    }
  }
  if (res.status === 204) return undefined as T;
  const payload = (await res.json().catch(() => null)) as { error?: ApiErrorShape } | T | null;
  if (!res.ok) {
    const shape =
      payload && typeof payload === 'object' && 'error' in payload && payload.error
        ? payload.error
        : { code: 'network_error', message: 'تعذّر إكمال الطلب. تحقّق من الاتصال وحاول مجدداً.' };
    throw new ApiError(res.status, shape);
  }
  return payload as T;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
}

/** نجاح الدخول: `accessToken` يظهر فقط في وضع المعاينة (بديل الكوكيز). */
export interface AuthSuccess {
  user: SessionUser;
  csrfToken: string;
  accessToken?: string;
}

export const authApi = {
  session: () => api<{ authenticated: boolean; user?: SessionUser; csrfToken?: string }>('/auth/session'),
  register: (body: { email: string; displayName: string; password: string }) =>
    api<AuthSuccess>('/auth/register', { method: 'POST', body }),
  login: (body: { email: string; password: string }) =>
    api<AuthSuccess>('/auth/login', { method: 'POST', body }),
  logout: () => api<void>('/auth/logout', { method: 'POST' }),
  forgot: (body: { email: string }) =>
    api<{ message: string; devResetToken?: string }>('/auth/password/forgot', { method: 'POST', body }),
  reset: (body: { token: string; password: string }) =>
    api<void>('/auth/password/reset', { method: 'POST', body }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    api<void>('/auth/password/change', { method: 'POST', body }),
};

export const meApi = {
  profile: () =>
    api<{
      user: SessionUser;
      settings: { contentRetentionHours: number };
      dangerZone: { purgePhrase: string; deletePhrase: string };
    }>('/me'),
  updateProfile: (body: { displayName: string }) =>
    api<{ user: SessionUser }>('/me', { method: 'PATCH', body }),
  sessions: () =>
    api<{
      sessions: {
        id: string;
        userAgent: string | null;
        ip: string | null;
        createdAt: string;
        lastSeenAt: string;
        expiresAt: string;
        current: boolean;
      }[];
    }>('/me/sessions'),
  revokeSession: (id: string) => api<void>(`/me/sessions/${id}`, { method: 'DELETE' }),
  revokeOthers: () => api<{ revoked: number }>('/auth/sessions/revoke-others', { method: 'POST' }),
  settings: () =>
    api<{
      settings: {
        contentRetentionHours: number;
        deliveryRetentionDays: number;
        notifications: Record<string, unknown>;
        processing: Record<string, unknown>;
        attribution: AttributionSettings;
        updatedAt: string | null;
      };
    }>('/me/settings'),
  updateSettings: (body: {
    contentRetentionHours?: number;
    deliveryRetentionDays?: number;
    attributionEnabled?: boolean;
    attributionMode?: AttributionBaseMode;
    attributionShowUsername?: boolean;
    attributionShowId?: boolean;
  }) =>
    api<{
      settings: {
        contentRetentionHours: number;
        deliveryRetentionDays: number;
        attribution: AttributionSettings;
        updatedAt: string;
      };
    }>('/me/settings', { method: 'PATCH', body }),
  /** حذف البيانات التشغيلية (Q21): عبارة تأكيد حرفية من الخادم. */
  purgeData: (body: { confirmation: string }) =>
    api<{ purgedAt: string; total: number; report: Record<string, number> }>('/me/data/purge', {
      method: 'POST',
      body,
    }),
  /** حذف الحساب نهائياً (Q22): كلمة المرور + عبارة التأكيد الحرفية. */
  deleteAccount: (body: { password: string; confirmation: string }) => api<void>('/me', { method: 'DELETE', body }),
};

export interface LogEntry {
  id: number;
  scope: 'telegram' | 'processing' | 'publishing' | 'auth' | 'system';
  kind: string;
  code: string;
  severity: 'warn' | 'error' | 'critical';
  detail: string | null;
  correlationId: string | null;
  occurredAt: string;
}

export interface LogsPageResponse {
  logs: LogEntry[];
  nextCursor: string | null;
}

export interface AdminErrorGroup {
  scope: string;
  kind: string;
  code: string;
  severity: string;
  occurrences: number;
  affectedUsers: number;
  lastOccurredAt: string;
}

export interface RetentionRun {
  id: number;
  policy: string;
  triggeredBy: string;
  startedAt: string;
  finishedAt: string | null;
  deleted: number;
  errorCode: string | null;
}

export const logsApi = {
  list: (params: { scope?: string; severity?: string; code?: string; limit?: number; cursor?: string | null } = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
    return api<LogsPageResponse>(`/logs?${search.toString()}`);
  },
};

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
  createdAt: string;
  lastLoginAt: string | null;
  activeSessions: number;
}

export interface DashboardCounts {
  telegram: { accounts: number; active: number; needsReauth: number; lastConnectedAt: string | null };
  sources: { total: number; active: number; paused: number };
  filters: { total: number; active: number };
  templates: { total: number };
  destinations: { total: number; active: number };
  messages: {
    matchedTotal: number;
    matchedLast24h: number;
    processedTotal: number;
    lastSeenAt: string | null;
  };
  deliveries: {
    total: number;
    awaitingReview: number;
    queued: number;
    published: number;
    publishedLast24h: number;
    failed: number;
    uncertain: number;
    blocked: number;
  };
}

export interface DashboardAlert {
  key: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  href: string;
}

export interface DashboardSummary {
  counts: DashboardCounts;
  alerts: DashboardAlert[];
  generatedAt: string;
  cached: boolean;
}

export interface DashboardActivityItem {
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  occurredAt: string;
}

export interface OpsMetrics {
  status: 'ok' | 'degraded';
  database: { ok: boolean; latencyMs: number | null };
  publishWorker: { state: 'ok' | 'stale' | 'missing'; lastSeenSeconds: number | null };
  queue: { pendingParts: number; oldestPendingAgeSeconds: number | null };
  deliveries24h: { published: number; failed: number; uncertain: number; partial: number; blocked: number };
  attempts1h: { retryable: number; permanent: number; uncertain: number; total: number };
  ingest: {
    lastMessageAt: string | null;
    messagesLast24h: number;
    accountsTotal: number;
    accountsActive: number;
    accountsNeedsReauth: number;
  };
  heartbeats: { name: string; instance: string; lastSeenSeconds: number; meta: Record<string, unknown> }[];
  staleAfterSeconds: number;
  checkedAt: string;
}

export const dashboardApi = {
  summary: (fresh = false) =>
    api<{ summary: DashboardSummary }>(`/dashboard/summary${fresh ? '?fresh=1' : ''}`),
  activity: (limit = 10) => api<{ activity: DashboardActivityItem[] }>(`/dashboard/activity?limit=${limit}`),
};

export const adminApi = {
  overview: () =>
    api<{
      overview: {
        users_total: number;
        users_active: number;
        users_suspended: number;
        admins_active: number;
        sessions_active: number;
        pending_notifications: number;
      };
    }>('/admin/overview'),
  metrics: () => api<{ metrics: OpsMetrics }>('/admin/metrics'),
  errors: (params: { windowHours?: number; scope?: string } = {}) =>
    api<{
      errors: {
        groups: AdminErrorGroup[];
        totals: { total: number; critical: number; byScope: Record<string, number> };
        windowHours: number;
      };
    }>(`/admin/errors?${new URLSearchParams(
      Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => [key, String(value)]),
    ).toString()}`),
  retentionRuns: (limit = 20) => api<{ runs: RetentionRun[] }>(`/admin/retention/runs?limit=${limit}`),
  runRetention: (body: { reason: string }) =>
    api<{ result: { runs: { policy: string; deleted: number; errorCode: string | null }[]; totalDeleted: number } }>(
      '/admin/retention/run',
      { method: 'POST', body },
    ),
  users: (params: { query?: string; status?: string; role?: string; limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    return api<{ users: AdminUser[]; total: number; limit: number; offset: number }>(`/admin/users?${search.toString()}`);
  },
  setStatus: (id: string, body: { status: 'active' | 'suspended'; reason: string }) =>
    api<void>(`/admin/users/${id}/status`, { method: 'PATCH', body }),
  setRole: (id: string, body: { role: 'user' | 'admin'; reason: string }) =>
    api<void>(`/admin/users/${id}/role`, { method: 'PATCH', body }),
  settings: () => api<{ settings: { key: string; value: Record<string, unknown>; description: string | null; updated_at: string }[] }>('/admin/settings'),
  updateSetting: (key: string, value: Record<string, unknown>) =>
    api<void>(`/admin/settings/${key}`, { method: 'PUT', body: { value } }),
  audit: (limit = 30) =>
    api<{
      events: {
        id: number;
        occurred_at: string;
        actor_user_id: string | null;
        actor_role: string | null;
        action: string;
        target_type: string | null;
        target_id: string | null;
        outcome: string;
        ip: string | null;
      }[];
    }>(`/admin/audit?limit=${limit}`),
};

export type TelegramAccountStatus = 'pending_login' | 'active' | 'needs_reauth' | 'revoked' | 'suspended';
export type TelegramConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'needs_reauth'
  | 'stopped'
  | 'unknown';

export interface TelegramAccount {
  id: string;
  label: string;
  status: TelegramAccountStatus;
  telegramUsername: string | null;
  phoneLastDigits: string | null;
  lastConnectedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  connection: {
    phase: TelegramConnectionPhase;
    connectedAt: string | null;
    lastErrorCode: string | null;
    floodWaitSeconds: number | null;
    nextAttemptAt: string | null;
    receivedMessages: number;
  } | null;
}

export interface LoginChallenge {
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

export type TelegramSourcePeerType = 'channel' | 'group';
export type TelegramSourceStatus = 'active' | 'paused';

export interface TelegramSource {
  id: string;
  accountId: string;
  accountLabel: string;
  accountStatus: string;
  peerType: TelegramSourcePeerType;
  peerId: string;
  title: string;
  username: string | null;
  status: TelegramSourceStatus;
  includeOwnMessages: boolean;
  monitoringStartedAt: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  connectionPhase: string;
}

export interface AvailableTelegramSource {
  peerType: TelegramSourcePeerType;
  peerId: string;
  title: string;
  username: string | null;
  alreadyMonitored: boolean;
  monitoringSourceId: string | null;
}

export interface TelegramSourceIngestStats {
  sourceId: string;
  title: string;
  username: string | null;
  peerType: TelegramSourcePeerType;
  peerId: string;
  status: TelegramSourceStatus;
  accountId: string;
  accountLabel: string;
  accountStatus: string;
  lastMessageAt: string | null;
  ingestedCount: string;
  duplicateCount: string;
  excludedCount: string;
  /** عدّادات المعالجة: مطابقة / متجاهلة / مكرّرة المحتوى / فاشلة. */
  matchedCount: string;
  ignoredCount: string;
  repeatCount: string;
  failedCount: string;
  /** عدد الرسائل التي أكملت الاستخراج (5-ج). */
  extractedCount: string;
  /** عدد الرسائل التي صنُّفت واختير لها قالب (6-أ/6-ب). */
  classifiedCount: string;
  lastErrorCode: string | null;
}

export interface TelegramIngestStatus {
  enabled: boolean;
  identityRetentionDays: number;
  /** عدّاد عام واحد للتحديثات غير المرتبطة بأي مصدر مراقب (بلا تفاصيل). */
  unmatchedUpdates: number;
  failedMessages: number;
  retries: number;
  duplicateReplays: number;
  since: string;
  sources: (TelegramSourceIngestStats & { connectionPhase: string })[];
}

export const telegramApi = {
  status: () => api<{ ready: boolean; library: { name: string; version: string }; accounts: number }>('/telegram/status'),
  accounts: () => api<{ accounts: TelegramAccount[]; ready: boolean }>('/telegram/accounts'),
  account: (id: string) => api<{ account: TelegramAccount }>(`/telegram/accounts/${id}`),
  startLink: (body: { phoneNumber: string; label?: string }) =>
    api<{ account: TelegramAccount; challenge: LoginChallenge }>('/telegram/accounts', { method: 'POST', body }),
  reauth: (id: string, body: { phoneNumber: string }) =>
    api<{ challenge: LoginChallenge }>(`/telegram/accounts/${id}/reauth`, { method: 'POST', body }),
  resendCode: (id: string) =>
    api<{ challenge: LoginChallenge }>(`/telegram/accounts/${id}/code`, { method: 'POST' }),
  verifyCode: (id: string, body: { code: string }) =>
    api<{ status: 'password_required'; challenge: LoginChallenge } | { status: 'linked'; account: TelegramAccount }>(
      `/telegram/accounts/${id}/verify`,
      { method: 'POST', body },
    ),
  submitPassword: (id: string, body: { password: string }) =>
    api<{ status: 'linked'; account: TelegramAccount }>(`/telegram/accounts/${id}/password`, {
      method: 'POST',
      body,
    }),
  cancel: (id: string) => api<void>(`/telegram/accounts/${id}/cancel`, { method: 'POST' }),
  connect: (id: string) => api<{ account: TelegramAccount }>(`/telegram/accounts/${id}/connect`, { method: 'POST' }),
  disconnect: (id: string) =>
    api<{ account: TelegramAccount }>(`/telegram/accounts/${id}/disconnect`, { method: 'POST' }),
  unlink: (id: string) => api<void>(`/telegram/accounts/${id}`, { method: 'DELETE' }),

  // ── المصادر (المرحلة الثانية — الخطوة الثالثة) ──────────────────────────
  sources: () => api<{ sources: TelegramSource[]; ready: boolean }>('/telegram/sources'),
  source: (id: string) => api<{ source: TelegramSource }>(`/telegram/sources/${id}`),
  availableSources: (accountId: string, limit = 100) =>
    api<{ sources: AvailableTelegramSource[] }>(`/telegram/accounts/${accountId}/sources/available?limit=${limit}`),
  addSource: (body: { accountId: string; identifier?: string; peerId?: string }) =>
    api<{ source: TelegramSource }>('/telegram/sources', { method: 'POST', body }),
  updateSource: (id: string, body: { includeOwnMessages: boolean }) =>
    api<{ source: TelegramSource }>(`/telegram/sources/${id}`, { method: 'PATCH', body }),
  pauseSource: (id: string) => api<{ source: TelegramSource }>(`/telegram/sources/${id}/pause`, { method: 'POST' }),
  resumeSource: (id: string) => api<{ source: TelegramSource }>(`/telegram/sources/${id}/resume`, { method: 'POST' }),
  refreshSource: (id: string) => api<{ source: TelegramSource }>(`/telegram/sources/${id}/refresh`, { method: 'POST' }),
  removeSource: (id: string) => api<void>(`/telegram/sources/${id}`, { method: 'DELETE' }),

  // ── حالة الالتقاط (الخطوة الرابعة) — قراءة فقط وبلا محتوى ────────────────
  ingestStatus: () => api<TelegramIngestStatus>('/telegram/ingest/status'),
  sourceIngest: (sourceId: string) =>
    api<{ source: TelegramSourceIngestStats & { connectionPhase: string } }>(
      `/telegram/sources/${sourceId}/ingest`,
    ),
};

export type TelegramReviewState = 'none' | 'needs_review' | 'reviewed';

export interface TelegramResultSummary {
  identityId: string;
  sourceId: string;
  sourceTitle: string;
  peerType: string;
  state: string;
  /** حالة النشر الموازية لحالة المعالجة (P4-هـ). */
  publishState: string;
  reviewState: TelegramReviewState;
  receivedAt: string;
  isRepeat: boolean;
  matchedCount: number;
  contactCount: number;
  extractionCount: number;
  classificationId: string | null;
  classificationName: string | null;
  classificationConfidence: number | null;
  classificationOrigin: 'automatic' | 'manual' | null;
  templateId: string | null;
  templateName: string | null;
  resolvedBy: string | null;
  contentAvailable: boolean;
}

export interface TelegramResultList {
  results: TelegramResultSummary[];
  /** مؤشِّر الصفحة التالية (P4-هـ). غيابه يعني نهاية النتائج. */
  nextCursor: string | null;
  limit: number;
  /** يُعاد فقط في وضع `offset` القديم. */
  total?: number;
  offset?: number;
}

export type TelegramPublishState = 'not_routed' | 'routed' | 'awaiting_review';

export interface JourneyEvent {
  at: string;
  stage: 'processing' | 'filtering' | 'classification' | 'routing' | 'publishing' | 'review';
  code: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface JourneyDelivery {
  id: string;
  status: string;
  destinationId: string;
  destinationTitle: string | null;
  planParts: number;
  sentParts: number;
  attempts: number;
  lastErrorCode: string | null;
  review: string;
  republishCount: number;
  lastRepublishedAt: string | null;
  republish: { allowed: boolean; reason: string | null; remaining: number };
  createdAt: string;
  publishedAt: string | null;
  parts: { partIndex: number; status: string; telegramMessageId: string | null; charCount: number }[];
  attemptsLog: { partIndex: number | null; attemptNo: number; outcome: string; errorCode: string | null; startedAt: string }[];
  evidence: { method: string; decision: string; note: string | null; decidedAt: string }[];
}

export interface MessageJourney {
  identityId: string;
  sourceId: string;
  sourceTitle: string;
  receivedAt: string;
  state: string;
  publishState: string;
  reviewState: string;
  contentAvailable: boolean;
  retentionExpiresAt: string | null;
  matchedFilters: { id: string; name: string; priority: number }[];
  classification: { name: string | null; origin: string | null; confidence: number | null; ambiguous: boolean } | null;
  template: { id: string | null; name: string | null; resolvedBy: string | null };
  deliveries: JourneyDelivery[];
  states: { processing: string; publishing: string; deliveryStatuses: string[] };
  timeline: JourneyEvent[];
}

// ——— مركز التنبيهات (P4-و) ———
export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type NotificationStatusFilter = 'open' | 'acknowledged' | 'all';

export interface AlertNotification {
  id: string;
  key: string;
  severity: NotificationSeverity;
  observedCount: number;
  occurrences: number;
  payload: Record<string, string | number | boolean | null>;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface NotificationCounts {
  open: number;
  unacknowledged: number;
  critical: number;
  warning: number;
  info: number;
}

export interface NotificationList {
  notifications: AlertNotification[];
  nextCursor: string | null;
  limit: number;
}

export const notificationsApi = {
  list: (params: { status?: NotificationStatusFilter; limit?: number; cursor?: string | null } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set('status', params.status);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.cursor) search.set('cursor', params.cursor);
    const query = search.toString();
    return api<NotificationList>(`/notifications${query ? `?${query}` : ''}`);
  },
  counts: () => api<{ counts: NotificationCounts }>('/notifications/counts'),
  acknowledge: (id: string) =>
    api<{ notification: AlertNotification }>(`/notifications/${id}/acknowledge`, { method: 'POST' }),
  acknowledgeAll: () => api<{ acknowledged: number }>('/notifications/acknowledge-all', { method: 'POST' }),
};

export interface TelegramRenderedField {
  key: string;
  label: string;
  value: string;
  masked: boolean;
  confidence?: number;
  ambiguous?: boolean;
}

export interface TelegramRenderedPost {
  templateId: string | null;
  templateName: string | null;
  fields: TelegramRenderedField[];
  missingFields: { key: string; label: string }[];
  text: string;
}

export interface TelegramResultDetail {
  message: TelegramResultSummary & {
    autoClassificationId: string | null;
    autoClassificationName: string | null;
    autoClassificationConfidence: number | null;
    manualClassificationId: string | null;
    manualClassificationName: string | null;
    extractionVersion: number | null;
    extractedAt: string | null;
    classification: {
      id: string | null;
      name: string | null;
      confidence: number | null;
      ambiguous: boolean;
      origin: 'automatic' | 'manual' | null;
      automatic: { id: string | null; name: string | null; confidence: number | null } | null;
      manual: { id: string | null; name: string | null } | null;
    };
  };
  /** أسباب وقف الرسالة للمراجعة (تُشتق من نفس شروط القرار على الخادم). */
  reviewHints: { code: string; label: string; value?: number }[];
  /** النص الأصلي مع تقنيع مواضع التواصل (لا تُعرض قيم خامة). */
  originalText: string | null;
  caption: string | null;
  fields: {
    key: string;
    value: string;
    confidence: number;
    ambiguous: boolean;
    source: string;
    span: [number, number];
    cue: string;
  }[];
  contacts: {
    kind: string;
    masked: string;
    confidence: number;
    ambiguous: boolean;
    source: string;
    span: [number, number];
  }[];
  filters: { id: string; name: string; priority: number }[];
  rendered: TelegramRenderedPost;
}

export interface TelegramClassification {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  enabled: boolean;
  isBuiltin: boolean;
  conditionCount: number;
  version: string;
}

export interface TelegramTemplateField {
  fieldKey: string;
  label: string;
  position: number;
  enabled: boolean;
}

export interface TelegramTemplate {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  enabled: boolean;
  isDefault: boolean;
  fields: TelegramTemplateField[];
  bindings: { sourceIds: string[]; filterIds: string[]; classificationIds: string[] };
}

export interface TelegramTemplatesResponse {
  templates: TelegramTemplate[];
  defaultTemplateId: string | null;
}


/** ── محرّك القواعد: فلاتر وتصنيفات (شاشات التحرير) ─────────────────────────── */

export type RuleMatchMode = 'word' | 'phrase' | 'contains';

export interface RuleConditionInput {
  mode: 'all' | 'any';
  negate?: boolean;
  minMatches?: number;
  terms?: string[];
  dictionaryId?: string | null;
  matchMode?: RuleMatchMode;
}

export interface RuleConditionView {
  id: string;
  position: number;
  mode: 'all' | 'any';
  negate: boolean;
  minMatches: number;
  dictionaryId: string | null;
  terms: { id: string; display: string; literal: boolean; matchMode: RuleMatchMode | null }[];
}

/**
 * ملخّص قاعدة كما تعيده قوائم الـAPI (`GET /telegram/filters`, `/telegram/classifications`).
 * **لا يحتوي `conditions`** — من يفترض وجودها ينكسر وقت التشغيل، لذا النوع هنا صريح ومختلف عن `RuleDetail`.
 */
export interface RuleSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  priority: number;
  isBuiltin: boolean;
  version: string;
  conditionCount: number;
  /** تظهر في ملخّص الفلاتر فقط. */
  scope?: 'all_sources' | 'bound_sources';
  appliesTo?: 'any' | 'text' | 'caption';
  termCount?: number;
  sourceIds?: string[];
  updatedAt?: string;
}

export interface RuleDetail {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  priority: number;
  scope: 'all_sources' | 'bound_sources';
  appliesTo: 'any' | 'text' | 'caption';
  isBuiltin: boolean;
  version: string;
  conditionCount: number;
  termCount: number;
  sourceIds: string[];
  updatedAt: string;
  conditions: RuleConditionView[];
}

export interface RuleDraft {
  name: string;
  description?: string | null;
  priority?: number;
  enabled?: boolean;
  scope?: 'all_sources' | 'bound_sources';
  appliesTo?: 'any' | 'text' | 'caption';
  conditions: RuleConditionInput[];
}

export interface RuleTestResult {
  matched: boolean;
  evaluated: number;
  normalizedPreview: string;
  matches: {
    ruleId: string;
    ruleName: string;
    priority: number;
    hits: { conditionId: string; mode: string; negate: boolean; satisfied: boolean; count: number; matchedTerms: string[] }[];
  }[];
}

export interface DictionarySummary {
  id: string;
  name: string;
  kind: string;
  termCount: number;
}

export const telegramRulesApi = {
  filters: () => api<{ filters: RuleSummary[] }>('/telegram/filters'),
  filter: (id: string) => api<{ filter: RuleDetail }>(`/telegram/filters/${id}`),
  createFilter: (body: RuleDraft) => api<{ filter: { id: string } }>('/telegram/filters', { method: 'POST', body }),
  updateFilter: (id: string, body: Partial<RuleDraft>) =>
    api<{ filter: { id: string } }>(`/telegram/filters/${id}`, { method: 'PATCH', body }),
  deleteFilter: (id: string) => api<void>(`/telegram/filters/${id}`, { method: 'DELETE' }),
  testDraft: (body: { definition: RuleDraft; text: string; caption?: string }) =>
    api<{ result: RuleTestResult }>('/telegram/filters/test', { method: 'POST', body }),
  testFilter: (id: string, body: { text: string; caption?: string }) =>
    api<{ result: RuleTestResult }>(`/telegram/filters/${id}/test`, { method: 'POST', body }),
  bindSources: (id: string, sourceIds: string[]) =>
    api<{ bound: number }>(`/telegram/filters/${id}/sources`, { method: 'POST', body: { sourceIds } }),
  dictionaries: () => api<{ dictionaries: DictionarySummary[] }>('/telegram/dictionaries'),
  classifications: () => api<{ classifications: RuleSummary[] }>('/telegram/classifications'),
  classification: (id: string) => api<{ classification: RuleDetail }>(`/telegram/classifications/${id}`),
  createClassification: (body: RuleDraft) =>
    api<{ classification: RuleDetail }>('/telegram/classifications', { method: 'POST', body }),
  updateClassification: (id: string, body: Partial<RuleDraft>) =>
    api<{ classification: RuleDetail }>(`/telegram/classifications/${id}`, { method: 'PATCH', body }),
  deleteClassification: (id: string) => api<void>(`/telegram/classifications/${id}`, { method: 'DELETE' }),
};

export const telegramResultsApi = {
  list: (
    params: {
      review?: TelegramReviewState;
      classificationId?: string;
      publishState?: TelegramPublishState;
      limit?: number;
      cursor?: string | null;
    } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.review) search.set('review', params.review);
    if (params.classificationId) search.set('classificationId', params.classificationId);
    if (params.publishState) search.set('publishState', params.publishState);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.cursor) search.set('cursor', params.cursor);
    const query = search.toString();
    return api<TelegramResultList>(`/telegram/results${query ? `?${query}` : ''}`);
  },
  detail: (identityId: string) => api<TelegramResultDetail>(`/telegram/results/${identityId}`),
  /** الخط الزمني الموحّد: المعالجة + التوجيه + التسليمات في قصة واحدة. */
  journey: (identityId: string) => api<{ journey: MessageJourney }>(`/telegram/results/${identityId}/journey`),
  /** إعادة النشر (Q20): إعادة تخطيط فقط، وممنوعة على النتيجة المجهولة. */
  republish: (deliveryId: string) =>
    api<{ delivery: { id: string; status: string; republishCount: number } }>(
      `/telegram/publish/deliveries/${deliveryId}/republish`,
      { method: 'POST' },
    ),
  review: (identityId: string, reviewState: 'needs_review' | 'reviewed') =>
    api<{ reviewState: string }>(`/telegram/results/${identityId}/review`, {
      method: 'POST',
      body: { reviewState },
    }),
  overrideClassification: (identityId: string, classificationId: string | null) =>
    api<{ classificationId: string | null }>(`/telegram/results/${identityId}/classification`, {
      method: 'POST',
      body: { classificationId },
    }),
  classifications: () => api<{ classifications: TelegramClassification[] }>('/telegram/classifications'),
  templates: () => api<TelegramTemplatesResponse>('/telegram/templates'),
};

// ── النشر (المرحلة الثالثة — الدفعتان 7-أ و7-ب) ──────────────────────────────

export type PublishBotStatus = 'active' | 'invalid' | 'disabled';
export type PublishDestinationStatus = 'pending' | 'active' | 'paused' | 'revoked' | 'error' | 'deleted';
export type PublishRouteStatus = 'draft' | 'active' | 'paused';
export type PublishRouteScopeKind = 'source' | 'filter' | 'classification';

export interface PublishBot {
  configured: boolean;
  status: PublishBotStatus | null;
  label: string | null;
  username: string | null;
  telegramId: string | null;
  verifiedAt: string | null;
  lastErrorCode: string | null;
  tokenUpdatedAt: string | null;
}

export interface PublishDestination {
  id: string;
  chatId: string;
  chatKind: 'channel' | 'supergroup' | 'group';
  title: string;
  username: string | null;
  status: PublishDestinationStatus;
  canPostMessages: boolean;
  canEditMessages: boolean;
  memberStatus: string | null;
  verifiedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  /** إخفاقات متتالية في آخر التسليمات المنتهية (0 = سليمة) — P0 تدقيق ما قبل التسليم. */
  failureStreak: number;
  lastFailureAt: string | null;
}

export interface PublishRoute {
  id: string;
  name: string;
  status: PublishRouteStatus;
  destinationId: string;
  destinationTitle: string | null;
  destinationStatus: string | null;
  scopes: { kind: PublishRouteScopeKind; targetId: string; label: string | null }[];
  templateId: string | null;
  templateName: string | null;
  publishMode: 'auto' | 'review';
  lengthPolicy: 'split' | 'reject';
  maxParts: number;
  /** null = يتبع إعداد المستخدم؛ 'off' = بلا هوية لهذه الوجهة وحدها. */
  attributionMode: AttributionMode | null;
  lastErrorCode: string | null;
  activatedAt: string | null;
  createdAt: string;
  edgeCount: number;
}

export interface PublishDelivery {
  id: string;
  identityId: string;
  destinationId: string;
  destinationTitle: string;
  routeId: string | null;
  status: string;
  review: string;
  reviewReason: string | null;
  planVersion: number;
  createdAt: string;
}

export interface PublishDeliveryPart {
  id: string;
  partIndex: number;
  text: string;
  charCount: number;
  status: string;
  telegramMessageId: string | null;
  attempts: number;
  lastErrorCode: string | null;
}

export interface PublishDeliveryDetail extends PublishDelivery {
  approvedVersion: number | null;
  chunkCount: number;
  attempts: number;
  lastErrorCode: string | null;
  nextAttemptAt: string | null;
  publishedAt: string | null;
  parts: PublishDeliveryPart[];
  evidence: { method: string; decision: string; telegramMessageId: string | null; note: string | null; decidedAt: string }[];
  attemptLog: {
    partIndex: number | null;
    attemptNo: number;
    outcome: string;
    httpStatus: number | null;
    errorCode: string | null;
    startedAt: string;
    finishedAt: string | null;
  }[];
}

export type PublishEvidenceInput = {
  method: 'message_id' | 'manual_check';
  decision: 'published' | 'not_published';
  telegramMessageId?: string;
  note?: string;
};

/** هوية المصدر والمرسل: ما يُعرض أسفل المنشور. */
export type AttributionMode = 'off' | 'source' | 'sender' | 'both';
export type AttributionBaseMode = Exclude<AttributionMode, 'off'>;

export interface AttributionSettings {
  enabled: boolean;
  mode: AttributionBaseMode;
  showUsername: boolean;
  showId: boolean;
}

export interface PublishStatus {
  ready: boolean;
  reason: string | null;
  bot: PublishBot;
  destinations: { total: number; active: number };
  routes: { total: number; active: number };
  deliveries: { total: number; awaitingReview: number };
}

export interface PublishRouteInput {
  name: string;
  destinationId: string;
  scopes: { kind: PublishRouteScopeKind; targetId: string }[];
  templateId?: string | null;
  publishMode?: 'auto' | 'review';
  lengthPolicy?: 'split' | 'reject';
  maxParts?: number;
  attributionMode?: AttributionMode | null;
}

export const publishApi = {
  status: () => api<PublishStatus>('/telegram/publish/status'),
  bot: () => api<{ bot: PublishBot; ready: boolean; reason: string | null }>('/telegram/publish/bot'),
  connectBot: (body: { token: string; label?: string }) =>
    api<{ bot: PublishBot }>('/telegram/publish/bot', { method: 'POST', body }),
  verifyBot: () => api<{ bot: PublishBot }>('/telegram/publish/bot/verify', { method: 'POST' }),
  disableBot: () => api<void>('/telegram/publish/bot', { method: 'DELETE' }),
  destinations: () => api<{ destinations: PublishDestination[] }>('/telegram/publish/destinations'),
  addDestination: (body: { identifier: string }) =>
    api<{ destination: PublishDestination }>('/telegram/publish/destinations', { method: 'POST', body }),
  verifyDestination: (id: string) =>
    api<{ destination: PublishDestination }>(`/telegram/publish/destinations/${id}/verify`, { method: 'POST' }),
  pauseDestination: (id: string) =>
    api<{ destination: PublishDestination }>(`/telegram/publish/destinations/${id}/pause`, { method: 'POST' }),
  resumeDestination: (id: string) =>
    api<{ destination: PublishDestination }>(`/telegram/publish/destinations/${id}/resume`, { method: 'POST' }),
  removeDestination: (id: string) => api<void>(`/telegram/publish/destinations/${id}`, { method: 'DELETE' }),
  routes: () => api<{ routes: PublishRoute[] }>('/telegram/publish/routes'),
  createRoute: (body: PublishRouteInput) =>
    api<{ route: PublishRoute }>('/telegram/publish/routes', { method: 'POST', body }),
  updateRoute: (id: string, body: PublishRouteInput) =>
    api<{ route: PublishRoute }>(`/telegram/publish/routes/${id}`, { method: 'PATCH', body }),
  activateRoute: (id: string) =>
    api<{ route: PublishRoute }>(`/telegram/publish/routes/${id}/activate`, { method: 'POST' }),
  deactivateRoute: (id: string) =>
    api<{ route: PublishRoute }>(`/telegram/publish/routes/${id}/deactivate`, { method: 'POST' }),
  removeRoute: (id: string) => api<void>(`/telegram/publish/routes/${id}`, { method: 'DELETE' }),
  deliveries: (limit = 30) => api<{ deliveries: PublishDelivery[] }>(`/telegram/publish/deliveries?limit=${limit}`),
  deliveryDetail: (id: string) => api<{ delivery: PublishDeliveryDetail }>(`/telegram/publish/deliveries/${id}`),
  approveDelivery: (id: string) =>
    api<{ delivery: PublishDeliveryDetail }>(`/telegram/publish/deliveries/${id}/approve`, { method: 'POST' }),
  rejectDelivery: (id: string, reason?: string) =>
    api<{ delivery: PublishDeliveryDetail }>(`/telegram/publish/deliveries/${id}/reject`, {
      method: 'POST',
      body: reason ? { reason } : {},
    }),
  recordDeliveryEvidence: (id: string, body: PublishEvidenceInput) =>
    api<{ delivery: PublishDeliveryDetail }>(`/telegram/publish/deliveries/${id}/evidence`, { method: 'POST', body }),
  /** قائمة الفلاتر لاختيارها كشروط مسار (نفس واجهة الفلاتر القائمة). */
  filters: () => api<{ filters: { id: string; name: string; priority: number; enabled: boolean }[] }>('/telegram/filters'),
};
