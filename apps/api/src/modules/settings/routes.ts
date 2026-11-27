import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { asyncHandler, clientIp, parseBody, userAgent } from '../../lib/http.js';
import { currentAuth, requireAuth } from '../../middleware/auth.js';

export const settingsRouter: Router = Router();
settingsRouter.use(requireAuth);

const patchSchema = z
  .object({
    contentRetentionHours: z.number().int().min(1).max(2160).optional(),
    // احتفاظ سجلات النشر (Q13): 1–3650 يوماً، وقاعدة البيانات تفرض نفس المدى.
    deliveryRetentionDays: z.number().int().min(1).max(3650).optional(),
    notifications: z.record(z.unknown()).optional(),
    processing: z.record(z.unknown()).optional(),
    // هوية المصدر والمرسل: افتراضياً مفعّلة (Opt-out)، ويمكن اختيار العناصر المعروضة.
    attributionEnabled: z.boolean().optional(),
    attributionMode: z.enum(['source', 'sender', 'both']).optional(),
    attributionShowUsername: z.boolean().optional(),
    attributionShowId: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'لا يوجد أي تغيير مطلوب.' });

settingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const result = await query<{
      content_retention_hours: number;
      delivery_retention_days: number;
      notifications: Record<string, unknown>;
      processing: Record<string, unknown>;
      attribution_enabled: boolean;
      attribution_mode: 'source' | 'sender' | 'both';
      attribution_show_username: boolean;
      attribution_show_id: boolean;
      updated_at: Date;
    }>(
      `select content_retention_hours, delivery_retention_days, notifications, processing,
              attribution_enabled, attribution_mode, attribution_show_username, attribution_show_id,
              updated_at
         from user_settings where user_id = $1`,
      [auth.user.id],
    );
    const row = result.rows[0];
    res.json({
      settings: {
        contentRetentionHours: row?.content_retention_hours ?? 48,
        deliveryRetentionDays: row?.delivery_retention_days ?? 90,
        notifications: row?.notifications ?? {},
        processing: row?.processing ?? {},
        attribution: {
          enabled: row?.attribution_enabled ?? true,
          mode: row?.attribution_mode ?? 'both',
          showUsername: row?.attribution_show_username ?? true,
          showId: row?.attribution_show_id ?? false,
        },
        updatedAt: row?.updated_at ?? null,
      },
    });
  }),
);

settingsRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    const body = parseBody(patchSchema, req.body);
    const updated = await query<{
      content_retention_hours: number;
      delivery_retention_days: number;
      notifications: Record<string, unknown>;
      processing: Record<string, unknown>;
      attribution_enabled: boolean;
      attribution_mode: 'source' | 'sender' | 'both';
      attribution_show_username: boolean;
      attribution_show_id: boolean;
      updated_at: Date;
    }>(
      `update user_settings
          set content_retention_hours = coalesce($2, content_retention_hours),
              delivery_retention_days = coalesce($5, delivery_retention_days),
              notifications = coalesce($3::jsonb, notifications),
              processing = coalesce($4::jsonb, processing),
              attribution_enabled = coalesce($6, attribution_enabled),
              attribution_mode = coalesce($7, attribution_mode),
              attribution_show_username = coalesce($8, attribution_show_username),
              attribution_show_id = coalesce($9, attribution_show_id)
        where user_id = $1
        returning content_retention_hours, delivery_retention_days, notifications, processing,
                  attribution_enabled, attribution_mode, attribution_show_username, attribution_show_id,
                  updated_at`,
      [
        auth.user.id,
        body.contentRetentionHours ?? null,
        body.notifications ? JSON.stringify(body.notifications) : null,
        body.processing ? JSON.stringify(body.processing) : null,
        body.deliveryRetentionDays ?? null,
        body.attributionEnabled ?? null,
        body.attributionMode ?? null,
        body.attributionShowUsername ?? null,
        body.attributionShowId ?? null,
      ],
    );
    const row = updated.rows[0]!;
    await recordAudit({
      action: 'user.settings_updated',
      actorUserId: auth.user.id,
      actorRole: auth.user.role,
      targetType: 'user_settings',
      targetId: auth.user.id,
      ip: clientIp(req),
      userAgent: userAgent(req),
      metadata: { fields: Object.keys(body) },
    });
    res.json({
      settings: {
        contentRetentionHours: row.content_retention_hours,
        deliveryRetentionDays: row.delivery_retention_days,
        notifications: row.notifications,
        processing: row.processing,
        attribution: {
          enabled: row.attribution_enabled,
          mode: row.attribution_mode,
          showUsername: row.attribution_show_username,
          showId: row.attribution_show_id,
        },
        updatedAt: row.updated_at,
      },
    });
  }),
);
