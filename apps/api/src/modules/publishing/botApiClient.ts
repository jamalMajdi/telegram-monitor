/**
 * عميل Telegram Bot API (Q2): `fetch` مدمج، مهلة صريحة، وتصنيف أخطاء حتمي.
 *
 * ضمانات أمنية:
 * - الرمز يظهر في مسار الطلب فقط، ولا يُسجَّل ولا يُضمَّن في أي رسالة خطأ (يُستبدل بـ[redacted]).
 * - لا تُعاد استجابة تيليجرام الخام للعميل؛ تُترجم إلى أنواع محدودة (هوية/محادثة/عضوية).
 * - المهلة إلزامية: طلب بلا استجابة لا يعلّق العامل (يُصنَّف `timeout`).
 *
 * ملاحظة نطاق: هذه الدفعة (7-أ) تحتاج getMe/getChat/getChatMember فقط؛
 * `sendMessage` يُضاف في دفعة الإرسال (7-د) مع تسجيل المحاولات.
 */
import { env } from '../../config/env.js';

export type BotApiErrorCode =
  | 'unauthorized' // رمز غير صالح (401)
  | 'chat_not_found' // المحادثة غير موجودة أو لا يراها البوت (400)
  | 'forbidden' // البوت ليس عضواً / لا يملك الصلاحية (403)
  | 'missing_rights' // عضو لكن بلا حق النشر
  | 'bot_blocked'
  | 'bad_request'
  | 'too_long' // تجاوز حد 4096 بعد تحليل الكيانات (يُعالج بسياسة الطول)
  | 'flood_wait' // 429 مع retry_after
  | 'network' // فشل اتصال قبل أي استجابة (الحالة مجهولة عند الإرسال — O04)
  | 'timeout'
  | 'server' // 5xx
  | 'unknown';

export class BotApiError extends Error {
  constructor(
    message: string,
    readonly code: BotApiErrorCode,
    readonly options: { httpStatus?: number | null; retryAfterSeconds?: number | null; method?: string } = {},
  ) {
    super(message);
    this.name = 'BotApiError';
  }

  get httpStatus(): number | null {
    return this.options.httpStatus ?? null;
  }

  get retryAfterSeconds(): number | null {
    return this.options.retryAfterSeconds ?? null;
  }
}

export interface BotIdentity {
  telegramId: string;
  username: string | null;
  firstName: string | null;
}

export type BotChatKind = 'channel' | 'supergroup' | 'group' | 'private' | 'unsupported';

export interface BotChatInfo {
  chatId: string;
  kind: BotChatKind;
  title: string;
  username: string | null;
}

export interface BotMemberInfo {
  /** member | administrator | creator | restricted | left | kicked */
  status: string;
  canPostMessages: boolean;
  canEditMessages: boolean;
}

export interface SendMessageInput {
  chatId: string;
  /** نص HTML آمن: مولَّد بعد الترميز والحجب فقط. */
  text: string;
  /** تعطيل معاينة الروابط (منع روابط خارجية غير مقصودة). */
  disablePreview?: boolean;
}

export interface SendMessageResult {
  messageId: string;
  chatId: string;
}

export interface BotApiClient {
  getMe(token: string): Promise<BotIdentity>;
  getChat(token: string, chatId: string): Promise<BotChatInfo>;
  getChatMember(token: string, chatId: string, userId: string): Promise<BotMemberInfo>;
  sendMessage(token: string, input: SendMessageInput): Promise<SendMessageResult>;
}

interface BotApiEnvelope {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface HttpBotApiOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** حقن fetch في الاختبارات (بدل الشبكة). */
  fetchImpl?: typeof fetch;
}

const MAX_DESCRIPTION_LENGTH = 200;

/** يستبدل الرمز في أي نص قبل تخزينه أو إظهاره. */
export function redactToken(text: string, token: string): string {
  const trimmed = text.slice(0, MAX_DESCRIPTION_LENGTH);
  if (!token) return trimmed;
  return trimmed.split(token).join('[redacted]');
}

export class HttpBotApiClient implements BotApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpBotApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? env.TG_BOT_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? env.TG_BOT_API_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getMe(token: string): Promise<BotIdentity> {
    const result = (await this.call(token, 'getMe', {})) as {
      id?: unknown;
      username?: unknown;
      first_name?: unknown;
    };
    const id = result?.id;
    if (typeof id !== 'number' && typeof id !== 'string') {
      throw new BotApiError('استجابة getMe لا تحمل معرّفاً صالحاً.', 'unknown', { method: 'getMe' });
    }
    return {
      telegramId: String(id),
      username: typeof result.username === 'string' ? result.username : null,
      firstName: typeof result.first_name === 'string' ? result.first_name : null,
    };
  }

  async getChat(token: string, chatId: string): Promise<BotChatInfo> {
    const result = (await this.call(token, 'getChat', { chat_id: chatId })) as {
      id?: unknown;
      type?: unknown;
      title?: unknown;
      username?: unknown;
    };
    if (result?.id === undefined || result?.id === null) {
      throw new BotApiError('استجابة getChat لا تحمل معرّفاً صالحاً.', 'unknown', { method: 'getChat' });
    }
    const type = typeof result.type === 'string' ? result.type : '';
    const kind: BotChatKind =
      type === 'channel'
        ? 'channel'
        : type === 'supergroup'
          ? 'supergroup'
          : type === 'group'
            ? 'group'
            : type === 'private'
              ? 'private'
              : 'unsupported';
    const username = typeof result.username === 'string' ? result.username : null;
    const title =
      typeof result.title === 'string' && result.title.trim().length > 0
        ? result.title.trim().slice(0, 200)
        : (username ?? String(result.id));
    return { chatId: String(result.id), kind, title, username };
  }

  async sendMessage(token: string, input: SendMessageInput): Promise<SendMessageResult> {
    const result = (await this.call(token, 'sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      parse_mode: 'HTML',
      ...(input.disablePreview === false ? {} : { link_preview_options: { is_disabled: true } }),
    })) as { message_id?: unknown; chat?: { id?: unknown } };
    if (result?.message_id === undefined || result.message_id === null) {
      throw new BotApiError('استجابة sendMessage لا تحمل معرّف رسالة.', 'unknown', { method: 'sendMessage' });
    }
    return {
      messageId: String(result.message_id),
      chatId: String(result.chat?.id ?? input.chatId),
    };
  }

  async getChatMember(token: string, chatId: string, userId: string): Promise<BotMemberInfo> {
    const result = (await this.call(token, 'getChatMember', { chat_id: chatId, user_id: userId })) as {
      status?: unknown;
      can_post_messages?: unknown;
      can_edit_messages?: unknown;
    };
    const status = typeof result?.status === 'string' ? result.status : 'left';
    return {
      status,
      canPostMessages: result?.can_post_messages === true,
      canEditMessages: result?.can_edit_messages === true,
    };
  }

  private async call(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${this.baseUrl}/bot${token}/${method}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new BotApiError(
        aborted ? 'انتهت مهلة طلب Bot API.' : 'تعذّر الوصول إلى Bot API (فشل اتصال).',
        aborted ? 'timeout' : 'network',
        { method },
      );
    }

    let payload: BotApiEnvelope | null = null;
    try {
      payload = (await response.json()) as BotApiEnvelope;
    } catch {
      payload = null;
    }

    if (response.ok && payload?.ok === true) {
      return payload.result;
    }

    const description = redactToken(
      typeof payload?.description === 'string' ? payload.description : `HTTP ${response.status}`,
      token,
    );
    const code = classifyBotApiFailure(response.status, description);
    throw new BotApiError(description || 'فشل طلب Bot API.', code, {
      httpStatus: response.status,
      retryAfterSeconds:
        typeof payload?.parameters?.retry_after === 'number' ? payload.parameters.retry_after : null,
      method,
    });
  }
}

/** تصنيف حتمي لاستجابة فاشلة (يُستخدم أيضاً في اختبارات التصنيف). */
export function classifyBotApiFailure(httpStatus: number, description: string): BotApiErrorCode {
  const text = description.toLowerCase();
  if (httpStatus === 401) return 'unauthorized';
  if (httpStatus === 429) return 'flood_wait';
  if (httpStatus >= 500) return 'server';
  if (text.includes('message is too long')) return 'too_long';
  if (text.includes('chat not found') || text.includes('peer_id_invalid')) return 'chat_not_found';
  if (text.includes('bot was blocked') || text.includes('user is blocked')) return 'bot_blocked';
  if (
    text.includes('not enough rights') ||
    text.includes('chat_admin_required') ||
    text.includes('chat_write_forbidden')
  ) {
    return 'forbidden';
  }
  if (httpStatus === 403) return 'forbidden';
  if (httpStatus === 400) return 'bad_request';
  return 'unknown';
}
