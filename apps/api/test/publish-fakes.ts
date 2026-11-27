/**
 * عميل Bot API مزيّف لاختبارات النشر: لا شبكة ولا رموز حقيقية.
 * يتحكم الاختبار في: الرموز الصالحة، بيانات المحادثات، عضوية البوت وصلاحياته، وأي فشل مصطنع.
 */
// أنواع فقط عند التحميل: صنف الخطأ يُحمَّل ديناميكياً حتى لا تُقرأ `env` قبل تهيئة الاختبار.
import type {
  BotApiClient,
  BotApiError,
  BotChatInfo,
  BotIdentity,
  BotMemberInfo,
  SendMessageInput,
  SendMessageResult,
} from '../src/modules/publishing/botApiClient.js';

type BotApiErrorClass = typeof import('../src/modules/publishing/botApiClient.js').BotApiError;
let cachedErrorClass: BotApiErrorClass | null = null;

async function errorClass(): Promise<BotApiErrorClass> {
  if (!cachedErrorClass) {
    const module = await import('../src/modules/publishing/botApiClient.js');
    cachedErrorClass = module.BotApiError;
  }
  return cachedErrorClass;
}

async function botError(
  message: string,
  code: ConstructorParameters<BotApiErrorClass>[1],
  options: ConstructorParameters<BotApiErrorClass>[2],
): Promise<BotApiError> {
  const Ctor = await errorClass();
  return new Ctor(message, code, options);
}

export interface FakeBotApiConfig {
  /** رمز ⇒ هوية البوت (getMe). */
  identities: Map<string, BotIdentity>;
  /** مفتاح lookup (chat_id نصي أو @username) ⇒ بيانات المحادثة (getChat). */
  chats: Map<string, BotChatInfo>;
  /** `chatId:userId` ⇒ عضوية البوت (getChatMember). */
  members: Map<string, BotMemberInfo>;
}

export function defaultBotApiConfig(): FakeBotApiConfig {
  return { identities: new Map(), chats: new Map(), members: new Map() };
}

export class FakeBotApiClient implements BotApiClient {
  readonly config: FakeBotApiConfig = defaultBotApiConfig();
  /** سجل استدعاءات بلا أي رمز (أسماء الدوال فقط). */
  readonly calls: string[] = [];
  /** خطأ مصطنع يُرفع مرة واحدة في الدالة المطلوبة. */
  readonly failures = new Map<string, BotApiError>();
  /** الرسائل «المرسلة» في الاختبارات (نص منسَّق محجوب فقط). */
  readonly sent: { chatId: string; text: string; messageId: string }[] = [];
  /** خطأ يُرفع في كل نداء sendMessage حتى يُمسح. */
  sendError: BotApiError | null = null;
  /** خطاف يُنفَّذ داخل sendMessage **قبل** رفع أي خطأ أو تسجيل نجاح. */
  onSend: ((input: SendMessageInput) => void | Promise<void>) | null = null;
  private nextMessageId = 900000;

  addBot(token: string, identity: BotIdentity): void {
    this.config.identities.set(token, identity);
  }

  addChat(key: string, chat: BotChatInfo): void {
    this.config.chats.set(key, chat);
    // تسجيل المعرّف نفسه كمرجع مباشر أيضاً.
    this.config.chats.set(chat.chatId, chat);
  }

  setMember(chatId: string, userId: string, member: BotMemberInfo): void {
    this.config.members.set(`${chatId}:${userId}`, member);
  }

  failOnce(method: 'getMe' | 'getChat' | 'getChatMember' | 'sendMessage', error: BotApiError): void {
    this.failures.set(method, error);
  }

  private takeFailure(method: string): BotApiError | null {
    const error = this.failures.get(method);
    if (!error) return null;
    this.failures.delete(method);
    return error;
  }

  async getMe(token: string): Promise<BotIdentity> {
    this.calls.push('getMe');
    const failure = this.takeFailure('getMe');
    if (failure) throw failure;
    const identity = this.config.identities.get(token);
    if (!identity) throw await botError('Unauthorized', 'unauthorized', { httpStatus: 401, method: 'getMe' });
    return identity;
  }

  async getChat(token: string, chatId: string): Promise<BotChatInfo> {
    this.calls.push('getChat');
    const failure = this.takeFailure('getChat');
    if (failure) throw failure;
    if (!this.config.identities.has(token)) {
      throw await botError('Unauthorized', 'unauthorized', { httpStatus: 401, method: 'getChat' });
    }
    const chat = this.config.chats.get(chatId);
    if (!chat) {
      throw await botError('Bad Request: chat not found', 'chat_not_found', {
        httpStatus: 400,
        method: 'getChat',
      });
    }
    return chat;
  }

  async getChatMember(token: string, chatId: string, userId: string): Promise<BotMemberInfo> {
    this.calls.push('getChatMember');
    const failure = this.takeFailure('getChatMember');
    if (failure) throw failure;
    if (!this.config.identities.has(token)) {
      throw await botError('Unauthorized', 'unauthorized', { httpStatus: 401, method: 'getChatMember' });
    }
    const member = this.config.members.get(`${chatId}:${userId}`);
    if (!member) {
      throw await botError('Bad Request: user not found', 'bad_request', {
        httpStatus: 400,
        method: 'getChatMember',
      });
    }
    return member;
  }

  async sendMessage(token: string, input: SendMessageInput): Promise<SendMessageResult> {
    this.calls.push('sendMessage');
    if (this.onSend) await this.onSend(input);
    const failure = this.takeFailure('sendMessage') ?? this.sendError;
    if (failure) throw failure;
    if (!this.config.identities.has(token)) {
      throw await botError('Unauthorized', 'unauthorized', { httpStatus: 401, method: 'sendMessage' });
    }
    if (!this.config.chats.has(input.chatId)) {
      throw await botError('Bad Request: chat not found', 'chat_not_found', {
        httpStatus: 400,
        method: 'sendMessage',
      });
    }
    this.nextMessageId += 1;
    const messageId = String(this.nextMessageId);
    this.sent.push({ chatId: input.chatId, text: input.text, messageId });
    return { messageId, chatId: input.chatId };
  }
}

/** رمز بوت صالح الشكل للاختبارات (ليس رمزاً حقيقياً). */
export function fakeBotToken(seed: number): string {
  const suffix = `${seed}`.padEnd(35, 'x');
  return `${100000000 + seed}:${suffix.replace(/[^A-Za-z0-9_-]/g, 'a')}`;
}
