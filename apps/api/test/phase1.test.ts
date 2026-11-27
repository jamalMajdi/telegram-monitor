/**
 * اختبارات المرحلة الأولى: الهوية والجلسات والصلاحيات وقاعدة البيانات.
 * تعمل على قاعدة PostgreSQL مؤقتة تُنشأ وتُحذف مع التشغيل.
 */
import { after, before, describe, it } from 'node:test';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';

let server: TestServer;
let migrate: typeof import('../src/db/migrate.js').migrate;

const PASSWORD = 'CorrectHorse123';

before(async () => {
  server = await startTestServer();
  ({ migrate } = await import('../src/db/migrate.js'));
});

after(async () => {
  await server.close();
});

/** عدد ملفات الترحيل الفعلية — لا رقم مضمَّن يتقادم مع كل ترحيل جديد. */
async function migrationCount(): Promise<number> {
  const dir = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
  const files = await readdir(dir);
  return files.filter((name) => name.endsWith('.sql')).length;
}

function c(): TestClient {
  return client(server.baseUrl);
}

async function register(client: TestClient, email: string, displayName = 'مستخدم اختبار', password = PASSWORD) {
  return client.post('/api/v1/auth/register', { email, displayName, password });
}

describe('الصحة والترحيلات', () => {
  it('يفيد فحص الصحة باتصال قاعدة بيانات سليم', async () => {
    const res = await c().get('/api/v1/health');
    assert.equal(res.status, 200);
    assert.deepEqual((res.body as { status: string }).status, 'ok');
  });

  it('يطبّق الترحيلات مرة واحدة ويكون إعادة التشغيل آمناً', async () => {
    const again = await migrate();
    assert.deepEqual(again.applied, []);
    assert.equal(again.skipped.length, await migrationCount());
  });

  it('يحفظ بصمة كل ترحيل في سجل الترحيلات', async () => {
    const rows = await server.sql('select filename, checksum from schema_migrations order by filename');
    assert.equal(rows.rows.length, await migrationCount());
    for (const row of rows.rows) assert.match(String(row.checksum), /^[0-9a-f]{64}$/);
  });
});

describe('سلامة المخطط والقيود', () => {
  it('ينشئ الجداول الأساسية بعلاقاتها', async () => {
    const res = await server.sql(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    const tables = res.rows.map((r) => String(r.table_name));
    for (const expected of [
      'users',
      'user_settings',
      'system_settings',
      'user_sessions',
      'password_reset_tokens',
      'notification_outbox',
      'audit_events',
      'login_attempts',
      'schema_migrations',
    ]) {
      assert.ok(tables.includes(expected), `الجدول ${expected} مفقود`);
    }
  });

  it('يفرض فرادة البريد غير الحساسة لحالة الأحرف', async () => {
    const a = c();
    assert.equal((await register(a, 'Dup@Example.test')).status, 201);
    const b = c();
    const res = await register(b, 'dup@example.test');
    assert.equal(res.status, 409);
    assert.equal((res.body as { error: { code: string } }).error.code, 'email_taken');
  });

  it('يرفض مدة احتفاظ خارج الحدود على مستوى قاعدة البيانات', async () => {
    const user = await server.sql("select id from users where email_normalized = 'dup@example.test'");
    const id = user.rows[0]!.id;
    await assert.rejects(
      () => server.sql('update user_settings set content_retention_hours = 0 where user_id = $1', [id]),
      /user_settings_retention_range/,
    );
  });

  it('يحذف الجلسات تلقائياً عند حذف المستخدم (cascade)', async () => {
    const res = await server.sql(
      "select count(*)::int as count from user_sessions s join users u on u.id = s.user_id where u.email_normalized = 'dup@example.test'",
    );
    assert.ok(Number(res.rows[0]!.count) >= 1);
    await server.sql("delete from users where email_normalized = 'dup@example.test'");
    const after = await server.sql(
      "select count(*)::int as c from user_sessions s join users u on u.id = s.user_id where u.email_normalized = 'dup@example.test'",
    );
    assert.equal(Number(after.rows[0]!.c), 0);
  });
});

describe('التسجيل', () => {
  it('ينشئ حساباً ويُصدر جلسةً ويحفظ كلمة المرور مجزّأة', async () => {
    const api = c();
    const res = await register(api, 'user1@example.test', 'المستخدم الأول');
    assert.equal(res.status, 201);
    const body = res.body as { user: { id: string; role: string }; csrfToken: string };
    assert.equal(body.user.role, 'user');
    assert.ok(body.csrfToken.length > 30);
    assert.ok(api.cookie.startsWith('tg_sid='));

    const stored = await server.sql('select password_hash, email_normalized from users where id = $1', [body.user.id]);
    const hash = String(stored.rows[0]!.password_hash);
    assert.ok(hash.startsWith('scrypt$'));
    assert.ok(!hash.includes(PASSWORD));
    assert.equal(stored.rows[0]!.email_normalized, 'user1@example.test');

    const settings = await server.sql('select content_retention_hours from user_settings where user_id = $1', [body.user.id]);
    assert.equal(Number(settings.rows[0]!.content_retention_hours), 48);

    const audit = await server.sql("select count(*)::int as c from audit_events where action = 'auth.register' and actor_user_id = $1", [body.user.id]);
    assert.equal(Number(audit.rows[0]!.c), 1);
  });

  it('يجعل أول حساب بريد المدير المُهيّأ مديراً للنظام', async () => {
    const api = c();
    const res = await register(api, 'owner@example.test', 'مالك المشروع');
    assert.equal(res.status, 201);
    assert.equal((res.body as { user: { role: string } }).user.role, 'admin');
  });

  it('يرفض كلمة مرور ضعيفة', async () => {
    const res = await register(c(), 'weak@example.test', 'ضعيف', 'password123');
    assert.equal(res.status, 409);
    assert.equal((res.body as { error: { code: string } }).error.code, 'weak_password');
  });

  it('يرفض طلباً غير صالح مع تفصيل الحقل', async () => {
    const res = await c().post('/api/v1/auth/register', { email: 'not-an-email', displayName: 'x', password: 'A1b2c3d4e5' });
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, 'validation_error');
  });
});

describe('تسجيل الدخول والقفل', () => {
  it('يرفض بيانات دخول خاطئة برسالة عامة ويسجل المحاولة', async () => {
    const res = await c().post('/api/v1/auth/login', { email: 'user1@example.test', password: 'WrongPassword1' });
    assert.equal(res.status, 401);
    assert.match((res.body as { error: { message: string } }).error.message, /البريد الإلكتروني أو كلمة المرور/);
    const attempts = await server.sql("select count(*)::int as c from login_attempts where email_normalized = 'user1@example.test' and outcome = 'bad_credentials'");
    assert.ok(Number(attempts.rows[0]!.c) >= 1);
  });

  it('يقفل المحاولات بعد تجاوز الحد ويرفض كلمة المرور الصحيحة أثناء القفل', async () => {
    const api = c();
    for (let i = 0; i < 3; i += 1) {
      await api.post('/api/v1/auth/login', { email: 'user1@example.test', password: 'WrongPassword1' });
    }
    const locked = await api.post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });
    assert.equal(locked.status, 423);
    assert.equal((locked.body as { error: { code: string } }).error.code, 'account_locked');
    // تحرير القفل لتستمر الاختبارات اللاحقة
    await server.sql("update users set locked_until = null, failed_login_count = 0 where email_normalized = 'user1@example.test'");
    await server.sql("delete from login_attempts where email_normalized = 'user1@example.test'");
  });

  it('يقبل بيانات صحيحة ويحدّث آخر دخول', async () => {
    const api = c();
    const res = await api.post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });
    assert.equal(res.status, 200);
    const row = await server.sql("select last_login_at from users where email_normalized = 'user1@example.test'");
    assert.ok(row.rows[0]!.last_login_at instanceof Date);
  });
});

describe('الجلسات و CSRF', () => {
  it('يرفض طلباً مغيّراً للحالة دون رمز CSRF', async () => {
    const api = c();
    await api.post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });
    api.csrf = null;
    const res = await api.patch('/api/v1/me', { displayName: 'اسم دون رمز' });
    assert.equal(res.status, 403);
    assert.equal((res.body as { error: { code: string } }).error.code, 'csrf_failed');
  });

  it('يقبل الطلب مع رمز صالح ويحدّث الاسم', async () => {
    const api = c();
    await api.post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });
    const res = await api.patch('/api/v1/me', { displayName: 'اسم محدّث' });
    assert.equal(res.status, 200);
    assert.equal((res.body as { user: { displayName: string } }).user.displayName, 'اسم محدّث');
  });

  it('يعرض الجلسات الحالية ويبطل جلسة أخرى', async () => {
    // حساب مستقل بجلستين فقط لعزل الاختبار عن بقية الجلسات
    assert.equal((await register(c(), 'sessions@example.test', 'حساب الجلسات')).status, 201);
    const first = c();
    await first.post('/api/v1/auth/login', { email: 'sessions@example.test', password: PASSWORD });
    const second = c();
    await second.post('/api/v1/auth/login', { email: 'sessions@example.test', password: PASSWORD });

    await first.refreshCsrf();
    const list = await first.get('/api/v1/me/sessions');
    assert.equal(list.status, 200);
    const sessions = (list.body as { sessions: { id: string; current: boolean }[] }).sessions;
    // جلسة من التسجيل + جلستان من تسجيل الدخول = 3 جلسات نشطة
    assert.equal(sessions.length, 3);
    assert.equal(sessions.filter((s) => s.current).length, 1);
    const other = sessions.find((s) => !s.current);
    assert.ok(other);

    const revoked = await first.del(`/api/v1/me/sessions/${other.id}`);
    assert.equal(revoked.status, 204);

    const meAfter = await second.get('/api/v1/me');
    assert.equal(meAfter.status, 401);
  });

  it('ينهي الجلسة عند تسجيل الخروج', async () => {
    const api = c();
    await api.post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });
    assert.equal((await api.post('/api/v1/auth/logout')).status, 204);
    assert.equal((await api.get('/api/v1/me')).status, 401);
  });
});

describe('العزل والصلاحيات', () => {
  it('يمنع المستخدم العادي من مسارات الإدارة', async () => {
    const api = c();
    await api.post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });
    const res = await api.get('/api/v1/admin/users');
    assert.equal(res.status, 403);
  });

  it('يمنع إبطال جلسة مستخدم آخر (يظهر كغير موجودة)', async () => {
    const admin = c();
    await admin.post('/api/v1/auth/login', { email: 'owner@example.test', password: PASSWORD });
    const adminSessions = await admin.get('/api/v1/me/sessions');
    const adminSessionId = (adminSessions.body as { sessions: { id: string }[] }).sessions[0]!.id

    const user = c();
    await user.post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });
    const res = await user.del(`/api/v1/me/sessions/${adminSessionId}`);
    assert.equal(res.status, 404);
  });

  it('يرفض الأصول غير المسموحة', async () => {
    const res = await c().request('/api/v1/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  });

  it('يقبل الطلب من نفس الأصل (Origin مطابق لـ Host)', async () => {
    const api = c();
    const res = await api.request('/api/v1/auth/register', {
      method: 'POST',
      // نفس أصل الخادم الفعلي: Origin.host == Host تلقائياً
      headers: { origin: server.baseUrl },
      body: { email: 'sameorigin@example.test', displayName: 'اختبار الأصل', password: PASSWORD },
    });
    assert.equal(res.status, 201);
  });
});

describe('إدارة المستخدمين', () => {
  it('تتيح للمدير عرض المستخدمين دون كشف أسرار', async () => {
    const admin = c();
    await admin.post('/api/v1/auth/login', { email: 'owner@example.test', password: PASSWORD });
    const res = await admin.get('/api/v1/admin/users');
    assert.equal(res.status, 200);
    const body = res.body as { users: Record<string, unknown>[]; total: number };
    assert.ok(body.total >= 2);
    assert.ok(!JSON.stringify(body).includes('scrypt$'));
    assert.ok(!JSON.stringify(body).includes('token_hash'));
  });

  it('يوقف المدير حساباً ويبطل جلساته ويمنع دخوله', async () => {
    const victim = c();
    await victim.post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });
    const victimId = ((await victim.get('/api/v1/me')).body as { user: { id: string } }).user.id;

    const admin = c();
    await admin.post('/api/v1/auth/login', { email: 'owner@example.test', password: PASSWORD });
    const suspend = await admin.patch(`/api/v1/admin/users/${victimId}/status`, {
      status: 'suspended',
      reason: 'مراجعة أمنية تجريبية',
    });
    assert.equal(suspend.status, 204);

    assert.equal((await victim.get('/api/v1/me')).status, 401);
    const blocked = await c().post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });
    assert.equal(blocked.status, 401);

    const restore = await admin.patch(`/api/v1/admin/users/${victimId}/status`, {
      status: 'active',
      reason: 'انتهاء المراجعة',
    });
    assert.equal(restore.status, 204);
    const login = await c().post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });
    assert.equal(login.status, 200);
  });

  it('يمنع إجراءات إدارية على حساب المدير نفسه', async () => {
    const admin = c();
    await admin.post('/api/v1/auth/login', { email: 'owner@example.test', password: PASSWORD });
    const me = ((await admin.get('/api/v1/me')).body as { user: { id: string } }).user.id;
    const res = await admin.patch(`/api/v1/admin/users/${me}/status`, { status: 'suspended', reason: 'محاولة ذاتية' });
    assert.equal(res.status, 409);
  });

  it('يمنع إزالة الدور عن آخر مدير نشط', async () => {
    const admin = c();
    await admin.post('/api/v1/auth/login', { email: 'owner@example.test', password: PASSWORD });
    const created = await register(c(), 'admin2@example.test', 'مدير ثانٍ');
    const id2 = (created.body as { user: { id: string } }).user.id;
    assert.equal((await admin.patch(`/api/v1/admin/users/${id2}/role`, { role: 'admin', reason: 'حاجة تشغيلية' })).status, 204);

    const admin2 = c();
    await admin2.post('/api/v1/auth/login', { email: 'admin2@example.test', password: PASSWORD });
    const me1 = ((await admin.get('/api/v1/me')).body as { user: { id: string } }).user.id;

    // المدير الثاني يخفض المدير الأول: مسموح لأنه ليس الأخير
    assert.equal((await admin2.patch(`/api/v1/admin/users/${me1}/role`, { role: 'user', reason: 'تغيير واجبات' })).status, 204);
    // الآن admin2 هو الأخير: يُرفض خفضه
    const res = await admin2.patch(`/api/v1/admin/users/${id2}/role`, { role: 'user', reason: 'محاولة' });
    assert.equal(res.status, 409);
    // إعادة الأول إلى مدير لبقية الاختبارات
    assert.equal((await admin2.patch(`/api/v1/admin/users/${me1}/role`, { role: 'admin', reason: 'إعادة الصلاحية' })).status, 204);
  });

  it('يقرأ المدير الإحصاءات التشغيلية وسجل التدقيق', async () => {
    const admin = c();
    await admin.post('/api/v1/auth/login', { email: 'owner@example.test', password: PASSWORD });
    const overview = await admin.get('/api/v1/admin/overview');
    assert.equal(overview.status, 200);
    assert.ok(Number((overview.body as { overview: { users_total: number } }).overview.users_total) >= 2);

    const audit = await admin.get('/api/v1/admin/audit?limit=50');
    assert.equal(audit.status, 200);
    const text = JSON.stringify(audit.body);
    assert.ok(!text.includes('scrypt$'));
    assert.ok(!text.toLowerCase().includes('correcthorse'));
  });
});

describe('كلمة المرور', () => {
  it('تغيّر كلمة المرور وتبطل الجلسات الأخرى', async () => {
    const current = c();
    await current.post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });
    const other = c();
    await other.post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD });

    const res = await current.post('/api/v1/auth/password/change', {
      currentPassword: PASSWORD,
      newPassword: 'NewPassword456',
    });
    assert.equal(res.status, 204);
    assert.equal((await other.get('/api/v1/me')).status, 401);
    assert.equal((await current.get('/api/v1/me')).status, 200);
    assert.equal((await c().post('/api/v1/auth/login', { email: 'user1@example.test', password: PASSWORD })).status, 401);
    assert.equal((await c().post('/api/v1/auth/login', { email: 'user1@example.test', password: 'NewPassword456' })).status, 200);
  });

  it('يكمل مسار الاستعادة برمز لمرة واحدة', async () => {
    const api = c();
    const forgot = await api.post('/api/v1/auth/password/forgot', { email: 'user1@example.test' });
    assert.equal(forgot.status, 202);
    const token = (forgot.body as { devResetToken?: string }).devResetToken;
    assert.ok(token && token.length > 20);

    const reset = await api.post('/api/v1/auth/password/reset', { token, password: 'ResetPassword789' });
    assert.equal(reset.status, 204);

    const reuse = await c().post('/api/v1/auth/password/reset', { token, password: 'AnotherPass123' });
    assert.equal(reuse.status, 401);

    assert.equal((await c().post('/api/v1/auth/login', { email: 'user1@example.test', password: 'ResetPassword789' })).status, 200);

    const outbox = await server.sql("select status, payload from notification_outbox where template = 'auth.password_reset' order by created_at desc limit 1");
    assert.equal(outbox.rows.length, 1);
    assert.ok(!JSON.stringify(outbox.rows[0]!.payload).includes(String(token)));
  });

  it('لا يكشف وجود البريد عند طلب الاستعادة', async () => {
    const api = c();
    const unknown = await api.post('/api/v1/auth/password/forgot', { email: 'ghost@example.test' });
    assert.equal(unknown.status, 202);
    assert.equal((unknown.body as { devResetToken?: string }).devResetToken, undefined);
  });
});

describe('الإعدادات', () => {
  it('تحدّث مدة الاحتفاظ الشخصية وترفض قيمة خارج الحدود', async () => {
    const api = c();
    await api.post('/api/v1/auth/login', { email: 'admin2@example.test', password: PASSWORD });
    const ok = await api.patch('/api/v1/me/settings', { contentRetentionHours: 72 });
    assert.equal(ok.status, 200);
    assert.equal((ok.body as { settings: { contentRetentionHours: number } }).settings.contentRetentionHours, 72);
    const bad = await api.patch('/api/v1/me/settings', { contentRetentionHours: 5000 });
    assert.equal(bad.status, 400);
  });

  it('يطبّق المدير القيمة الافتراضية على الحسابات الجديدة', async () => {
    const admin = c();
    await admin.post('/api/v1/auth/login', { email: 'owner@example.test', password: PASSWORD });
    const upd = await admin.request('/api/v1/admin/settings/system.default_content_retention_hours', {
      method: 'PUT',
      body: { value: { hours: 36 } },
    });
    assert.equal(upd.status, 204);

    const created = await register(c(), 'newdefault@example.test', 'حساب جديد');
    const id = (created.body as { user: { id: string } }).user.id;
    const row = await server.sql('select content_retention_hours from user_settings where user_id = $1', [id]);
    assert.equal(Number(row.rows[0]!.content_retention_hours), 36);
  });

  it('يمنع تعطيل التسجيل عبر إعداد النظام', async () => {
    const admin = c();
    await admin.post('/api/v1/auth/login', { email: 'owner@example.test', password: PASSWORD });
    await admin.request('/api/v1/admin/settings/system.registration_enabled', {
      method: 'PUT',
      body: { value: { enabled: false } },
    });
    const blocked = await register(c(), 'blocked@example.test');
    assert.equal(blocked.status, 403);
    await admin.request('/api/v1/admin/settings/system.registration_enabled', {
      method: 'PUT',
      body: { value: { enabled: true } },
    });
  });
});

describe('حذف الحساب', () => {
  // تحديث P4-د (Q22): الحذف صار **نهائياً فورياً** لا تعطيلاً منطقياً، مع عبارة تأكيد حرفية + كلمة المرور.
  it('يطلب كلمة المرور وعبارة التأكيد، ثم يحذف الصف نهائياً ويمنع الدخول', async () => {
    const created = await register(c(), 'delete@example.test', 'حساب للحذف');
    const id = (created.body as { user: { id: string } }).user.id;
    const api = c();
    await api.post('/api/v1/auth/login', { email: 'delete@example.test', password: PASSWORD });

    // بلا عبارة تأكيد: مرفوض مهما كانت كلمة المرور صحيحة.
    assert.equal((await api.del('/api/v1/me', { password: PASSWORD })).status, 400);

    const wrong = await api.del('/api/v1/me', {
      password: 'WrongPass1234',
      confirmation: 'احذف حسابي نهائياً',
    });
    assert.equal(wrong.status, 403);

    const ok = await api.del('/api/v1/me', { password: PASSWORD, confirmation: 'احذف حسابي نهائياً' });
    assert.equal(ok.status, 204);
    assert.equal((await api.get('/api/v1/me')).status, 401);
    assert.equal((await c().post('/api/v1/auth/login', { email: 'delete@example.test', password: PASSWORD })).status, 401);

    // حذف فعلي: الصف غير موجود أصلاً، لا مجرد حالة `deleted`.
    const row = await server.sql('select id from users where id = $1', [id]);
    assert.equal(row.rows.length, 0);
  });
});

describe('تحديد المعدل', () => {
  it('يحدّ طلبات استعادة كلمة المرور المتكررة', async () => {
    const api = c();
    let lastStatus = 0;
    for (let i = 0; i < 7; i += 1) {
      const res = await api.post('/api/v1/auth/password/forgot', { email: 'ratelimit@example.test' });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  });
});
