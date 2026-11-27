/**
 * اختبارات تكامل محرّك الالتقاط (الخطوة الرابعة): قاعدة PostgreSQL حقيقية + بوابة تيليجرام محاكاة.
 * لا اتصال حقيقي ولا نص رسالة محفوظ. تغطي: الالتقاط، منع التكرار، الاستبعاد المتعمّد،
 * عدّاد التحديثات غير المرتبطة، الفصل بين المستخدمين، وسلامة نقطة الاستئناف عند التعطّل.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway, fakeSource, type FakeAccountClient } from './telegram-fakes.js';

const PASSWORD = 'CorrectHorse123';
let server: TestServer;
let gateway: FakeGateway;
let counter = 0;

before(async () => {
  gateway = new FakeGateway();
  server = await startTestServer({ telegramGateway: gateway });
});

after(async () => {
  await server.close();
});

async function newUser(): Promise<TestClient> {
  const api = client(server.baseUrl);
  counter += 1;
  const res = await api.post('/api/v1/auth/register', {
    email: `ing${counter}@example.test`,
    displayName: `مستخدم التقاط ${counter}`,
    password: PASSWORD,
  });
  assert.equal(res.status, 201);
  return api;
}

async function linkedAccount(api: TestClient, phone: string, telegramUserId = '777'): Promise<string> {
  gateway.outcomeSelf = { id: telegramUserId, username: `reader_${telegramUserId}` };
  gateway.loginBehaviours.push({ submitCode: () => ({ status: 'authorized', self: { id: telegramUserId } }) });
  const started = await api.post('/api/v1/telegram/accounts', { phoneNumber: phone });
  assert.equal(started.status, 201);
  const accountId = (started.body as { account: { id: string } }).account.id;
  const verified = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: '12345' });
  assert.equal(verified.status, 200);
  return accountId;
}

/** يعيد عميل المحاكاة المتصل فعلياً لهذا الحساب. */
function liveClient(accountId: string): FakeAccountClient {
  const found = gateway.created.filter((c) => c.accountId === accountId && c.subscribers.size > 0);
  assert.ok(found.length > 0, 'يجب أن يكون هناك عميل متصل يستقبل الرسائل');
  return found[found.length - 1]!;
}

async function addSource(api: TestClient, accountId: string, peerId: string, title = 'مصدر التقاط'): Promise<string> {
  gateway.sourceConfig.resolved.set(peerId, fakeSource({ peerId, title, username: `src_${peerId}` }));
  const res = await api.post('/api/v1/telegram/sources', { accountId, peerId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return (res.body as { source: { id: string } }).source.id;
}

function statsRow(sourceId: string) {
  return server.sql<{
    ingested_count: string;
    duplicate_count: string;
    excluded_count: string;
    last_message_at: string | null;
    last_ingest_error_code: string | null;
  }>(
    `select ingested_count::text as ingested_count, duplicate_count::text as duplicate_count,
            excluded_count::text as excluded_count, last_message_at::text as last_message_at,
            last_ingest_error_code
       from telegram_sources where id = $1`,
    [sourceId],
  );
}

describe('محرّك الالتقاط', () => {
  it('يلتقط رسالة جديدة مرة واحدة ويحدّث المؤشرات بلا تخزين نص', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770100011');
    const sourceId = await addSource(api, accountId, '900001');
    const client0 = liveClient(accountId);

    await client0.emit({
      accountId,
      peerKey: 'channel:900001',
      peerKind: 'channel',
      messageId: 501,
      text: 'نص سري لا يجب أن يُحفظ',
      sentAt: new Date('2026-11-24T10:00:00Z'),
    });

    const rows = await server.sql('select * from message_identity where source_id = $1', [sourceId]);
    assert.equal(rows.rows.length, 1);
    const row = rows.rows[0]!;
    assert.equal(String(row.telegram_message_id), '501');
    assert.equal(String(row.peer_id), '900001');
    assert.equal(row.user_id !== undefined && row.user_id !== null, true);
    // لا نص ولا عمود محتوى في القاعدة.
    const columns = await server.sql(
      "select column_name from information_schema.columns where table_name = 'message_identity'",
    );
    const names = columns.rows.map((r) => String(r.column_name));
    for (const forbidden of ['text', 'content', 'body', 'caption', 'media']) {
      assert.equal(names.includes(forbidden), false, `لا يجب أن يوجد عمود ${forbidden}`);
    }

    const stats = await statsRow(sourceId);
    assert.equal(stats.rows[0]?.ingested_count, '1');
    assert.equal(stats.rows[0]?.duplicate_count, '0');
    assert.ok(stats.rows[0]?.last_message_at);

    const status = await api.get('/api/v1/telegram/ingest/status');
    assert.equal(status.status, 200);
    const body = status.body as { sources: { sourceId: string; ingestedCount: string }[]; unmatchedUpdates: number };
    assert.equal(body.sources.find((s) => s.sourceId === sourceId)?.ingestedCount, '1');
    assert.equal(body.unmatchedUpdates, 0);
  });

  it('يمنع التكرار المتسلسل والمتزامن بعدّاد مستقل وبلا فشل معاملة', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770100022');
    const sourceId = await addSource(api, accountId, '900002');
    const client0 = liveClient(accountId);
    const message = {
      accountId,
      peerKey: 'channel:900002',
      peerKind: 'channel' as const,
      messageId: 777,
      text: 'مكررة',
    };

    await client0.emit(message);
    await client0.emit(message); // تسليم مكرر متسلسل
    await Promise.all([client0.emit(message), client0.emit(message)]); // سباق متزامن

    const rows = await server.sql('select count(*)::int as c from message_identity where source_id = $1', [sourceId]);
    assert.equal(rows.rows[0]?.c, 1, 'صف هوية واحد فقط');
    const stats = await statsRow(sourceId);
    assert.equal(stats.rows[0]?.ingested_count, '1');
    assert.equal(stats.rows[0]?.duplicate_count, '3');
  });

  it('يستبعد رسائل المصادر الموقوفة ورسائل المستخدم نفسه ويحسمها لتتقدّم النقطة', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770100033');
    const sourceId = await addSource(api, accountId, '900003');
    const client0 = liveClient(accountId);

    // رسالة صادرة والمصدر لا يضمّن رسائل المستخدم (الافتراضي).
    await client0.emit({ accountId, peerKey: 'channel:900003', peerKind: 'channel', messageId: 601, outgoing: true, text: 'رسالتي' });
    let stats = await statsRow(sourceId);
    assert.equal(stats.rows[0]?.excluded_count, '1');
    assert.equal(stats.rows[0]?.ingested_count, '0');

    // تفعيل تضمين رسائل المستخدم ⇒ تُلتقط.
    assert.equal(
      (await api.patch(`/api/v1/telegram/sources/${sourceId}`, { includeOwnMessages: true })).status,
      200,
    );
    await client0.emit({ accountId, peerKey: 'channel:900003', peerKind: 'channel', messageId: 602, outgoing: true, text: 'رسالتي 2' });
    stats = await statsRow(sourceId);
    assert.equal(stats.rows[0]?.ingested_count, '1');

    // إيقاف المصدر ⇒ الرسائل اللاحقة مستبعدة لا مُلتقطة.
    assert.equal((await api.post(`/api/v1/telegram/sources/${sourceId}/pause`)).status, 200);
    await client0.emit({ accountId, peerKey: 'channel:900003', peerKind: 'channel', messageId: 603, text: 'بعد الإيقاف' });
    stats = await statsRow(sourceId);
    assert.equal(stats.rows[0]?.ingested_count, '1', 'لا التقاط لمصدر موقوف');
    assert.equal(stats.rows[0]?.excluded_count, '2');
    assert.equal(client0.checkpointInfo().pending, 0, 'كل رسالة حُسمت فلم تبقَ معلّقة');
  });

  it('يُميّز التحديثات غير المرتبطة بمصادر مراقبة في عدّاد عام واحد فقط', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770100044');
    const sourceId = await addSource(api, accountId, '900004');
    const client0 = liveClient(accountId);

    await client0.emit({ accountId, peerKey: 'channel:999999', peerKind: 'channel', messageId: 701, text: 'من قناة غير مراقبة' });
    await client0.emit({ accountId, peerKey: 'chat:888888', peerKind: 'group', messageId: 702, text: 'من مجموعة غير مراقبة' });
    await client0.emit({ accountId, peerKey: 'user:12345', peerKind: 'user', messageId: 703, text: 'خاص' });

    const status = await api.get('/api/v1/telegram/ingest/status');
    const body = status.body as { unmatchedUpdates: number; sources: { sourceId: string; excludedCount: string }[] };
    assert.equal(body.unmatchedUpdates, 3, 'عدّاد عام واحد لكل تحديث غير مرتبط');
    const mine = body.sources.find((s) => s.sourceId === sourceId)!;
    assert.equal(mine.excludedCount, '0', 'لا تُحتسب على المصادر');

    const rows = await server.sql(
      'select count(*)::int as c from message_identity where source_id = $1',
      [sourceId],
    );
    assert.equal(rows.rows[0]?.c, 0, 'لا صف هوية لتحديثات غير مراقبة');
  });

  it('يعزل إحصاءات الالتقاط بين المستخدمين', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const accountId = await linkedAccount(owner, '+967770100055');
    const sourceId = await addSource(owner, accountId, '900005');
    await liveClient(accountId).emit({ accountId, peerKey: 'channel:900005', peerKind: 'channel', messageId: 801, text: 'x' });

    const strangerStatus = await stranger.get('/api/v1/telegram/ingest/status');
    assert.equal(strangerStatus.status, 200);
    assert.deepEqual((strangerStatus.body as { sources: unknown[] }).sources, []);
    assert.equal((await stranger.get(`/api/v1/telegram/sources/${sourceId}/ingest`)).status, 404);
    assert.equal((await owner.get(`/api/v1/telegram/sources/${sourceId}/ingest`)).status, 200);

    const anonymous = client(server.baseUrl);
    assert.equal((await anonymous.get('/api/v1/telegram/ingest/status')).status, 401);
    assert.equal((await anonymous.get(`/api/v1/telegram/sources/${sourceId}/ingest`)).status, 401);
    // لا يتسرّب أي معرّف مصدر أو حساب من مالك آخر إلى استجابة الغريب.
    const strangerBody = JSON.stringify(strangerStatus.body);
    assert.equal(strangerBody.includes(sourceId), false);
    assert.equal(strangerBody.includes(accountId), false);
  });

  it('فشل حفظ هوية الرسالة يمنع تقدّم نقطة الاستئناف المحفوظة فعلياً', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770100066');
    const sourceId = await addSource(api, accountId, '900006');
    const client0 = liveClient(accountId);

    await client0.emit({ accountId, peerKey: 'channel:900006', peerKind: 'channel', messageId: 901, text: 'قبل الفشل' });
    const stateBefore = client0.exportSession().updateState;
    const ptsBefore = (stateBefore as { pts?: number } | undefined)?.pts;
    assert.equal(ptsBefore, 1, 'النقطة المحفوظة بعد رسالة ناجحة واحدة');

    // حقن فشل فعلي في قاعدة البيانات: أي إدراج هوية جديد يفشل.
    await server.sql(`
      create or replace function tg_test_block_identity() returns trigger language plpgsql as $fn$
      begin
        if new.telegram_message_id = 902 then
          raise exception 'simulated identity persist failure';
        end if;
        return new;
      end $fn$;
    `);
    await server.sql(
      'create trigger tg_test_block_identity_trg before insert on message_identity for each row execute function tg_test_block_identity()',
    );
    try {
      await assert.rejects(
        () => client0.emit({ accountId, peerKey: 'channel:900006', peerKind: 'channel', messageId: 902, text: 'تفشل' }),
        /simulated identity persist failure/,
      );
      // 1) النقطة المحفوظة لم تتقدّم.
      const saved = client0.exportSession().updateState as { pts?: number } | undefined;
      assert.equal(saved?.pts, ptsBefore, 'نقطة الاستئناف المحفوظة يجب ألا تتقدّم على رسالة لم تُحفظ');
      assert.equal(client0.checkpointInfo().pinned, true);
      // 2) لا صف هوية ولا عدّاد التقاط.
      const rows = await server.sql('select count(*)::int as c from message_identity where source_id = $1', [sourceId]);
      assert.equal(rows.rows[0]?.c, 1, 'لا صف للرسالة الفاشلة');
      const stats = await statsRow(sourceId);
      assert.equal(stats.rows[0]?.ingested_count, '1');
      assert.equal(stats.rows[0]?.last_ingest_error_code, 'INGEST_PERSIST_FAILED');

      // 3) رسالة لاحقة تنجح لكن النقطة تبقى مثبّتة (لا تخطّي صامت).
      await client0.emit({ accountId, peerKey: 'channel:900006', peerKind: 'channel', messageId: 903, text: 'تنجح' });
      const afterSuccess = client0.exportSession().updateState as { pts?: number } | undefined;
      assert.equal(afterSuccess?.pts, ptsBefore, 'التثبيت يمنع التقدّم فوق الرسالة الفاشلة');
    } finally {
      await server.sql('drop trigger if exists tg_test_block_identity_trg on message_identity');
      await server.sql('drop function if exists tg_test_block_identity()');
    }

    // 4) بعد زوال سبب الفشل تُعاد الرسالة من تيليجرام (استئناف من النقطة المثبّتة) فتُلتقط.
    await client0.emit({ accountId, peerKey: 'channel:900006', peerKind: 'channel', messageId: 902, text: 'تفشل' });
    const resumed = await statsRow(sourceId);
    // 901 نجحت، 903 نجحت أثناء التثبيت، ثم 902 بعد زوال السبب ⇒ ثلاث هويات.
    assert.equal(resumed.rows[0]?.ingested_count, '3', 'الرسالة التي فشل حفظها تُلتقط بعد زوال السبب');
    const identities = await server.sql(
      'select count(*)::int as c from message_identity where source_id = $1',
      [sourceId],
    );
    assert.equal(identities.rows[0]?.c, 3);
  });

  it('رسائل متزامنة (بينها تكرارات) لا تُنتج صفوفاً أو عدّادات مزدوجة ولا أخطاء', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770100033');
    const sourceId = await addSource(api, accountId, '900033');
    const client0 = liveClient(accountId);

    const ids = [1701, 1702, 1703, 1701, 1702, 1703];
    await Promise.all(
      ids.map((messageId) =>
        client0.emit({ accountId, peerKey: 'channel:900033', peerKind: 'channel', messageId }),
      ),
    );

    const rows = await server.sql(
      `select count(*)::int as total, count(distinct telegram_message_id)::int as distinct_ids
         from message_identity where source_id = $1`,
      [sourceId],
    );
    assert.equal(rows.rows[0]?.total, 3);
    assert.equal(rows.rows[0]?.distinct_ids, 3);
    const stats = await statsRow(sourceId);
    assert.equal(stats.rows[0]?.ingested_count, '3');
    assert.equal(stats.rows[0]?.duplicate_count, '3');
    assert.equal(
      Number(stats.rows[0]?.ingested_count) + Number(stats.rows[0]?.duplicate_count),
      ids.length,
      'كل تسليم يُحسب مرة واحدة: إما التقاط أو تكرار',
    );
  });

  it('ذرّية: فشل تحديث العدّاد يُبطل إدراج الهوية في المعاملة نفسها', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770100044');
    const sourceId = await addSource(api, accountId, '900044');

    // فشل يُحقن في **تحديث العدّاد** (بعد نجاح الإدراج) لكشف أي هوية بلا عدّاد.
    await server.sql(`
      create or replace function tg_test_block_counter() returns trigger language plpgsql as $fn$
      begin
        if new.id = '${sourceId}'::uuid and new.ingested_count <> old.ingested_count then
          raise exception 'simulated counter update failure';
        end if;
        return new;
      end $fn$;
    `);
    await server.sql(
      'create trigger tg_test_block_counter_trg before update on telegram_sources for each row execute function tg_test_block_counter()',
    );
    try {
      await assert.rejects(
        () => liveClient(accountId).emit({ accountId, peerKey: 'channel:900044', peerKind: 'channel', messageId: 1601 }),
        /simulated counter update failure/,
      );
    } finally {
      await server.sql('drop trigger if exists tg_test_block_counter_trg on telegram_sources');
      await server.sql('drop function if exists tg_test_block_counter()');
    }

    const identities = await server.sql('select count(*)::int as c from message_identity where source_id = $1', [
      sourceId,
    ]);
    assert.equal(identities.rows[0]?.c, 0, 'لا هوية بلا عدّاد: الإدراج تراجع مع المعاملة');
    const stats = await statsRow(sourceId);
    assert.equal(stats.rows[0]?.ingested_count, '0', 'لا عدّاد بلا هوية');
    assert.equal(stats.rows[0]?.last_message_at, null);
    assert.equal(stats.rows[0]?.last_ingest_error_code, 'INGEST_PERSIST_FAILED');

    // وبعد زوال السبب تُقبل الرسالة مرة واحدة فقط.
    await liveClient(accountId).emit({ accountId, peerKey: 'channel:900044', peerKind: 'channel', messageId: 1601 });
    const after = await statsRow(sourceId);
    assert.equal(after.rows[0]?.ingested_count, '1');
    const idRows = await server.sql('select count(*)::int as c from message_identity where source_id = $1', [sourceId]);
    assert.equal(idRows.rows[0]?.c, 1);
  });

  it('رمز آخر خطأ حفظ يُمحى عند أول نجاح لاحق (مؤشر متسق مع آخر محاولة)', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770100066');
    const sourceId = await addSource(api, accountId, '900006');

    await server.sql(`update telegram_sources set last_ingest_error_code = 'INGEST_PERSIST_FAILED' where id = $1`, [
      sourceId,
    ]);
    await liveClient(accountId).emit({ accountId, peerKey: 'channel:900006', peerKind: 'channel', messageId: 1501 });

    const stats = await statsRow(sourceId);
    assert.equal(stats.rows[0]?.last_ingest_error_code, null, 'النجاح يمحو رمز الخطأ السابق');
    assert.equal(stats.rows[0]?.ingested_count, '1');
  });

  it('يحذف هويات الرسائل بعد انتهاء مدة الاحتفاظ ولا يمسّ العدّادات', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770100077');
    const sourceId = await addSource(api, accountId, '900007');
    await liveClient(accountId).emit({ accountId, peerKey: 'channel:900007', peerKind: 'channel', messageId: 1001, text: 'قديمة' });

    await server.sql("update message_identity set first_seen_at = now() - interval '31 days' where source_id = $1", [sourceId]);
    const { PgIngestStore } = await import('../src/modules/telegram/ingestRepository.js');
    const removed = await new PgIngestStore().purgeIdentitiesOlderThan(30);
    assert.ok(removed >= 1);

    const rows = await server.sql('select count(*)::int as c from message_identity where source_id = $1', [sourceId]);
    assert.equal(rows.rows[0]?.c, 0);
    const stats = await statsRow(sourceId);
    assert.equal(stats.rows[0]?.ingested_count, '1', 'العدّادات لا تُمسّ بالتنظيف');

    // الرسائل الحديثة لا تتأثر: تُضاف هوية جديدة بعد التنظيف وتبقى سليمة.
    await liveClient(accountId).emit({ accountId, peerKey: 'channel:900007', peerKind: 'channel', messageId: 1002, text: 'حديثة' });
    const afterPurge = await server.sql(
      'select count(*)::int as c, min(first_seen_at)::text as oldest from message_identity where source_id = $1',
      [sourceId],
    );
    assert.equal(afterPurge.rows[0]?.c, 1, 'الهوية الجديدة تبقى بعد التنظيف');

    // القيد الفريد ما زال يعمل بعد التنظيف: إعادة تسليم نفس الرسالة تُحتسب مكررة.
    await liveClient(accountId).emit({ accountId, peerKey: 'channel:900007', peerKind: 'channel', messageId: 1002, text: 'حديثة' });
    const afterDuplicate = await statsRow(sourceId);
    assert.equal(afterDuplicate.rows[0]?.duplicate_count, '1');
    assert.equal(afterDuplicate.rows[0]?.ingested_count, '2');

    // حدّ معروف وموثّق: بعد حذف الهوية القديمة، إعادة تسليمها تُقبل كرسالة جديدة (منع التكرار ينتهي بالاحتفاظ).
    await liveClient(accountId).emit({ accountId, peerKey: 'channel:900007', peerKind: 'channel', messageId: 1001, text: 'قديمة' });
    const replayedAfterPurge = await statsRow(sourceId);
    assert.equal(replayedAfterPurge.rows[0]?.ingested_count, '3', 'الحدّ الموثّق: الهوية المحذوفة لا تمنع تكراراً لاحقاً');
  });

  it('يصدر حالة الالتقاط وحالة الربط لكل مصدر بلا أي محتوى', async () => {
    const api = await newUser();
    const accountId = await linkedAccount(api, '+967770100088');
    const sourceId = await addSource(api, accountId, '900008');
    await liveClient(accountId).emit({ accountId, peerKey: 'channel:900008', peerKind: 'channel', messageId: 1101, text: 'حالة' });

    const res = await api.get(`/api/v1/telegram/sources/${sourceId}/ingest`);
    assert.equal(res.status, 200);
    const body = res.body as {
      source: {
        sourceId: string;
        ingestedCount: string;
        connectionPhase: string;
        identityRetentionDays?: number;
        lastMessageAt: string | null;
      };
    };
    assert.equal(body.source.sourceId, sourceId);
    assert.equal(body.source.ingestedCount, '1');
    assert.equal(body.source.connectionPhase, 'connected');
    assert.equal(JSON.stringify(res.body).includes('حالة'), false, 'لا نص رسالة في الاستجابة');

    const status = await api.get('/api/v1/telegram/ingest/status');
    const payload = status.body as { identityRetentionDays: number; enabled: boolean; since: string };
    assert.equal(payload.identityRetentionDays, 30);
    assert.equal(payload.enabled, true);
    assert.ok(payload.since);
  });
});
