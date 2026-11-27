/**
 * خادم SMTP مزيّف لاختبار عميل البريد (P0) — مقبس حقيقي وبروتوكول حقيقي.
 *
 * وضعان:
 *  - `tls`: TLS من البداية (مثل منفذ 465) بشهادة مُولَّدة للاختبار — يختبر مسار التشفير
 *    والمصادقة والرسالة كما في الإنتاج.
 *  - `plain`: قناة صريحة؛ يمكن أن تُعلن STARTTLS ثم ترفضها (454) لاختبار حدود العميل،
 *    أو ألا تُعلنها أصلاً لاختبار رفض المصادقة على قناة غير مشفّرة.
 */
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * شهادة اختبار ذاتية التوقيع (opنسل)، تُستخدم لخادم SMTP المحلي.
 * لا تُستخدم في الإنتاج: الإنتاج يستخدم شهادة عامة أو CA داخلي عبر `SMTP_CA`/`ca`.
 */
export function generateTestCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'smtp-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

export interface ReceivedMail {
  from: string;
  to: string[];
  raw: string;
  body: string;
}

export interface FakeSmtpOptions {
  mode?: 'tls' | 'plain';
  rejectAuth?: boolean;
  rejectRcpt?: boolean;
  /** في الوضع الصريح: يُعلن STARTTLS ثم يرفضها (لا ترقية فعلية). */
  advertiseStartTls?: boolean;
}

export interface FakeSmtp {
  server: Server;
  port: number;
  mails: ReceivedMail[];
  /** الأوامر التي وصلت (بلا محتواها) — لفحص أن العميل طلب STARTTLS فعلاً. */
  commands: string[];
  close(): Promise<void>;
}

/** يفكّ جسم الرسالة base64 كما يفعل عميل بريد حقيقي. */
function decodeBody(raw: string): string {
  const parts = raw.split('\r\n\r\n');
  const encoded = parts.slice(1).join('\r\n\r\n').replace(/\r\n/g, '');
  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

export function startFakeSmtp(
  credentials: { key: string; cert: string },
  options: FakeSmtpOptions = {},
): Promise<FakeSmtp> {
  const mails: ReceivedMail[] = [];
  const commands: string[] = [];

  const attach = (socket: Socket): void => {
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    let buffer = '';
    let inData = false;
    let data = '';
    let from = '';
    let to: string[] = [];

    socket.write('220 fake.test ESMTP ready\r\n');

    const handle = (line: string): void => {
      if (inData) return;
      const verb = line.split(' ')[0]!.toUpperCase();
      commands.push(/^AUTH/i.test(line) ? 'AUTH' : verb);

      if (/^EHLO/i.test(line)) {
        const lines = ['250-fake.test greets you'];
        if (options.mode === 'plain' && options.advertiseStartTls) lines.push('250-STARTTLS');
        lines.push('250 AUTH PLAIN LOGIN');
        socket.write(`${lines.join('\r\n')}\r\n`);
        return;
      }
      if (/^STARTTLS/i.test(line)) {
        // الترقية الحقيقية مُختبَرة في وضع `tls`؛ هنا نرفض بأمانة.
        socket.write('454 4.7.0 TLS not available here\r\n');
        return;
      }
      if (/^AUTH/i.test(line)) {
        socket.write(options.rejectAuth ? '535 5.7.8 Authentication failed\r\n' : '235 2.7.0 Accepted\r\n');
        return;
      }
      if (/^MAIL FROM:/i.test(line)) {
        from = /<([^>]*)>/.exec(line)?.[1] ?? '';
        socket.write('250 2.1.0 Ok\r\n');
        return;
      }
      if (/^RCPT TO:/i.test(line)) {
        if (options.rejectRcpt) {
          socket.write('550 5.1.1 No such user\r\n');
          return;
        }
        to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
        socket.write('250 2.1.5 Ok\r\n');
        return;
      }
      if (/^DATA/i.test(line)) {
        inData = true;
        data = '';
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        return;
      }
      if (/^QUIT/i.test(line)) {
        socket.write('221 2.0.0 Bye\r\n');
        socket.end();
        return;
      }
      socket.write('250 2.0.0 Ok\r\n');
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const terminator = buffer.indexOf('\r\n.\r\n');
          if (terminator === -1) return;
          data += buffer.slice(0, terminator);
          buffer = buffer.slice(terminator + 5);
          inData = false;
          mails.push({ from, to, raw: data, body: decodeBody(data) });
          data = '';
          from = '';
          to = [];
          socket.write('250 2.0.0 Ok: queued\r\n');
          continue;
        }
        const index = buffer.indexOf('\r\n');
        if (index === -1) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
      }
    });
  };

  const server =
    options.mode === 'tls'
      ? createTlsServer({ key: credentials.key, cert: credentials.cert }, attach)
      : createNetServer(attach);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        port,
        mails,
        commands,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
