/**
 * أداة تحقق تشغيلية لتكامل تيليجرام (ليست اختباراً آلياً).
 * - بلا أسرار مطبوعة: لا تُطبع الجلسة ولا api_hash ولا رمز الدخول.
 * - بلا اتصال إن لم تتوفر بيانات الاعتماد: تشرح ما هو مطلوب وتخرج بنجاح.
 *
 * الاستخدام:
 *   npm run telegram:smoke                     # فحص التهيئة فقط
 *   npm run telegram:smoke -- --listen 30      # اتصال + استماع 30 ثانية (يحتاج جلسة)
 *   npm run telegram:smoke -- --login          # تسجيل دخول تفاعلي ثم الاستماع
 *   npm run telegram:smoke -- --account-id <uuid> --user-email <email>   # حفظ الجلسة مشفّرة
 */
import { createInterface } from 'node:readline/promises';
import { readTelegramConfig, TELEPROTO_VERSION } from '../modules/telegram/config.js';
import { TeleprotoGateway } from '../modules/telegram/teleprotoGateway.js';
import { classifyTelegramError } from '../modules/telegram/errors.js';
import { classifyTelegramError as describeOnly } from '../modules/telegram/errors.js';
import { encryptSession, decryptSession } from '../modules/telegram/sessionCipher.js';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { query, closePool } from '../db/pool.js';
import { saveTelegramSession } from '../modules/telegram/sessionStore.js';
import { logger } from '../lib/logger.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const wantsLogin = process.argv.includes('--login');
const listenSeconds = Number(arg('listen') ?? 0);
const accountId = arg('account-id');
const userEmail = arg('user-email');

async function resolveOwner(accountIdValue: string, email: string): Promise<string> {
  const res = await query<{ id: string; user_id: string }>(
    `select a.id, a.user_id from telegram_accounts a join users u on u.id = a.user_id
      where a.id = $1 and u.email_normalized = lower($2)`,
    [accountIdValue, email.trim()],
  );
  const row = res.rows[0];
  if (!row) throw new Error('لم يُعثر على حساب تيليجرام بهذا المعرّف لهذا المستخدم.');
  return row.user_id;
}

async function main(): Promise<void> {
  console.log('— فحص تكامل تيليجرام (teleproto) —');
  console.log(`المكتبة: teleproto ${TELEPROTO_VERSION} (طبقة مخطط 234)`);
  const config = readTelegramConfig();
  console.log(`بيانات التطبيق: ${config.ready ? 'مهيأة' : 'غير مهيأة — ' + (config.reason ?? '')}`);
  console.log(`مفتاح تشفير الجلسات: ${config.encryptionKeyConfigured ? 'مهيأ' : 'غير مهيأ (TG_SESSION_ENC_KEY)'}`);
  console.log(`بيئة الاختبار (test DC): ${config.testServers ? 'نعم' : 'لا'}`);

  if (!config.ready || !config.credentials) {
    console.log('\nما هو مطلوب قبل أي اختبار اتصال حقيقي:');
    console.log('  1) TG_API_ID وTG_API_HASH من https://my.telegram.org (تطبيق باسم هذا النظام).');
    console.log('  2) TG_SESSION_ENC_KEY = 32 بايت base64، مثال للتوليد:');
    console.log('     node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    console.log('  3) جلسة مصرّح بها: إما TG_SMOKE_SESSION أو --login التفاعلي، وإلا فلا اتصال.');
    console.log('\nانتهى الفحص دون أي اتصال شبكي (كما هو متوقع بدون بيانات اعتماد).');
    return;
  }

  const sessionString = process.env.TG_SMOKE_SESSION ?? '';
  let client: TelegramClient | null = null;
  let session: StringSession | null = null;

  if (wantsLogin) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    session = new StringSession('');
    client = new TelegramClient(session, config.credentials.apiId, config.credentials.apiHash, {
      connectionRetries: config.connectionRetries,
      floodSleepThreshold: config.floodSleepThreshold,
      testServers: config.testServers,
    });
    console.log('\nبدء تسجيل دخول تفاعلي. لن يُطبع رمز الدخول أو الجلسة.');
    await client.start({
      phoneNumber: () => rl.question('رقم الهاتف (بصيغة دولية): '),
      phoneCode: () => rl.question('رمز الدخول من تيليجرام: '),
      password: () => rl.question('كلمة مرور التحقق بخطوتين (إن وُجدت): '),
      onError: (err) => console.error('خطأ في تسجيل الدخول:', classifyTelegramError(err).code),
    });
    rl.close();
  } else if (sessionString) {
    session = new StringSession(sessionString);
    client = new TelegramClient(session, config.credentials.apiId, config.credentials.apiHash, {
      connectionRetries: config.connectionRetries,
      floodSleepThreshold: config.floodSleepThreshold,
      testServers: config.testServers,
    });
  } else {
    console.log('\nلا توجد جلسة (TG_SMOKE_SESSION أو --login). لن يُجرى اتصال.');
    console.log('يمكنك تشغيل: npm run telegram:smoke -- --login --listen 30');
    return;
  }

  try {
    await client.connect();
    const authorized = await client.checkAuthorization();
    console.log(`\nالاتصال: نجح | المصادقة: ${authorized ? 'صالحة' : 'غير صالحة (تحتاج تسجيل دخول)'}`);
    if (authorized) {
      const me = await client.getMe();
      console.log(`الحساب: ${(me as { firstName?: string }).firstName ?? '—'} (id: ${String((me as { id: unknown }).id)})`);

      const saved = session!.save();
      const envelope = encryptSession('00000000-0000-4000-8000-000000000000', { session: saved, updateState: session!.getUpdateState() });
      const roundTrip = decryptSession('00000000-0000-4000-8000-000000000000', envelope.ciphertext);
      console.log(`اختبار التشفير: ${roundTrip.session === saved ? 'نجح' : 'فصل'} (مغلّف ${envelope.ciphertext.length} بايت)`);

      if (accountId && userEmail) {
        const userId = await resolveOwner(accountId, userEmail);
        await saveTelegramSession({
          accountId,
          userId,
          payload: { session: saved, updateState: session!.getUpdateState() },
        });
        console.log('حُفظت الجلسة مشفّرة في قاعدة البيانات لهذا الحساب.');
      } else {
        console.log('لم تُحفظ الجلسة: مرّر --account-id و--user-email لحفظها مشفّرة.');
      }

      if (listenSeconds > 0) {
        let count = 0;
        const chats = new Set<string>();
        client.updates.on(['newMessage', 'newChannelMessage'], (update) => {
          const message = (update as { message?: { message?: string } }).message;
          if (typeof message?.message === 'string' && message.message.trim()) {
            count += 1;
            const peer = (message as { peerId?: { channelId?: unknown } }).peerId?.channelId;
            if (peer) chats.add(String(peer));
          }
        });
        console.log(`\nاستماع ${listenSeconds} ثانية…`);
        await new Promise((resolve) => setTimeout(resolve, listenSeconds * 1000));
        console.log(`رسائل نصية مستلمة: ${count} من ${chats.size} محادثة.`);
      }
    }
  } catch (err) {
    const classified = classifyTelegramError(err);
    console.log(`\nفشل الاتصال: ${classified.kind} (${classified.code})`);
    if (classified.kind === 'flood_wait') console.log(`انتظار مطلوب: ${classified.waitSeconds ?? 'غير محدد'} ثانية.`);
    if (classified.needsUserAction) console.log('الجلسة غير صالحة: يلزم تسجيل دخول جديد.');
    void describeOnly;
    logger.debug({ code: classified.code }, 'تفاصيل تشخيصية للفشل');
  } finally {
    await client?.disconnect().catch(() => {});
  }
}

await main().catch((err: unknown) => {
  console.error('تعذّر إكمال الأداة:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
await closePool();
