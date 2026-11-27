/**
 * مسارات نتائج المعالجة والمراجعة والتصنيفات والقوالب (الخطوة 6).
 *
 * كل المسارات مقيّدة بالمالك. لا تُرجع أي قيمة تواصل خام: `message_contacts.value_raw` لا يُختار
 * في أي استعلام هنا (O03). النص الأصلي يُعاد مقنَّعاً في مواضع التواصل.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { currentAuth, requireAuth } from '../../middleware/auth.js';
import { recordAudit } from '../../lib/audit.js';
import { decodeResultsCursor, type ResultsService } from './resultsService.js';
import type { RuleConfigStore } from './ruleConfigRepository.js';

const uuidSchema = z.string().uuid({ message: 'المعرّف غير صالح.' });

const listSchema = z.object({
  review: z.enum(['none', 'needs_review', 'reviewed']).optional(),
  classificationId: z.string().uuid().optional(),
  state: z.enum(['processed', 'failed', 'matched']).optional(),
  publishState: z.enum(['not_routed', 'routed', 'awaiting_review']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // المؤشِّر هو المسار المعتمد (Q30). `offset` يبقى للتوافق مع عملاء قدامى فقط.
  cursor: z.string().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

const reviewSchema = z.object({ reviewState: z.enum(['needs_review', 'reviewed']) });

const classificationSchema = z.object({ classificationId: z.string().uuid().nullable() });

/** مخطط شرط القاعدة — مطابق لمخطط الفلاتر (نفس محرّك التقييم). */
const ruleConditionSchema = z.object({
  mode: z.enum(['all', 'any']),
  negate: z.boolean().optional(),
  minMatches: z.number().int().min(1).max(50).optional(),
  terms: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  dictionaryId: z.string().uuid().nullable().optional(),
  matchMode: z.enum(['word', 'phrase', 'contains']).optional(),
});

const classificationDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(ruleConditionSchema).min(1).max(20),
});

const classificationPatchSchema = classificationDraftSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'لا يوجد أي تغيير مطلوب.' },
);

const templatePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
    fields: z
      .array(
        z.object({
          fieldKey: z.enum([
            'request_type',
            'role',
            'subject',
            'details',
            'organization',
            'location',
            'budget',
            'deadline',
            'qualifications',
            'experience',
            'apply_method',
            'area_size',
            'specs',
            'question_count',
            'technologies',
            'contact',
          ]),
          label: z.string().trim().min(1).max(40),
          enabled: z.boolean().optional(),
        }),
      )
      .max(40)
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'لا يوجد أي تغيير مطلوب.' });

const bindingsSchema = z.object({
  sourceIds: z.array(uuidSchema).max(200).optional(),
  filterIds: z.array(uuidSchema).max(200).optional(),
  classificationIds: z.array(uuidSchema).max(200).optional(),
});

const defaultTemplateSchema = z.object({ templateId: z.string().uuid().nullable() });

export function createTelegramResultsRouter(deps: {
  results: ResultsService;
  config: RuleConfigStore;
}): Router {
  const router = Router();
  router.use(requireAuth);

  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    message: 'عدد الطلبات كبير. انتظر قليلاً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });

  // ── نتائج الرسائل والمراجعة ───────────────────────────────────────────────
  router.get(
    '/results',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const queryParams = parseBody(listSchema, req.query);
      const limit = queryParams.limit ?? 25;
      let after: { receivedAt: string; id: string } | undefined;
      if (queryParams.cursor) {
        const decoded = decodeResultsCursor(queryParams.cursor);
        if (!decoded) throw badRequest('invalid_cursor', 'مؤشِّر الصفحة غير صالح.');
        after = decoded;
      }
      const page = await deps.results.list({
        userId: auth.user.id,
        filter: {
          ...(queryParams.review ? { review: queryParams.review } : {}),
          ...(queryParams.classificationId ? { classificationId: queryParams.classificationId } : {}),
          ...(queryParams.state ? { state: queryParams.state } : {}),
          ...(queryParams.publishState ? { publishState: queryParams.publishState } : {}),
          limit,
          ...(after ? { after } : queryParams.offset !== undefined ? { offset: queryParams.offset } : {}),
        },
      });
      res.json({
        results: page.rows,
        nextCursor: page.nextCursor,
        limit,
        // `total` يُحسب في وضع offset فقط؛ المؤشِّر لا يدفع ثمن عدّ كامل.
        ...(page.total === null ? {} : { total: page.total, offset: queryParams.offset ?? 0 }),
      });
    }),
  );

  router.get(
    '/results/:identityId',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const identityId = parseBody(uuidSchema, req.params.identityId);
      const detail = await deps.results.detail({ userId: auth.user.id, identityId });
      if (!detail) throw notFound('الرسالة غير موجودة أو لا تملك صلاحية الوصول إليها.');
      res.json(detail);
    }),
  );

  router.post(
    '/results/:identityId/review',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const identityId = parseBody(uuidSchema, req.params.identityId);
      const body = parseBody(reviewSchema, req.body);
      const updated = await deps.results.setReview({
        userId: auth.user.id,
        identityId,
        reviewState: body.reviewState,
      });
      if (!updated) throw notFound('الرسالة غير موجودة أو لا تملك صلاحية الوصول إليها.');
      await recordAudit({
        action: 'processing.review_updated',
        actorUserId: auth.user.id,
        targetType: 'message_identity',
        targetId: identityId,
        outcome: 'success',
        metadata: { reviewState: body.reviewState },
      });
      res.json({ reviewState: body.reviewState });
    }),
  );

  router.post(
    '/results/:identityId/classification',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const identityId = parseBody(uuidSchema, req.params.identityId);
      const body = parseBody(classificationSchema, req.body);
      const result = await deps.results.setManualClassification({
        userId: auth.user.id,
        identityId,
        classificationId: body.classificationId,
      });
      if (!result.ok) {
        if (result.reason === 'invalid_classification') {
          throw notFound('التصنيف غير موجود أو لا تملك صلاحية الوصول إليه.');
        }
        throw notFound('الرسالة غير موجودة أو لا تملك صلاحية الوصول إليها.');
      }
      await recordAudit({
        action: 'processing.classification_overridden',
        actorUserId: auth.user.id,
        targetType: 'message_identity',
        targetId: identityId,
        outcome: 'success',
        metadata: { classificationId: body.classificationId },
      });
      res.json({ classificationId: body.classificationId });
    }),
  );

  // ── التصنيفات والقوالب ────────────────────────────────────────────────────
  router.get(
    '/classifications',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ classifications: await deps.config.listClassifications(auth.user.id) });
    }),
  );

  router.get(
    '/classifications/:classificationId',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const classificationId = parseBody(uuidSchema, req.params.classificationId);
      const ruleSet = await deps.config.getRuleSet(auth.user.id, classificationId);
      if (!ruleSet) throw notFound('التصنيف غير موجود أو لا تملك صلاحية الوصول إليه.');
      res.json({ classification: ruleSet });
    }),
  );

  router.post(
    '/classifications',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(classificationDraftSchema, req.body);
      const created = await deps.config.createRuleSet(auth.user.id, 'classification', {
        name: body.name,
        description: body.description ?? null,
        priority: body.priority ?? 100,
        enabled: body.enabled ?? true,
        appliesTo: 'any',
        scope: 'all_sources',
        conditions: body.conditions,
      });
      await recordAudit({
        action: 'classification.create',
        actorUserId: auth.user.id,
        targetType: 'rule_set',
        targetId: created.id,
        outcome: 'success',
        metadata: {},
      });
      const ruleSet = await deps.config.getRuleSet(auth.user.id, created.id);
      res.status(201).json({ classification: ruleSet });
    }),
  );

  router.patch(
    '/classifications/:classificationId',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const classificationId = parseBody(uuidSchema, req.params.classificationId);
      const body = parseBody(classificationPatchSchema, req.body);
      const updated = await deps.config.updateRuleSet(auth.user.id, 'classification', classificationId, {
        ...body,
        ...(body.description === undefined ? {} : { description: body.description }),
      });
      if (!updated) throw notFound('التصنيف غير موجود أو لا تملك صلاحية الوصول إليه.');
      await recordAudit({
        action: 'classification.update',
        actorUserId: auth.user.id,
        targetType: 'rule_set',
        targetId: classificationId,
        outcome: 'success',
        metadata: { fields: Object.keys(body) },
      });
      const ruleSet = await deps.config.getRuleSet(auth.user.id, classificationId);
      res.json({ classification: ruleSet });
    }),
  );

  router.delete(
    '/classifications/:classificationId',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const classificationId = parseBody(uuidSchema, req.params.classificationId);
      const deleted = await deps.config.deleteRuleSet(auth.user.id, 'classification', classificationId);
      if (!deleted) throw notFound('التصنيف غير موجود أو لا تملك صلاحية الوصول إليه.');
      await recordAudit({
        action: 'classification.delete',
        actorUserId: auth.user.id,
        targetType: 'rule_set',
        targetId: classificationId,
        outcome: 'success',
        metadata: {},
      });
      res.status(204).end();
    }),
  );

  router.get(
    '/templates',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json(await deps.config.listTemplates(auth.user.id));
    }),
  );

  router.post(
    '/templates/default',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(defaultTemplateSchema, req.body);
      const updated = await deps.config.setDefaultTemplate(auth.user.id, body.templateId);
      if (!updated) throw notFound('القالب غير موجود أو لا تملك صلاحية الوصول إليه.');
      res.json({ defaultTemplateId: body.templateId });
    }),
  );

  router.patch(
    '/templates/:templateId',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const templateId = parseBody(uuidSchema, req.params.templateId);
      const body = parseBody(templatePatchSchema, req.body);
      const updated = await deps.config.updateTemplate(auth.user.id, templateId, body);
      if (!updated) throw notFound('القالب غير موجود أو لا تملك صلاحية الوصول إليه.');
      res.json(await deps.config.listTemplates(auth.user.id));
    }),
  );

  router.put(
    '/templates/:templateId/bindings',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const templateId = parseBody(uuidSchema, req.params.templateId);
      const body = parseBody(bindingsSchema, req.body);
      const updated = await deps.config.setTemplateBindings(auth.user.id, templateId, body);
      if (!updated) throw notFound('القالب غير موجود أو لا تملك صلاحية الوصول إليه.');
      res.json(await deps.config.listTemplates(auth.user.id));
    }),
  );

  return router;
}
