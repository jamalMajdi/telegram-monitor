/**
 * عميل SMTP أدنى، بلا أي اعتماد خارجي (P0 — تدقيق ما قبل التسليم).
 *
 * لماذا مكتوب يدوياً؟ المشروع يرفض الاعتمادات غير الضرورية، والمطلوب مسار واحد فقط:
 * تسليم رسالة نصية UTF-8 عبر خادم SMTP مع STARTTLS أو TLS مباشر ومصادقة PLAIN/LOGIN.
 * لا مرفقات، لا HTML معقّد، لا قوائم بريد.
 *
 * ما يضمنه:
 * - **لا تسجيل لأسرار**: كلمة مرور SMTP والرمز المُرسَل لا يظهران في أي رسالة خطأ.
 * - **حدود زمنية**: كل أمر له مهلة، وفشلها فشلٌ صريح يُعيد المحاولة لاحقاً (المستهلك يقرر).
 * - **STARTTLS إلزامي إن أُعلن**: لا نُكمل بالبريد الصريح إذا أعلن الخادم دعم الترقية.
 * - ترميز الموضوع والجسم base64 UTF-8، فتصل العربية سليمة في كل العملاء.
 *
 * ما لا يضمنه (موثّق صراحة): لا DKIM/SPF (مسؤولية نطاق العميل)، ولا قوائم انتظار داخلية
 * (هذا عمل `outboxWorker`).
 */
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';

export interface SmtpConfig {
  host: string;
  port: number;
  /** TLS من البداية (465) أو STARTTLS (587). */
  secure: boolean;
  user?: string | undefined;
  pass?: string | undefined;
  from: string;
  fromName: string;
  timeoutMs: number;
  /**
   * شهادة CA بديلة للتحقق من شهادة الخادم (شبكة داخلية بـCA خاص، أو اختبار).
   * لا يوجد خيار «تعطيل التحقق»: التحقق من الشهادة ليس قابلاً للإيقاف هنا.
   */
  ca?: string | undefined;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
  /** رأس `Message-ID`؛ يُولَّد تلقائياً عند غيابه. */
  messageId?: string;
}

export interface SmtpSendResult {
  ok: boolean;
  /** رمز خطأ مغلق (بلا نص خادم قد يحمل تفاصيل حساسة). */
  errorCode?: 'not_configured' | 'connect_failed' | 'tls_unavailable' | 'auth_failed' | 'rejected' | 'timeout' | 'protocol';
  /** لمحة قصيرة للتشخيص في سجل الأخطاء (تُقصّ ولا تحمل أسراراً). */
  detail?: string;
}

export interface SmtpClient {
  readonly configured: boolean;
  send(message: SmtpMessage): Promise<SmtpSendResult>;
}

/** يُنقّي أي نص يعود من الخادم قبل تسجيله: لا كلمات مرور ولا رموز. */
function scrub(value: string, secrets: string[]): string {
  let out = value.replace(/[\r\n]+/g, ' ');
  for (const secret of secrets) {
    if (secret && secret.length >= 3) out = out.split(secret).join('***');
  }
  return out.slice(0, 160);
}

function isValidAddress(value: string): boolean {
  // تحقّق شكلي فقط: لا نرفض عناوين صحيحة غريبة، ونمنع حقن الرؤوس بفواصل الأسطر.
  return /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/.test(value) && !/[\r\n]/.test(value);
}

class SmtpSession {
  private buffer = '';
  /** أسطر الرد متعدد الأسطر المتراكمة (SMTP يسمح بـ`250-` ثم سطر نهائي `250 `). */
  private pending: string[] = [];
  private readonly waiters: { resolve: (line: string) => void; reject: (err: Error) => void }[] = [];
  private failure: Error | null = null;

  constructor(
    private socket: Socket | TLSSocket,
    private readonly timeoutMs: number,
  ) {
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    socket.on('error', (err: Error) => this.fail(err));
    socket.on('close', () => this.fail(new Error('connection_closed')));
  }

  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
  }

  private drain(): void {
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index === -1) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.pending.push(line);
      /**
       * رد SMTP إما سطر واحد (`250 ok`) أو عدة أسطر: كل الأسطر المتوسطة تبدأ `250-`
       * والسطر الأخير `250 ` (أو `250` وحده). كنا نُسلّم السطر الأخير وحده، فتضيع قدرات
       * مثل STARTTLS المعلنة في الأسطر السابقة — وهذا ما اكتشفه الاختبار.
       */
      if (/^\d{3}( |$)/.test(line)) {
        const reply = this.pending.join('\n');
        this.pending = [];
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(reply);
      }
    }
  }

  read(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      setTimeout(() => reject(new Error('smtp_timeout')), this.timeoutMs).unref();
    });
  }

  /** كتابة خام بلا CRLF مُضاف (يحتاجها جسم الرسالة المنتهي بنقطة). */
  writeRaw(chunk: string): void {
    this.socket.write(chunk);
  }

  async command(line: string, expect: number[]): Promise<string> {
    this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    const code = Number(reply.slice(0, 3));
    if (!expect.includes(code)) {
      throw Object.assign(new Error(`smtp_reply_${code}`), { reply });
    }
    return reply;
  }

  async upgrade(ca?: string | undefined): Promise<void> {
    const upgraded = await new Promise<TLSSocket>((resolve, reject) => {
      const secure = tlsConnect(
        { socket: this.socket as Socket, servername: undefined, ...(ca ? { ca } : {}) },
        () => resolve(secure),
      );
      secure.once('error', reject);
      setTimeout(() => reject(new Error('smtp_timeout')), this.timeoutMs).unref();
    });
    upgraded.removeAllListeners('data');
    upgraded.removeAllListeners('error');
    upgraded.removeAllListeners('close');
    this.socket = upgraded;
    this.buffer = '';
    this.pending = [];
    this.failure = null;
    this.attach(upgraded);
  }

  close(): void {
    try {
      this.socket.end();
    } catch {
      // إغلاق مقبس ميت لا يهم.
    }
  }
}

export class SmtpMailer implements SmtpClient {
  constructor(
    private readonly config: SmtpConfig | null,
    private readonly logger?: Logger,
  ) {}

  get configured(): boolean {
    return this.config !== null;
  }

  async send(message: SmtpMessage): Promise<SmtpSendResult> {
    const config = this.config;
    if (!config) return { ok: false, errorCode: 'not_configured' };
    if (!isValidAddress(message.to)) return { ok: false, errorCode: 'rejected', detail: 'recipient_invalid' };
    const secrets = [config.pass ?? '', config.user ?? ''];

    let session: SmtpSession | null = null;
    try {
      const socket = await this.openSocket(config);
      session = new SmtpSession(socket, config.timeoutMs);
      const greeting = await session.read();
      if (Number(greeting.slice(0, 3)) !== 220) {
        throw Object.assign(new Error('smtp_greeting'), { reply: greeting });
      }

      const heloName = isIP(config.host) ? '[127.0.0.1]' : 'localhost';
      let ehlo = await session.command(`EHLO ${heloName}`, [250]);
      const supportsStartTls = /STARTTLS/i.test(ehlo);

      if (!config.secure && supportsStartTls) {
        await session.command('STARTTLS', [220]);
        await session.upgrade(config.ca);
        ehlo = await session.command(`EHLO ${heloName}`, [250]);
      } else if (!config.secure && config.user) {
        // مصادقة على قناة صريحة = رفض: كلمة المرور لا تُرسل بلا تشفير.
        return { ok: false, errorCode: 'tls_unavailable', detail: 'starttls_not_offered' };
      }
      void ehlo;

      if (config.user && config.pass) {
        const authMechanisms = /AUTH[ =][^\r\n]*/i.exec(ehlo)?.[0] ?? '';
        if (!/PLAIN|LOGIN/i.test(authMechanisms)) {
          return { ok: false, errorCode: 'auth_failed', detail: 'no_supported_auth' };
        }
        const loginFlow = async (): Promise<void> => {
          await session!.command('AUTH LOGIN', [334]);
          await session!.command(Buffer.from(config.user as string, 'utf8').toString('base64'), [334]);
          await session!.command(Buffer.from(config.pass as string, 'utf8').toString('base64'), [235]);
        };
        // PLAIN أولاً (أبسط وأكثر دعماً)، ثم LOGIN **فقط** إذا كان PLAIN غير مدعوم.
        try {
          if (/PLAIN/i.test(authMechanisms)) {
            const plain = Buffer.from(`\u0000${config.user}\u0000${config.pass}`, 'utf8').toString('base64');
            await session.command(`AUTH PLAIN ${plain}`, [235]);
          } else {
            await loginFlow();
          }
        } catch (err) {
          const reply = (err as { reply?: string }).reply ?? '';
          const code = Number(reply.slice(0, 3));
          /** 535/534/530: بيانات دخول مرفوضة — إعادة المحاولة ببيانات نفسها عبث. */
          if (code === 535 || code === 534 || code === 530) {
            return { ok: false, errorCode: 'auth_failed', detail: scrub(`smtp_reply_${code} ${reply}`, secrets) };
          }
          /** 500/501/504: الميكانيزم نفسه غير معروف ⇒ جرّب الآخر مرة واحدة. */
          if (code === 500 || code === 501 || code === 504) {
            try {
              if (/PLAIN/i.test(authMechanisms)) await loginFlow();
              else throw err;
            } catch (second) {
              const secondReply = (second as { reply?: string }).reply ?? (second as Error).message ?? '';
              return { ok: false, errorCode: 'auth_failed', detail: scrub(String(secondReply), secrets) };
            }
          } else {
            throw err;
          }
        }
      }

      await session.command(`MAIL FROM:<${config.from}>`, [250]);
      await session.command(`RCPT TO:<${message.to}>`, [250, 251]);
      await session.command('DATA', [354]);

      const body = this.buildMessage(config, message);
      session.writeRaw(`${body}\r\n.\r\n`);
      const done = await session.read();
      const code = Number(done.slice(0, 3));
      if (code !== 250) {
        return { ok: false, errorCode: 'rejected', detail: `smtp_reply_${code}` };
      }
      await session.command('QUIT', [221]).catch(() => undefined);
      return { ok: true };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const reply = (err as { reply?: string }).reply;
      const detail = scrub(reply ? `${raw} ${reply}` : raw, secrets);
      const errorCode: SmtpSendResult['errorCode'] =
        raw === 'smtp_timeout'
          ? 'timeout'
          : raw.startsWith('smtp_reply_5') || raw === 'smtp_greeting'
            ? 'rejected'
            : raw.startsWith('smtp_reply_4')
              ? 'connect_failed'
              : 'protocol';
      this.logger?.warn({ errorCode, detail }, 'فشل تسليم بريد عبر SMTP');
      return { ok: false, errorCode, detail };
    } finally {
      session?.close();
    }
  }

  private async openSocket(config: SmtpConfig): Promise<Socket | TLSSocket> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      const socket = config.secure
        ? tlsConnect(
            {
              host: config.host,
              port: config.port,
              servername: isIP(config.host) ? undefined : config.host,
              ...(config.ca ? { ca: config.ca } : {}),
            },
            () => {
            socket.setTimeout(0);
            resolve(socket);
          })
        : netConnect({ host: config.host, port: config.port }, () => {
            socket.setTimeout(0);
            resolve(socket);
          });
      socket.setTimeout(config.timeoutMs, () => {
        socket.destroy();
        reject(new Error('smtp_timeout'));
      });
      socket.once('error', onError);
    });
  }

  private buildMessage(config: SmtpConfig, message: SmtpMessage): string {
    const encodedSubject = `=?UTF-8?B?${Buffer.from(message.subject, 'utf8').toString('base64')}?=`;
    const encodedFromName = `=?UTF-8?B?${Buffer.from(config.fromName, 'utf8').toString('base64')}?=`;
    const messageId = message.messageId ?? `<${randomUUID()}@${config.from.split('@')[1] ?? 'localhost'}>`;
    const body = Buffer.from(message.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64');
    const chunked = body.match(/.{1,76}/g)?.join('\r\n') ?? '';
    const digest = createHash('sha256').update(message.text).digest('hex').slice(0, 16);
    return [
      `From: ${encodedFromName} <${config.from}>`,
      `To: <${message.to}>`,
      `Subject: ${encodedSubject}`,
      `Message-ID: ${messageId}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      `X-TG-Body-Digest: ${digest}`,
      '',
      chunked,
    ].join('\r\n');
  }
}

/** نسخة «معطَّلة بصراحة» تُستخدم عند غياب إعداد SMTP: تفشل بسبب واضح بلا شبكة. */
export class DisabledMailer implements SmtpClient {
  readonly configured = false;
  async send(): Promise<SmtpSendResult> {
    return { ok: false, errorCode: 'not_configured' };
  }
}
