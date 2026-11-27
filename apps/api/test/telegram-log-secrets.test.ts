/**
 * اختبار عدم تسريب الأسرار في السجلات: يشغّل الخادم بمستوى سجل debug وبملف سجل حقيقي،
 * ينفّذ ربطاً كاملاً (رمز خاطئ ثم صحيح) وفصلاً، ثم يتأكد أن الملف لا يحتوي
 * رقم الهاتف الكامل ولا رمز الدخول ولا كلمة مرور التحقق ولا الجلسة.
 */
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client, startTestServer, type TestServer } from './harness.js';
import { FakeGateway, fakeTelegramError } from './telegram-fakes.js';

const PHONE = '+967779998877';
const CODE = '12345';
const TWO_FACTOR = 'SecretTwoFactor!42';

let server: TestServer;
let gateway: FakeGateway;
let logFile: string;
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tg-logs-'));
  logFile = join(dir, 'api.log');
  gateway = new FakeGateway();
  gateway.outcomeSelf = { id: '555', username: 'log_user' };
  server = await startTestServer({ telegramGateway: gateway, logLevel: 'debug', logFile });
});

after(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

it('لا يسجّل رقم الهاتف ولا الرمز ولا كلمة المرور ولا الجلسة', async () => {
  gateway.loginBehaviours.push({
    submitCode: ({ code }) => {
      if (code !== CODE) throw fakeTelegramError('PHONE_CODE_INVALID');
      return { status: 'password_required', hint: null };
    },
    submitPassword: () => ({ self: { id: '555', username: 'log_user' } }),
  });

  const api = client(server.baseUrl);
  const register = await api.post('/api/v1/auth/register', {
    email: 'logs@example.test',
    displayName: 'مستخدم السجلات',
    password: 'CorrectHorse123',
  });
  assert.equal(register.status, 201);

  const started = await api.post('/api/v1/telegram/accounts', { phoneNumber: PHONE });
  assert.equal(started.status, 201);
  const accountId = (started.body as { account: { id: string } }).account.id;

  assert.equal((await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: '00000' })).status, 400);
  assert.equal((await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: CODE })).status, 200);
  assert.equal(
    (await api.post(`/api/v1/telegram/accounts/${accountId}/password`, { password: TWO_FACTOR })).status,
    200,
  );
  assert.equal((await api.del(`/api/v1/telegram/accounts/${accountId}`)).status, 204);

  const logs = await readFile(logFile, 'utf8');
  assert.ok(logs.length > 0, 'يجب أن يكون ملف السجل غير فارغ');
  const forbidden = [
    PHONE,
    PHONE.replace('+', ''),
    '967779998877',
    CODE,
    TWO_FACTOR,
    'fake-login-session',
    `fake-session-${accountId}`,
    'hash-0021',
  ];
  for (const needle of forbidden) {
    assert.equal(logs.includes(needle), false, `تسريب محتمل في السجل: ${needle}`);
  }
  // التأكد من أن السجل يعمل فعلاً (طلبات مسارات تيليجرام مسجَّلة) حتى لا يكون الفحص فارغاً.
  assert.match(logs, /"path":"\/accounts/);
});
