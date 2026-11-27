/**
 * مسارات الفلاتر والقواميس (الخطوة 5-أ) — تحت /api/v1/telegram.
 * كل استجابة مقيّدة بمالك البيانات، ولا تُرجع أي نص رسالة محفوظ:
 * النص الوحيد الذي يظهر هنا هو ما يكتبه المستخدم بنفسه في «اختبار الفلتر».
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../../lib/http.js';
import { conflict, notFound } from '../../lib/errors.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { currentAuth, requireAuth } from '../../middleware/auth.js';
import type { FilterService } from './filterService.js';
import type { RuleConfigStore } from './ruleConfigRepository.js';

const uuidSchema = z.string().uuid({ message: 'المعرّف غير صالح.' });

const termSchema = z.string().trim().min(1).max(200);

const conditionSchema = z.object({
  mode: z.enum(['all', 'any']),
  negate: z.boolean().optional(),
  minMatches: z.number().int().min(1).max(50).optional(),
  terms: z.array(termSchema).max(200).optional(),
  dictionaryId: uuidSchema.nullable().optional(),
  matchMode: z.enum(['word', 'phrase', 'contains']).optional(),
});

const draftSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  scope: z.enum(['all_sources', 'bound_sources']).optional(),
  appliesTo: z.enum(['any', 'text', 'caption']).optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(conditionSchema).min(1).max(20),
});

const createSchema = draftSchema.extend({ name: z.string().trim().min(1).max(80) });

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    scope: z.enum(['all_sources', 'bound_sources']).optional(),
    appliesTo: z.enum(['any', 'text', 'caption']).optional(),
    enabled: z.boolean().optional(),
    conditions: z.array(conditionSchema).min(1).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'لا يوجد أي تغيير مطلوب.' });

const testSchema = z.object({
  text: z.string().trim().min(1).max(4096),
  caption: z.string().trim().max(1024).optional(),
});

const draftTestSchema = testSchema.extend({ definition: draftSchema });

const bindSchema = z.object({ sourceIds: z.array(uuidSchema).max(200) });

const dictionaryCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['keywords', 'synonyms', 'request_patterns', 'exclusions', 'vocabulary']),
});

const dictionaryTermsSchema = z.object({
  terms: z
    .array(
      z.object({
        term: termSchema,
        matchMode: z.enum(['word', 'phrase', 'contains']).optional(),
        loose: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(200),
});

function filterIdOf(req: Request): string {
  return parseBody(uuidSchema, req.params.filterId);
}

function classificationIdOf(req: Request): string {
  return parseBody(uuidSchema, req.params.classificationId);
}

export function createTelegramFilterRouter(deps: {
  filters: FilterService;
  store: RuleConfigStore;
}): Router {
  const router = Router();
  router.use(requireAuth);

  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    message: 'عدد الطلبات كبير. انتظر قليلاً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });
  const testLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    message: 'عدد اختبارات الفلترة كبير. انتظر قليلاً.',
    keyFrom: (req) => req.auth?.user.id ?? null,
  });

  // ── الفلاتر ───────────────────────────────────────────────────────────────
  router.get(
    '/filters',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const filters = await deps.store.listFilters(auth.user.id);
      res.json({ filters });
    }),
  );

  router.get(
    '/filters/:filterId',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const filter = await deps.store.getFilter(auth.user.id, filterIdOf(req));
      if (!filter) throw notFound('الفلتر غير موجود أو لا تملك صلاحية الوصول إليه.');
      res.json({ filter });
    }),
  );

  router.post(
    '/filters',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(createSchema, req.body);
      const created = await deps.store.createFilter(auth.user.id, {
        ...body,
        conditions: body.conditions.map((condition) => ({
          mode: condition.mode,
          negate: condition.negate,
          minMatches: condition.minMatches,
          terms: condition.terms,
          dictionaryId: condition.dictionaryId ?? null,
          matchMode: condition.matchMode,
        })),
      });
      deps.filters.invalidate(auth.user.id);
      const filter = await deps.store.getFilter(auth.user.id, created.id);
      res.status(201).json({ filter });
    }),
  );

  router.patch(
    '/filters/:filterId',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const filterId = filterIdOf(req);
      const body = parseBody(patchSchema, req.body);
      const updated = await deps.store.updateFilter(auth.user.id, filterId, {
        ...body,
        conditions: body.conditions?.map((condition) => ({
          mode: condition.mode,
          negate: condition.negate,
          minMatches: condition.minMatches,
          terms: condition.terms,
          dictionaryId: condition.dictionaryId ?? null,
          matchMode: condition.matchMode,
        })),
      });
      if (!updated) throw notFound('الفلتر غير موجود أو لا تملك صلاحية الوصول إليه.');
      deps.filters.invalidate(auth.user.id);
      const filter = await deps.store.getFilter(auth.user.id, filterId);
      res.json({ filter });
    }),
  );

  router.delete(
    '/filters/:filterId',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const deleted = await deps.store.deleteFilter(auth.user.id, filterIdOf(req));
      if (!deleted) throw notFound('الفلتر غير موجود أو لا تملك صلاحية الوصول إليه.');
      deps.filters.invalidate(auth.user.id);
      res.status(204).send();
    }),
  );

  router.put(
    '/filters/:filterId/sources',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const filterId = filterIdOf(req);
      const body = parseBody(bindSchema, req.body);
      try {
        const bound = await deps.store.bindSources(auth.user.id, filterId, body.sourceIds);
        if (!bound) throw notFound('الفلتر غير موجود أو لا تملك صلاحية الوصول إليه.');
      } catch (err) {
        // مفتاح الملكية المركّب يرفض مصدراً لمستخدم آخر.
        if ((err as { code?: string }).code === '23503') {
          throw conflict('source_not_owned', 'أحد المصادر غير موجود أو لا تملك صلاحية الوصول إليه.');
        }
        throw err;
      }
      deps.filters.invalidate(auth.user.id);
      const filter = await deps.store.getFilter(auth.user.id, filterId);
      res.json({ filter });
    }),
  );

  // ── اختبار الفلترة (§12.4) — بلا حفظ ولا آثار جانبية ─────────────────────
  router.post(
    '/filters/test',
    testLimiter,
    asyncHandler(async (req, res) => {
      const body = parseBody(draftTestSchema, req.body);
      const result = deps.filters.testDraftFilter({
        definition: { ...body.definition, name: body.definition.name ?? 'مسوّدة', conditions: body.definition.conditions },
        text: body.text,
        caption: body.caption ?? '',
      });
      res.json({ result });
    }),
  );

  router.post(
    '/filters/:filterId/test',
    testLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(testSchema, req.body);
      const result = await deps.filters.testSavedFilter({
        userId: auth.user.id,
        filterId: filterIdOf(req),
        text: body.text,
        caption: body.caption ?? '',
      });
      if (!result) throw notFound('الفلتر غير موجود أو لا تملك صلاحية الوصول إليه.');
      res.json({ result });
    }),
  );

  // اختبار تصنيف محفوظ على نص تجريبي — نفس محرّك التقييم، بلا حفظ (§12.4).
  // الغرض: يرى المدير من الواجهة أي تصنيف يطابق ومن ينافسه (سبب الغموض/hold للمراجعة).
  router.post(
    '/classifications/:classificationId/test',
    testLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(testSchema, req.body);
      const result = await deps.filters.testSavedFilter({
        userId: auth.user.id,
        filterId: classificationIdOf(req),
        text: body.text,
        caption: body.caption ?? '',
      });
      if (!result) throw notFound('التصنيف غير موجود أو لا تملك صلاحية الوصول إليه.');
      res.json({ result });
    }),
  );

  // ── القواميس ──────────────────────────────────────────────────────────────
  router.get(
    '/dictionaries',
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      res.json({ dictionaries: await deps.store.listDictionaries(auth.user.id) });
    }),
  );

  router.post(
    '/dictionaries',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const body = parseBody(dictionaryCreateSchema, req.body);
      const created = await deps.store.createDictionary(auth.user.id, body);
      deps.filters.invalidate(auth.user.id);
      res.status(201).json({ dictionary: { id: created.id } });
    }),
  );

  router.post(
    '/dictionaries/:dictionaryId/terms',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const dictionaryId = parseBody(uuidSchema, req.params.dictionaryId);
      const body = parseBody(dictionaryTermsSchema, req.body);
      const result = await deps.store.addTerms(auth.user.id, dictionaryId, body.terms);
      if (!result) throw notFound('القاموس غير موجود أو لا تملك صلاحية الوصول إليه.');
      deps.filters.invalidate(auth.user.id);
      res.status(201).json({ inserted: result.inserted });
    }),
  );

  router.delete(
    '/dictionaries/:dictionaryId/terms/:termId',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const dictionaryId = parseBody(uuidSchema, req.params.dictionaryId);
      const termId = parseBody(uuidSchema, req.params.termId);
      const deleted = await deps.store.deleteTerm(auth.user.id, dictionaryId, termId);
      if (!deleted) throw notFound('المصطلح غير موجود أو لا تملك صلاحية الوصول إليه.');
      deps.filters.invalidate(auth.user.id);
      res.status(204).send();
    }),
  );

  router.delete(
    '/dictionaries/:dictionaryId',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = currentAuth(req);
      const dictionaryId = parseBody(uuidSchema, req.params.dictionaryId);
      const deleted = await deps.store.deleteDictionary(auth.user.id, dictionaryId);
      if (!deleted) throw notFound('القاموس غير موجود أو لا تملك صلاحية الوصول إليه.');
      deps.filters.invalidate(auth.user.id);
      res.status(204).send();
    }),
  );

  return router;
}
