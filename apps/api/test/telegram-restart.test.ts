/**
 * اختبار **إعادة تشغيل حقيقية** (الخطوة الرابعة): عملية API كاملة تُقتل بـ SIGKILL أثناء وجود رسالة
 * لم تُحفظ هويتها، ثم تُشغَّل عملية جديدة من الصفر وتستأنف من نقطة الاستئناف المحفوظة في قاعدة البيانات.
 *
 * ما هو حقيقي هنا: العملية (child process منفصل)، قاعدة PostgreSQL، الترحيلات، تشفير الجلسة،
 * `createTelegramRuntime` و`createApp` و`restoreActiveAccounts`، مدير الاتصالات، محرّك الالتقاط، والحارس.
 * ما هو محاكى: شبكة تيليجرام فقط (بوابة تُعيد تسليم ما هو أحدث من نقطة الاستئناف، كما يفعل الخادم).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway, fakeSource } from './telegram-fakes.js';
import type { ServerMessage } from './harness/restartGateway.js';

const PASSWORD = 'CorrectHorse123';
const STARTER_PTS = 100;

let server: TestServer;
let gateway: FakeGateway;
let workDir: string;

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tg-restart-'));
  gateway = new FakeGateway();
  // الحساب يبدأ من نقطة استئناف سابقة (كأنه عمل سابقاً ووصل إلى pts=100).
  gateway.initialUpdateState = { pts: STARTER_PTS, qts: 0, date: 0, seq: 0 } as never;
  server = await startTestServer({ telegramGateway: gateway });
});

after(async () => {
  await server.close();
});

interface PersistedSession {
  session: string;
  updateState?: { pts?: number } | undefined;
}

/** يقرأ نقطة الاستئناف المشفّرة فعلياً من قاعدة البيانات (تحقّق مستقل عن الذاكرة). */
async function persistedCheckpoint(accountId: string, userId: string): Promise<PersistedSession | null> {
  const { loadTelegramSession } = await import('../src/modules/telegram/sessionStore.js');
  const loaded = await loadTelegramSession({ accountId, userId });
  if (!loaded) return null;
  return { session: loaded.session, updateState: loaded.updateState as { pts?: number } | undefined };
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 25_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`انتهت المدة بانتظار: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

interface ChildStatus {
  pid: number;
  clients: {
    accountId: string;
    restoredPts: number | null;
    delivered: { pts: number; messageId: number; ok: boolean; error?: string }[];
    checkpoint: { pending: number; pinned: boolean; failures: number };
  }[];
  liveState: (number | null)[];
}

function startApiProcess(configPath: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'test/harness/ingestProcess.ts', configPath], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readStatus(file: string): ChildStatus | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ChildStatus;
  } catch {
    return null;
  }
}

function killHard(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

describe('إعادة التشغيل الحقيقية لمحرّك الالتقاط', () => {
  it('رسالة فشل حفظها لا تتقدّم بها نقطة الاستئناف، وتُعاد بعد إعادة تشغيل العملية بلا فقدان أو تعليق', async () => {
    // 1) تهيئة: مستخدم + حساب مرتبط + مصدر مراقب (كل ذلك عبر الـAPI الحقيقي).
    const api: TestClient = client(server.baseUrl);
    const registered = await api.post('/api/v1/auth/register', {
      email: 'restart@example.test',
      displayName: 'مستخدم إعادة التشغيل',
      password: PASSWORD,
    });
    assert.equal(registered.status, 201);
    const userId = (registered.body as { user: { id: string } }).user.id;

    gateway.outcomeSelf = { id: '777', username: 'restart_reader' };
    gateway.loginBehaviours.push({ submitCode: () => ({ status: 'authorized', self: { id: '777' } }) });
    const started = await api.post('/api/v1/telegram/accounts', { phoneNumber: '+967770900011' });
    assert.equal(started.status, 201);
    const accountId = (started.body as { account: { id: string } }).account.id;
    const verified = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: '12345' });
    assert.equal(verified.status, 200);

    gateway.sourceConfig.resolved.set('910001', fakeSource({ peerId: '910001', title: 'مصدر إعادة التشغيل' }));
    const added = await api.post('/api/v1/telegram/sources', { accountId, peerId: '910001' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const sourceId = (added.body as { source: { id: string } }).source.id;

    // نقطة الاستئناف الأساسية محفوظة فعلاً في القاعدة.
    const base = await waitFor('حفظ الجلسة الأولى', async () => {
      const row = await persistedCheckpoint(accountId, userId);
      return row?.updateState?.pts === STARTER_PTS ? row : null;
    });
    assert.equal(base.updateState?.pts, STARTER_PTS);

    // 2) سجل «جانب الخادم»: أربع رسائل، الثالثة (903) سيفشل حفظ هويتها في القاعدة.
    const serverLog: ServerMessage[] = [
      { pts: 101, messageId: 901, peerId: '910001' },
      { pts: 102, messageId: 902, peerId: '910001' },
      { pts: 103, messageId: 903, peerId: '910001' },
      { pts: 104, messageId: 904, peerId: '910001' },
    ];

    await server.sql(`
      create or replace function tg_restart_block_identity() returns trigger language plpgsql as $fn$
      begin
        if new.telegram_message_id = 903 then
          raise exception 'simulated identity persist failure';
        end if;
        return new;
      end $fn$;
    `);
    await server.sql(
      'create trigger tg_restart_block_identity_trg before insert on message_identity for each row execute function tg_restart_block_identity()',
    );

    // 3) العملية الأولى: تشغيل حقيقي ثم قتل فعلي (SIGKILL) بعد أن تُحفظ النقطة المثبّتة.
    const status1 = join(workDir, 'child1.json');
    const config1 = join(workDir, 'child1-config.json');
    writeFileSync(config1, JSON.stringify({ accountId, serverLog, statusFile: status1 }));
    const child1 = startApiProcess(config1);
    let child1Exit: number | null = null;
    child1.on('exit', (code) => {
      child1Exit = code;
    });

    try {
      // العملية الأولى استأنفت من القاعدة (لا من الصفر) وسلّمت الرسائل الأربع.
      const status = await waitFor('تسليم الرسائل في العملية الأولى', async () => {
        const current = readStatus(status1);
        const list = current?.clients[0];
        return list && list.delivered.length === 4 ? current : null;
      }, 20_000);
      assert.equal(status.clients[0]?.restoredPts, STARTER_PTS, 'العملية الأولى تستأنف من نقطة الاستئناف المحفوظة');
      const delivered = status.clients[0]!.delivered;
      assert.equal(delivered.length, 4);
      assert.deepEqual(
        delivered.map((d) => d.ok),
        [true, true, false, true],
        'الرسالة 903 تفشل في القاعدة، والبقية تنجح',
      );

      // النقطة المحفوظة في القاعدة تبقى عند آخر رسالة ناجحة قبل الفشل (102) ولو تقدّمت اللقطة الحيّة إلى 104.
      const pinned = await waitFor('حفظ نقطة الاستئناف المثبّتة', async () => {
        const row = await persistedCheckpoint(accountId, userId);
        return row?.updateState?.pts === 102 ? row : null;
      });
      assert.equal(pinned.updateState?.pts, 102, 'النقطة المحفوظة لا تتجاوز الرسالة الفاشلة');
      assert.equal(readStatus(status1)?.liveState[0], 104, 'اللقطة الحيّة وصلت إلى 104 فعلاً');
    } finally {
      await killHard(child1);
    }
    // انقطاع فعلي: العملية قُتلت بـ SIGKILL ولا إغلاق رشيق ولا حفظ أخير.
    assert.equal(child1.signalCode, 'SIGKILL');
    assert.equal(child1Exit, null, 'لا رمز خروج رشيق: العملية أُوقفت قسراً');

    // 4) حالة القاعدة بعد «التعطّل»: لا صف للرسالة الفاشلة، ولا عدّاد يكذب.
    const afterCrash = await server.sql(
      `select coalesce(array_agg(telegram_message_id::int order by telegram_message_id), '{}') as ids
         from message_identity where source_id = $1`,
      [sourceId],
    );
    assert.deepEqual(afterCrash.rows[0]?.ids, [901, 902, 904], 'لا هوية للرسالة 903 بعد التعطّل');
    const statsAfterCrash = await server.sql(
      'select ingested_count::text as c, last_ingest_error_code from telegram_sources where id = $1',
      [sourceId],
    );
    assert.equal(statsAfterCrash.rows[0]?.c, '3');
    // رمز الخطأ يعبّر عن **آخر** محاولة حفظ: الرسالة 904 نجحت بعد 903 فمحته، والفشل غير المحسوم
    // يبقى ممثّلاً في نقطة الاستئناف المثبّتة (102) لا في هذا الرمز.
    assert.equal(statsAfterCrash.rows[0]?.last_ingest_error_code, null);

    // 5) زوال سبب الفشل ثم **إعادة تشغيل عملية جديدة** (ليست إعادة تسليم يدوية في نفس العملية).
    await server.sql('drop trigger if exists tg_restart_block_identity_trg on message_identity');
    await server.sql('drop function if exists tg_restart_block_identity()');

    const status2 = join(workDir, 'child2.json');
    const config2 = join(workDir, 'child2-config.json');
    writeFileSync(config2, JSON.stringify({ accountId, serverLog, statusFile: status2 }));
    const child2 = startApiProcess(config2);

    try {
      const resumed = await waitFor('استئناف العملية الثانية', async () => {
        const current = readStatus(status2);
        const first = current?.clients[0];
        return first && first.delivered.length === 2 ? current : null;
      }, 20_000);
      // العملية الثانية تستأنف من 102 ⇒ تُسلَّم 103 و104 فقط.
      assert.equal(resumed.clients[0]?.restoredPts, 102, 'إعادة التشغيل تستأنف من النقطة المثبّتة لا من الصفر');
      assert.deepEqual(
        resumed.clients[0]!.delivered.map((d) => d.messageId),
        [903, 904],
        'الرسالة الفاشلة والرسالة التي بعدها تُعاد بعد إعادة التشغيل',
      );
      assert.deepEqual(resumed.clients[0]!.delivered.map((d) => d.ok), [true, true]);

      // لا فقدان: كل الرسائل الأربع موجودة مرة واحدة.
      const identities = await server.sql(
        `select coalesce(array_agg(telegram_message_id::int order by telegram_message_id), '{}') as ids,
                count(*)::int as total
           from message_identity where source_id = $1`,
        [sourceId],
      );
      assert.deepEqual(identities.rows[0]?.ids, [901, 902, 903, 904], 'اكتملت الهويات بعد الاستئناف');

      // لا تعليق: النقطة المحفوظة تتقدّم إلى 104 بعد نجاح كل الرسائل.
      const advanced = await waitFor('تقدّم نقطة الاستئناف بعد الاستئناف الناجح', async () => {
        const row = await persistedCheckpoint(accountId, userId);
        return row?.updateState?.pts === 104 ? row : null;
      });
      assert.equal(advanced.updateState?.pts, 104, 'بعد زوال الفشل تتقدّم النقطة', );

      const finalStatus = readStatus(status2)!;
      assert.equal(finalStatus.clients[0]?.checkpoint.pinned, false, 'لا تثبيت دائم بعد الاستئناف');
      assert.equal(finalStatus.clients[0]?.checkpoint.pending, 0);

      // المؤشرات متسقة: أربع هويات، إعادة تسليم 904 تُحتسب مكررة، ورمز الخطأ القديم لا يبقى.
      const stats = await server.sql(
        `select ingested_count::text as ingested, duplicate_count::text as dup, excluded_count::text as exc,
                last_ingest_error_code
           from telegram_sources where id = $1`,
        [sourceId],
      );
      assert.equal(stats.rows[0]?.ingested, '4');
      assert.equal(stats.rows[0]?.dup, '1');
      assert.equal(stats.rows[0]?.exc, '0');
      assert.equal(stats.rows[0]?.last_ingest_error_code, null, 'رمز الخطأ يمثّل آخر محاولة حفظ وقد نجحت');
    } finally {
      await killHard(child2);
    }
  });
});
