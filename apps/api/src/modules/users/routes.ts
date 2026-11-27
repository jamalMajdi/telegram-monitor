import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { asyncHandler, clientIp, parseBody, userAgent } from '../../lib/http.js';
import { verifyPassword } from '../../lib/password.js';
import { currentAuth, requireAuth } from '../../middleware/auth.js';
import { clearSessionCookie, listSessions, revokeAllSessions, revokeSession } from '../auth/sessionService.js';
import { PgRetentionStore } from '../retention/retentionRepository.js';
import { DELETE_ACCOUNT_PHRASE, PURGE_PHRASE, isDeleteConfirmed, isPurgeConfirmed } from './dangerZone.js';

export const meRouter: Router = Router();
meRouter.use(requireAuth);

const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
});

const purgeSchema = z.object({
  // العبارة الحرفية إلزامية (Q21): لا حذف بنقرة واحدة.
  confirmation: z.string().min(1).max(80),
});

const deleteSchema = z.object({
  password: z.string().min(1).max(200),
  // العبارة الحرفية + كلمة المرور (Q22): تأكيد مزدوج لحذف نهائي بلا رجعة.
  confirmation: z.string().min(1).max(80),
});

const retention = new PgRetentionStore();

meRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const settings = await query<{ content_retention_hours: number }>(
      'select content_retention_hours from user_settings where user_id = $1',
      [auth.user.id],
    );
    res.json({
      user: auth.user,
      settings: { contentRetentionHours: settings.rows[0]?.content_retention_hours ?? 48 },
      // عبارات التأكيد تأتي من الخادم حتى تبقى الواجهة متزامنة بلا نسخة ثانية.
      dangerZone: { purgePhrase: PURGE_PHRASE, deletePhrase: DELETE_ACCOUNT_PHRASE },
    });
  }),
);

meRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const body = parseBody(profileSchema, req.body);
    if (body.displayName === undefined) {
      res.status(400).json({ error: { code: 'validation_error', message: 'لا يوجد أي تغيير مطلوب.' } });
      return;
    }
    const updated = await query<{ id: string; email: string; display_name: string; role: 'user' | 'admin'; status: 'active' }>(
      'update users set display_name = $2 where id = $1 returning id, email, display_name, role, status',
      [auth.user.id, body.displayName],
    );
    const row = updated.rows[0]!;
    await recordAudit({
      action: 'user.profile_updated',
      actorUserId: auth.user.id,
      actorRole: auth.user.role,
      targetType: 'user',
      targetId: auth.user.id,
      ip: clientIp(req),
      userAgent: userAgent(req),
      metadata: { field: 'displayName' },
    });
    res.json({ user: { id: row.id, email: row.email, displayName: row.display_name, role: row.role, status: row.status } });
  }),
);

meRouter.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const rows = await listSessions(auth.user.id, auth.sessionId);
    res.json({
      sessions: rows.map((s) => ({
        id: s.id,
        userAgent: s.user_agent,
        ip: s.ip,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at,
        current: s.current,
      })),
    });
  }),
);

meRouter.delete(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const id = z.string().uuid().parse(req.params.id);
    const owned = await query('select 1 from user_sessions where id = $1 and user_id = $2', [id, auth.user.id]);
    if ((owned.rowCount ?? 0) === 0) throw notFound('الجلسة غير موجودة.');
    await revokeSession(id, 'user_revoked');
    await recordAudit({
      action: 'user.session_revoked',
      actorUserId: auth.user.id,
      actorRole: auth.user.role,
      targetType: 'session',
      targetId: id,
      ip: clientIp(req),
      userAgent: userAgent(req),
    });
    if (id === auth.sessionId) clearSessionCookie(res);
    res.status(204).end();
  }),
);

/**
 * حذف البيانات التشغيلية الآن (P4-د، Q21).
 *
 * يحذف: التسليمات وأجزاءها ومحاولاتها وأدلتها + هويات الرسائل ومحتواها واستخراجها
 * وتصنيفها ومطابقاتها + أحداث الأخطاء الخاصة بالمستخدم.
 * **لا يمسّ**: الإعدادات، الجلسات، الحسابات، المصادر، الفلاتر، القوالب، الوجهات، سجل التدقيق.
 */
meRouter.post(
  '/data/purge',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const body = parseBody(purgeSchema, req.body);
    if (!isPurgeConfirmed(body.confirmation)) {
      throw badRequest('confirmation_mismatch', `عبارة التأكيد غير مطابقة. اكتب: ${PURGE_PHRASE}`);
    }
    const result = await retention.purgeOperationalData(auth.user.id);
    await recordAudit({
      action: 'user.operational_data_purged',
      actorUserId: auth.user.id,
      actorRole: auth.user.role,
      targetType: 'user',
      targetId: auth.user.id,
      ip: clientIp(req),
      userAgent: userAgent(req),
      metadata: { total: result.total, report: result.report },
    });
    res.json({ purgedAt: new Date().toISOString(), total: result.total, report: result.report });
  }),
);

/** حذف الحساب نهائياً (P4-د، Q22): كل ما يخصه يزول في معاملة واحدة، والتدقيق يبقى بلا هوية. */
meRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const body = parseBody(deleteSchema, req.body);
    if (!isDeleteConfirmed(body.confirmation)) {
      throw badRequest('confirmation_mismatch', `عبارة التأكيد غير مطابقة. اكتب: ${DELETE_ACCOUNT_PHRASE}`);
    }
    const res0 = await query<{ password_hash: string }>('select password_hash from users where id = $1', [auth.user.id]);
    const row = res0.rows[0];
    if (!row) throw unauthorized();
    if (!(await verifyPassword(body.password, row.password_hash))) {
      throw forbidden('كلمة المرور غير صحيحة.');
    }
    // 1) إبطال كل الجلسات أولاً: لا يبقى أي وصول صالح ولو لجزء من الثانية.
    await revokeAllSessions(auth.user.id, 'account_deleted');
    // 2) معاملة واحدة: حذف الصف يجرّ معه كل ما يخصه بالتسلسل (حسابات، أسرار، بوتات، بيانات، إعدادات).
    const outcome = await retention.hardDeleteAccount(auth.user.id);
    // 3) أثر مدقَّق بلا PII: لا بريد ولا اسم ولا معرّف مستخدم بعد الحذف.
    await recordAudit({
      action: 'user.account_hard_deleted',
      actorUserId: null,
      actorRole: auth.user.role,
      targetType: 'user',
      targetId: null,
      ip: clientIp(req),
      userAgent: null,
      metadata: { deleted: outcome.deleted, report: outcome.report },
    });
    clearSessionCookie(res);
    res.status(204).end();
  }),
);
