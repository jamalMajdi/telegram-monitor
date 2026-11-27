/**
 * اختبارات تكامل لمخزن جلسات MTProto على قاعدة PostgreSQL حقيقية (مؤقتة).
 * تتحقق من: التشفير عند الراحة، عدم ظهور الجلسة كنص صريح، عزل الملكية،
 * ربط المغلّف بالحساب (AAD)، والحذف.
 */
import './telegram-test-env.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';

// تُحمَّل وحدات المخزن بعد تهيئة البيئة وقاعدة البيانات (تقرأ config/env عند الاستيراد).
type SessionStoreModule = typeof import('../src/modules/telegram/sessionStore.js');
let store: SessionStoreModule;
const saveTelegramSession = (...args: Parameters<SessionStoreModule['saveTelegramSession']>) =>
  store.saveTelegramSession(...args);
const loadTelegramSession = (...args: Parameters<SessionStoreModule['loadTelegramSession']>) =>
  store.loadTelegramSession(...args);
const deleteTelegramSession = (...args: Parameters<SessionStoreModule['deleteTelegramSession']>) =>
  store.deleteTelegramSession(...args);

let server: TestServer;
let userA = '';
let userB = '';
let accountA1 = '';
let accountA2 = '';
let accountB1 = '';

const SESSION_TEXT = '1BQANOTEuMTA4Ljg3LjE3OQBrZXktZm9yLWludGVncmF0aW9uLXRlc3Q=';
const UPDATE_STATE = { pts: 512, qts: 0, date: 1700000001, seq: 9, channels: { '42': 7 } };

async function createUser(email: string): Promise<string> {
  const res = await server.sql(
    `insert into users (email, display_name, password_hash)
     values ($1, 'مستخدم اختبار', 'scrypt$32768$8$1$c2FsdHNhbHRzYWx0c2E=$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
     returning id`,
    [email],
  );
  return String(res.rows[0]!.id);
}

async function createAccount(userId: string, label: string): Promise<string> {
  const res = await server.sql(
    `insert into telegram_accounts (user_id, label, status, telegram_user_id, is_active_reader)
     values ($1, $2, 'active', floor(random() * 100000000)::bigint, true)
     returning id`,
    [userId, label],
  );
  return String(res.rows[0]!.id);
}

before(async () => {
  server = await startTestServer();
  store = await import('../src/modules/telegram/sessionStore.js');
  userA = await createUser('store-a@example.test');
  userB = await createUser('store-b@example.test');
  accountA1 = await createAccount(userA, 'حساب أول');
  accountA2 = await createAccount(userA, 'حساب ثانٍ');
  accountB1 = await createAccount(userB, 'حساب مستخدم آخر');
});

after(async () => {
  await server.close();
});

describe('مخزن جلسات تيليجرام', () => {
  it('يحفظ الجلسة ويستعيدها كاملة لمالكها', async () => {
    await saveTelegramSession({
      accountId: accountA1,
      userId: userA,
      payload: { session: SESSION_TEXT, updateState: UPDATE_STATE },
    });
    const loaded = await loadTelegramSession({ accountId: accountA1, userId: userA });
    assert.ok(loaded);
    assert.equal(loaded.session, SESSION_TEXT);
    assert.deepEqual(loaded.updateState, UPDATE_STATE);
    assert.equal(loaded.keyVersion, 1);
  });

  it('يخزّن نصاً مشفّراً فقط في قاعدة البيانات', async () => {
    const raw = await server.sql(
      'select ciphertext, key_version, octet_length(ciphertext) as size from telegram_sessions where account_id = $1',
      [accountA1],
    );
    const row = raw.rows[0]!;
    const cipher: Buffer = row.ciphertext as Buffer;
    assert.ok(cipher.length > 28);
    assert.equal(cipher.includes(Buffer.from(SESSION_TEXT)), false);
    assert.equal(cipher.includes(Buffer.from('key-for-integration')), false);
    assert.equal(cipher.includes(Buffer.from('pts')), false, 'حالة التحديثات مشفّرة أيضاً');
    assert.equal(Number(row.key_version), 1);
  });

  it('لا يعرض أي سجل تشغيلي الجلسة أو محتواها', async () => {
    await saveTelegramSession({
      accountId: accountA1,
      userId: userA,
      payload: { session: `${SESSION_TEXT}-rotated`, updateState: UPDATE_STATE },
    });
    const audit = await server.sql('select action, metadata::text as metadata from audit_events');
    const dump = JSON.stringify(audit.rows);
    assert.equal(dump.includes(SESSION_TEXT), false);
    assert.equal(dump.includes('key-for-integration'), false);
  });

  it('يمنع مستخدماً آخر من قراءة جلسة لا يملكها', async () => {
    await assert.rejects(
      () => loadTelegramSession({ accountId: accountA1, userId: userB }),
      (err: unknown) => err instanceof store.TelegramSessionAccessError,
    );
    await assert.rejects(
      () => saveTelegramSession({ accountId: accountA1, userId: userB, payload: { session: 'x' } }),
      (err: unknown) => err instanceof store.TelegramSessionAccessError,
    );
    await assert.rejects(
      () => deleteTelegramSession(accountA1, userB),
      (err: unknown) => err instanceof store.TelegramSessionAccessError,
    );
  });

  it('يفشل فك المغلّف بعد نقله إلى حساب آخر (AAD مربوط بالحساب)', async () => {
    const source = await server.sql('select ciphertext from telegram_sessions where account_id = $1', [accountA1]);
    const ciphertext = source.rows[0]!.ciphertext as Buffer;
    await server.sql('insert into telegram_sessions (account_id, ciphertext, key_version) values ($1, $2, 1)', [
      accountA2,
      ciphertext,
    ]);
    await assert.rejects(
      () => loadTelegramSession({ accountId: accountA2, userId: userA }),
      /سلامة مغلّف الجلسة/,
    );
    await server.sql('delete from telegram_sessions where account_id = $1', [accountA2]);
  });

  it('يتصرف بأمان مع حساب بلا جلسة محفوظة', async () => {
    const loaded = await loadTelegramSession({ accountId: accountB1, userId: userB });
    assert.equal(loaded, null);
  });

  it('يحذف الجلسة عند طلب المالك', async () => {
    assert.equal(await deleteTelegramSession(accountA1, userA), true);
    assert.equal(await loadTelegramSession({ accountId: accountA1, userId: userA }), null);
    assert.equal(await deleteTelegramSession(accountA1, userA), false);
  });

  it('يحذف الجلسة تلقائياً عند حذف الحساب (cascade)', async () => {
    await saveTelegramSession({ accountId: accountB1, userId: userB, payload: { session: SESSION_TEXT } });
    await server.sql('delete from telegram_accounts where id = $1', [accountB1]);
    const rows = await server.sql('select count(*)::int as c from telegram_sessions where account_id = $1', [accountB1]);
    assert.equal(Number(rows.rows[0]!.c), 0);
  });
});
