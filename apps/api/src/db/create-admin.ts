/**
 * أداة تشغيل إدارية: ترقية مستخدم موجود إلى مدير نظام.
 * لا تُنشئ حسابات بكلمات مرور مسبقة الصنع. الاستخدام:
 *   npm run create-admin -- user@example.com
 */
import { query, closePool } from './pool.js';
import { recordAudit } from '../lib/audit.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('الاستخدام: npm run create-admin -- <email>');
  process.exit(1);
}

const result = await query<{ id: string; email: string; role: string }>(
  `update users set role = 'admin'
    where email_normalized = $1 and status = 'active'
    returning id, email, role`,
  [email],
);
if (result.rowCount === 0) {
  console.error('لا يوجد مستخدم نشط بهذا البريد. أنشئ الحساب عبر التسجيل أولاً ثم أعد المحاولة.');
  process.exitCode = 1;
} else {
  const row = result.rows[0]!;
  await recordAudit({
    action: 'admin.user_role_changed',
    targetType: 'user',
    targetId: row.id,
    metadata: { role: 'admin', source: 'cli' },
  });
  console.log(`تمت ترقية ${row.email} إلى مدير نظام.`);
}
await closePool();
