/**
 * لوحة مدير النظام — بيانات تشغيلية فقط.
 * D07: لا محتوى مستخدمين افتراضياً، ولا كشف للجلسات أو التجزئات أو الرموز.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { asyncHandler, clientIp, parseBody, parseQuery, userAgent } from '../../lib/http.js';
import { currentAuth, requireAuth, requireRole } from '../../middleware/auth.js';
import { PgRetentionStore } from '../retention/retentionRepository.js';

export const adminRouter: Router = Router();
adminRouter.use(requireAuth, requireRole('admin'));

const listSchema = z.object({
  query: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'suspended', 'deleted']).optional(),
  role: z.enum(['user', 'admin']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

const statusSchema = z.object({
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(3).max(300),
});

const roleSchema = z.object({
  role: z.enum(['user', 'admin']),
  reason: z.string().trim().min(3).max(300),
});

const settingSchema = z.object({ value: z.record(z.unknown()) });

/** حذف البيانات التشغيلية لمستخدم (Q21): بسبب إلزامي يُحفظ في التدقيق. */
const purgeUserDataSchema = z.object({
  reason: z.string().trim().min(5).max(300),
});

const retentionStore = new PgRetentionStore();

adminRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const counts = await query<{
      users_total: number;
      users_active: number;
      users_suspended: number;
      admins_active: number;
      sessions_active: number;
      pending_notifications: number;
      failed_notifications: number;
      alerts_open_critical: number;
    }>(`
      select
        (select count(*)::int from users where status <> 'deleted') as users_total,
        (select count(*)::int from users where status = 'active') as users_active,
        (select count(*)::int from users where status = 'suspended') as users_suspended,
        (select count(*)::int from users where role = 'admin' and status = 'active') as admins_active,
        (select count(*)::int from user_sessions where revoked_at is null and expires_at > now()) as sessions_active,
        (select count(*)::int from notification_outbox where status = 'pending') as pending_notifications,
        (select count(*)::int from notification_outbox where status = 'failed') as failed_notifications,
        (select count(*)::int from alert_notifications where resolved_at is null and severity = 'critical') as alerts_open_critical
    `);
    res.json({ overview: counts.rows[0] });
  }),
);

adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const params = parseQuery(listSchema, req.query);
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.query) {
      values.push(`%${params.query.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
      conditions.push(`(email ilike $${values.length} or display_name ilike $${values.length})`);
    }
    if (params.status) {
      values.push(params.status);
      conditions.push(`status = $${values.length}`);
    } else {
      conditions.push("status <> 'deleted'");
    }
    if (params.role) {
      values.push(params.role);
      conditions.push(`role = $${values.length}`);
    }
    const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
    const filterValues = [...values];
    values.push(params.limit, params.offset);
    const rows = await query<{
      id: string;
      email: string;
      display_name: string;
      role: 'user' | 'admin';
      status: 'active' | 'suspended' | 'deleted';
      created_at: Date;
      last_login_at: Date | null;
      active_sessions: number;
    }>(
      `select u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_login_at,
              (select count(*)::int from user_sessions s
                where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as active_sessions
         from users u
         ${where}
        order by u.created_at desc
        limit $${values.length - 1} offset $${values.length}`,
      values,
    );
    const total = await query<{ count: number }>(
      `select count(*)::int as count from users ${where}`,
      filterValues,
    );
    res.json({
      users: rows.rows.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        role: u.role,
        status: u.status,
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
        activeSessions: u.active_sessions,
      })),
      total: total.rows[0]?.count ?? 0,
      limit: params.limit,
      offset: params.offset,
    });
  }),
);

adminRouter.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const result = await query<{
      id: string;
      email: string;
      display_name: string;
      role: 'user' | 'admin';
      status: 'active' | 'suspended' | 'deleted';
      created_at: Date;
      last_login_at: Date | null;
      email_verified_at: Date | null;
      active_sessions: number;
      content_retention_hours: number;
    }>(
      `select u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_login_at,
              u.email_verified_at,
              (select count(*)::int from user_sessions s
                where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as active_sessions,
              coalesce(us.content_retention_hours, 48) as content_retention_hours
         from users u left join user_settings us on us.user_id = u.id
        where u.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw notFound('المستخدم غير موجود.');
    res.json({
      user: {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
        emailVerifiedAt: row.email_verified_at,
        activeSessions: row.active_sessions,
        contentRetentionHours: row.content_retention_hours,
      },
    });
  }),
);

async function assertNotLastAdmin(targetId: string): Promise<void> {
  const target = await query<{ role: string; status: string }>('select role, status from users where id = $1', [targetId]);
  const row = target.rows[0];
  if (!row) throw notFound('المستخدم غير موجود.');
  if (row.role !== 'admin' || row.status !== 'active') return;
  const admins = await query<{ count: number }>(
    "select count(*)::int as count from users where role = 'admin' and status = 'active'",
  );
  if ((admins.rows[0]?.count ?? 0) <= 1) {
    throw conflict('last_admin', 'لا يمكن تعطيل أو تخفيض آخر مدير نظام نشط.');
  }
}

adminRouter.patch(
  '/users/:id/status',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = parseBody(statusSchema, req.body);
    if (id === auth.user.id) throw conflict('self_action', 'لا يمكنك تغيير حالة حسابك من هنا.');
    await withTransaction(async (client) => {
      if (body.status === 'suspended') await assertNotLastAdmin(id);
      const updated = await client.query(
        "update users set status = $2, deleted_at = null where id = $1 returning id",
        [id, body.status],
      );
      if ((updated.rowCount ?? 0) === 0) throw notFound('المستخدم غير موجود.');
      if (body.status === 'suspended') {
        await client.query(
          `update user_sessions set revoked_at = now(), revoked_reason = 'admin_suspended'
            where user_id = $1 and revoked_at is null`,
          [id],
        );
      }
      await recordAudit(
        {
          action: body.status === 'suspended' ? 'admin.user_suspended' : 'admin.user_reactivated',
          actorUserId: auth.user.id,
          actorRole: 'admin',
          targetType: 'user',
          targetId: id,
          ip: clientIp(req),
          userAgent: userAgent(req),
          metadata: { reason: body.reason },
        },
        client,
      );
    });
    res.status(204).end();
  }),
);

adminRouter.patch(
  '/users/:id/role',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = parseBody(roleSchema, req.body);
    if (id === auth.user.id && body.role !== 'admin') {
      throw conflict('self_action', 'لا يمكنك إزالة دور المدير عن حسابك.');
    }
    await withTransaction(async (client) => {
      if (body.role === 'user') await assertNotLastAdmin(id);
      const updated = await client.query(
        "update users set role = $2 where id = $1 and status <> 'deleted' returning id",
        [id, body.role],
      );
      if ((updated.rowCount ?? 0) === 0) throw notFound('المستخدم غير موجود.');
      await recordAudit(
        {
          action: 'admin.user_role_changed',
          actorUserId: auth.user.id,
          actorRole: 'admin',
          targetType: 'user',
          targetId: id,
          ip: clientIp(req),
          userAgent: userAgent(req),
          metadata: { role: body.role, reason: body.reason },
        },
        client,
      );
    });
    res.status(204).end();
  }),
);

adminRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    const result = await query<{ key: string; value: Record<string, unknown>; description: string | null; updated_at: Date }>(
      'select key, value, description, updated_at from system_settings order by key',
    );
    res.json({ settings: result.rows });
  }),
);

adminRouter.put(
  '/settings/:key',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const key = z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/).parse(req.params.key);
    const body = parseBody(settingSchema, req.body);
    const existing = await query('select 1 from system_settings where key = $1', [key]);
    if ((existing.rowCount ?? 0) === 0) throw notFound('الإعداد غير معروف.');
    if (key === 'system.default_content_retention_hours') {
      const hours = body.value.hours;
      if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 2160) {
        throw conflict('invalid_value', 'قيمة المدة يجب أن تكون عدداً صحيحاً بين 1 و2160 ساعة.');
      }
    }
    if (key === 'system.registration_enabled' && typeof body.value.enabled !== 'boolean') {
      throw conflict('invalid_value', 'القيمة يجب أن تكون منطقية (true/false).');
    }
    await withTransaction(async (client) => {
      await client.query('update system_settings set value = $2::jsonb, updated_by = $3, updated_at = now() where key = $1', [
        key,
        JSON.stringify(body.value),
        auth.user.id,
      ]);
      await recordAudit(
        {
          action: 'admin.system_setting_updated',
          actorUserId: auth.user.id,
          actorRole: 'admin',
          targetType: 'system_setting',
          targetId: key,
          ip: clientIp(req),
          userAgent: userAgent(req),
          metadata: { keys: Object.keys(body.value) },
        },
        client,
      );
    });
    res.status(204).end();
  }),
);

adminRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const params = parseQuery(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      req.query,
    );
    const rows = await query<{
      id: number;
      occurred_at: Date;
      actor_user_id: string | null;
      actor_role: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      outcome: string;
      ip: string | null;
    }>(
      `select id, occurred_at, actor_user_id, actor_role, action, target_type, target_id, outcome, ip
         from audit_events order by occurred_at desc limit $1`,
      [params.limit],
    );
    res.json({ events: rows.rows });
  }),
);

/**
 * حذف بيانات التشغيل لمستخدم (P4-د، Q21): المحتوى والتسليمات فقط.
 * لا يمسّ الحساب ولا إعداداته ولا جلساته، ولا يُكشف أي محتوى للمدير (Q24) — أعداد فقط.
 */
adminRouter.post(
  '/users/:id/purge-data',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const userId = z.string().uuid().parse(req.params.id);
    const body = parseBody(purgeUserDataSchema, req.body);
    const exists = await query('select 1 from users where id = $1', [userId]);
    if ((exists.rowCount ?? 0) === 0) throw notFound('المستخدم غير موجود.');
    const result = await retentionStore.purgeOperationalData(userId);
    await recordAudit({
      action: 'admin.user_data_purged',
      actorUserId: auth.user.id,
      actorRole: 'admin',
      targetType: 'user',
      targetId: userId,
      ip: clientIp(req),
      userAgent: userAgent(req),
      metadata: { reason: body.reason, total: result.total, report: result.report },
    });
    res.json({ purgedAt: new Date().toISOString(), total: result.total, report: result.report });
  }),
);

// تُستخدم في عامل الصيانة اللاحق؛ متاحة إدارياً لتنظيف الجلسات المنتهية فقط.
adminRouter.post(
  '/maintenance/purge-sessions',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const result = await query(
      "delete from user_sessions where absolute_expires_at < now() or (revoked_at is not null and revoked_at < now() - interval '7 days')",
    );
    await recordAudit({
      action: 'admin.sessions_purged',
      actorUserId: auth.user.id,
      actorRole: 'admin',
      targetType: 'system',
      targetId: 'user_sessions',
      ip: clientIp(req),
      userAgent: userAgent(req),
      metadata: { deleted: result.rowCount ?? 0 },
    });
    res.json({ deleted: result.rowCount ?? 0 });
  }),
);
