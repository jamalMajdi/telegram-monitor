/**
 * مصنع البوابة: النقطة الوحيدة التي تُنشئ كائن TeleprotoGateway في التشغيل.
 * يجعل تبديل المكتبة (TDLib مثلاً) تغييراً في هذا الملف وتنفيذ نفس عقد gateway.ts
 * دون لمس مدير الاتصالات أو بقية النظام.
 */
import { readTelegramConfig, TELEPROTO_PACKAGE, TELEPROTO_VERSION } from './config.js';
import { TeleprotoGateway } from './teleprotoGateway.js';
import type { TelegramGateway } from './gateway.js';

export interface GatewayFactoryResult {
  gateway: TelegramGateway;
  library: { name: string; version: string };
}

export class TelegramNotConfiguredError extends Error {
  readonly code = 'telegram_not_configured';
}

export function createTelegramGateway(): GatewayFactoryResult {
  const config = readTelegramConfig();
  if (!config.ready || !config.credentials) {
    throw new TelegramNotConfiguredError(config.reason ?? 'تكامل تيليجرام غير مهيأ.');
  }
  return {
    gateway: new TeleprotoGateway({
      apiId: config.credentials.apiId,
      apiHash: config.credentials.apiHash,
      testServers: config.testServers,
      catchUp: config.catchUp,
      connectionRetries: config.connectionRetries,
      floodSleepThreshold: config.floodSleepThreshold,
    }),
    library: { name: TELEPROTO_PACKAGE, version: TELEPROTO_VERSION },
  };
}
