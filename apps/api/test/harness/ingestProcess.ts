/**
 * عملية API كاملة لاختبار إعادة التشغيل: تشغيل حقيقي عبر `createTelegramRuntime` + `createApp`
 * ضد قاعدة PostgreSQL الحقيقية، مع بوابة تيليجرام اصطناعية (الحدّ الوحيد المُحاكى).
 *
 * تُشغَّل كعملية مستقلة (child process) ويُقتلها الاختبار بـ SIGKILL — أي انقطاع فعلي بلا إغلاق رشيق
 * ولا حفظ أخير. تكتب حالة التشخيص في ملف JSON لقراءتها من العملية الأم.
 *
 * الاستخدام: node --import tsx test/harness/ingestProcess.ts <config.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { RestartGateway, type ServerMessage } from './restartGateway.js';

interface HarnessConfig {
  accountId: string;
  serverLog: ServerMessage[];
  statusFile: string;
}

async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as HarnessConfig;
  const gateway = new RestartGateway(config.serverLog);

  const { createTelegramRuntime } = await import('../../src/modules/telegram/runtime.js');
  const { createApp } = await import('../../src/app.js');

  const telegramRuntime = createTelegramRuntime({ gateway });
  const app = createApp({ telegramRuntime });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  const write = () => {
    const snapshot = {
      pid: process.pid,
      clients: gateway.created.map((client) => ({
        accountId: client.accountId,
        restoredPts: client.restoredPts ?? null,
        delivered: client.delivered,
        checkpoint: client.checkpointInfo(),
      })),
      liveState: gateway.created.map((client) => client.liveState()?.pts ?? null),
    };
    writeFileSync(config.statusFile, JSON.stringify(snapshot, null, 2));
  };

  write();
  const timer = setInterval(write, 100);

  // مسار الإقلاع الحقيقي: استعادة الحسابات المحفوظة (بما فيه نقطة الاستئناف من قاعدة البيانات).
  const restore = await telegramRuntime.restoreActiveAccounts();
  write();

  // تبقى العملية حيّة حتى يقتلها الاختبار بـ SIGKILL.
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(143);
  });
  process.on('unhandledRejection', (reason) => {
    // لا يُسقط العملية: نطابق سلوك خادم الإنتاج (يسجّل فقط).
    void reason;
  });
  void restore;
}

void main();
