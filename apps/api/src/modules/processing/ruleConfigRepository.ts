/**
 * مخزن إعدادات المعالجة (الخطوة 5-أ): القواميس ومصطلحاتها، ومجموعات القواعد وشروطها وربطها بالمصادر.
 *
 * المبادئ:
 * - كل استعلام مقيّد بمالك البيانات (user_id)، والملكية مفروضة أيضاً بمفاتيح أجنبية مركّبة.
 * - أي تعديل يرقّي `user_config_state.processing_version` في **نفس المعاملة**، فيُبصم كل قرار معالجة
 *   بالإصدار الذي حُسب به (D09: مراجع ثابتة بدل نسخ نصية من القواعد).
 * - البذور تُدرج مرة واحدة لكل مستخدم (idempotent) ولا تُعدَّل بعدها تلقائياً.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { normalizeArabic } from './normalization.js';
import {
  compileRules,
  type CompiledRule,
  type ConditionMode,
  type RuleAppliesTo,
  type RuleInput,
  type RuleTerm,
  type TermMatchMode,
} from './ruleEngine.js';
import {
  SEED_CLASSIFICATIONS,
  SEED_DICTIONARIES,
  SEED_TERM_REMOVALS,
  SEED_FILTERS,
  SEED_TEMPLATE_BINDINGS,
  SEED_TEMPLATES,
  SEED_VERSION,
  type SeedFilter,
} from './seeds.js';

export type RuleScope = 'all_sources' | 'bound_sources';

export interface ConditionInput {
  mode: ConditionMode;
  negate?: boolean;
  minMatches?: number;
  /** مصطلحات حرفية. */
  terms?: string[];
  /** قاموس كامل يُضاف إلى مصطلحات الشرط. */
  dictionaryId?: string | null;
  /** تجاوز نمط مطابقة المصطلحات الحرفية. */
  matchMode?: TermMatchMode;
}

/** نوع القاعدة داخل `rule_sets` (المحرّك واحد، والتمييز بالحقل `kind`). */
export type RuleKind = 'filter' | 'classification';

export interface FilterInput {
  name: string;
  description?: string | null;
  priority?: number;
  scope?: RuleScope;
  appliesTo?: RuleAppliesTo;
  enabled?: boolean;
  conditions: ConditionInput[];
}

export interface FilterSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  priority: number;
  scope: RuleScope;
  appliesTo: RuleAppliesTo;
  /** بذرة افتراضية أم فلتر أنشأه المستخدم (Q10: البذور تُنسخ لا تُعدَّل جماعياً). */
  isBuiltin: boolean;
  version: string;
  conditionCount: number;
  termCount: number;
  sourceIds: string[];
  updatedAt: string;
}

export interface FilterDetail extends FilterSummary {
  conditions: {
    id: string;
    position: number;
    mode: ConditionMode;
    negate: boolean;
    minMatches: number;
    dictionaryId: string | null;
    terms: { id: string; display: string; literal: boolean; matchMode: TermMatchMode | null }[];
  }[];
}

export interface DictionarySummary {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  termCount: number;
  terms?: { id: string; term: string; matchMode: TermMatchMode; loose: boolean; enabled: boolean }[];
}

export interface ClassificationSummary {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  enabled: boolean;
  isBuiltin: boolean;
  conditionCount: number;
  version: string;
}

export interface TemplateDetail {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  enabled: boolean;
  isDefault: boolean;
  fields: TemplateFieldConfig[];
  bindings: { sourceIds: string[]; filterIds: string[]; classificationIds: string[] };
}

export interface TemplateFieldConfig {
  fieldKey: string;
  label: string;
  position: number;
  enabled: boolean;
}

export interface TemplateConfig {
  id: string;
  name: string;
  isBuiltin: boolean;
  enabled: boolean;
  fields: TemplateFieldConfig[];
}

/** خرائط الربط: هدف (مصدر/فلتر/تصنيف) ⇒ معرّف القالب. */
export interface TemplateBindingMaps {
  source: Record<string, string>;
  filter: Record<string, string>;
  classification: Record<string, string>;
}

export interface ConfigSnapshot {
  version: string;
  /** الفلاتر المصرَّفة (kind='filter'). */
  rules: CompiledRule[];
  /** التصنيفات المصرَّفة (kind='classification'). */
  classifications: CompiledRule[];
  /** هل توجد مصطلحات تطالب بنسخة النص الواسعة؟ (لتجنّب حسابها بلا داعٍ) */
  hasLooseTerms: boolean;
  filterCount: number;
  classificationCount: number;
  templates: TemplateConfig[];
  templateBindings: TemplateBindingMaps;
  defaultTemplateId: string | null;
}

export interface RuleConfigStore {
  ensureReady(userId: string): Promise<void>;
  /** قراءة رخيصة لإصدار الإعدادات (استعلام واحد) لمعرفة هل تغيّرت اللقطة المخبّأة. */
  currentVersion(userId: string): Promise<string>;
  loadSnapshot(userId: string): Promise<ConfigSnapshot>;
  listFilters(userId: string): Promise<FilterSummary[]>;
  getFilter(userId: string, filterId: string): Promise<FilterDetail | null>;
  createFilter(userId: string, input: FilterInput): Promise<{ id: string }>;
  updateFilter(userId: string, filterId: string, patch: Partial<FilterInput>): Promise<boolean>;
  deleteFilter(userId: string, filterId: string): Promise<boolean>;
  bindSources(userId: string, filterId: string, sourceIds: string[]): Promise<boolean>;
  listDictionaries(userId: string): Promise<DictionarySummary[]>;
  createDictionary(
    userId: string,
    input: { name: string; kind: DictionarySummary['kind'] },
  ): Promise<{ id: string }>;
  addTerms(
    userId: string,
    dictionaryId: string,
    terms: { term: string; matchMode?: TermMatchMode; loose?: boolean }[],
  ): Promise<{ inserted: number } | null>;
  deleteTerm(userId: string, dictionaryId: string, termId: string): Promise<boolean>;
  deleteDictionary(userId: string, dictionaryId: string): Promise<boolean>;
  /** التصنيفات كملخّصات (للقراءة في الواجهة). */
  listClassifications(userId: string): Promise<ClassificationSummary[]>;
  /** قراءة قاعدة (فلتر أو تصنيف) بشروطها — للتحرير في الواجهة. */
  getRuleSet(userId: string, ruleSetId: string): Promise<FilterDetail | null>;
  /** إنشاء/تعديل/حذف قاعدة بأي نوع ('filter' | 'classification') مع عزل المستخدم. */
  createRuleSet(userId: string, kind: RuleKind, input: FilterInput): Promise<{ id: string }>;
  updateRuleSet(
    userId: string,
    kind: RuleKind,
    ruleSetId: string,
    patch: Partial<FilterInput>,
  ): Promise<boolean>;
  deleteRuleSet(userId: string, kind: RuleKind, ruleSetId: string): Promise<boolean>;
  /** القوالب مع حقولها وربطها والقالب الافتراضي. */
  listTemplates(userId: string): Promise<{
    templates: TemplateDetail[];
    defaultTemplateId: string | null;
  }>;
  /** يحدّث اسم/تفعيل القالب وحقوله (استبدال كامل للحقول عند تمريرها). */
  updateTemplate(
    userId: string,
    templateId: string,
    patch: {
      name?: string;
      enabled?: boolean;
      fields?: { fieldKey: string; label: string; enabled?: boolean }[];
    },
  ): Promise<boolean>;
  /** يضبط ربط القالب (مصادر/فلاتر/تصنيفات) — استبدال كامل لربط هذا القالب. */
  setTemplateBindings(
    userId: string,
    templateId: string,
    input: { sourceIds?: string[]; filterIds?: string[]; classificationIds?: string[] },
  ): Promise<boolean>;
  /** يضبط القالب الافتراضي للمستخدم (null = لا افتراضي). */
  setDefaultTemplate(userId: string, templateId: string | null): Promise<boolean>;
}

interface RuleRow {
  id: string;
  name: string;
  priority: number;
  scope: RuleScope;
  applies_to: RuleAppliesTo;
  dictionary_id: string | null;
  version: string;
}

interface ConditionRow {
  id: string;
  rule_set_id: string;
  position: number;
  mode: ConditionMode;
  negate: boolean;
  min_matches: number;
  dictionary_id: string | null;
}

interface ConditionTermRow {
  condition_id: string;
  literal: string | null;
  literal_normalized: string | null;
  match_mode: TermMatchMode | null;
  dict_term_id: string | null;
  dict_term: string | null;
  dict_normalized: string | null;
  dict_mode: TermMatchMode | null;
  dict_loose: boolean | null;
  dict_dictionary_id: string | null;
}

interface DictionaryTermRow {
  id: string;
  dictionary_id: string;
  term: string;
  term_normalized: string;
  match_mode: TermMatchMode;
  loose: boolean;
}

/** يبني مصطلحات الشرط من صفوفه + توسيع القواميس (قاموس الشرط + القاموس الافتراضي للمجموعة). */
function expandTerms(
  condition: ConditionRow,
  rows: ConditionTermRow[],
  dictionaryTerms: Map<string, DictionaryTermRow[]>,
  ruleDefaultDictionary: string | null,
): RuleTerm[] {
  const terms: RuleTerm[] = [];
  const seen = new Set<string>();

  const push = (term: RuleTerm) => {
    const key = `${term.normalized}|${term.mode}|${term.loose ? 1 : 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  };

  for (const row of rows) {
    if (row.dict_term && row.dict_normalized) {
      push({
        display: row.dict_term,
        normalized: row.dict_normalized,
        mode: row.match_mode ?? row.dict_mode ?? 'word',
        loose: Boolean(row.dict_loose),
      });
    } else if (row.literal && row.literal_normalized) {
      push({
        display: row.literal,
        normalized: row.literal_normalized,
        mode: row.match_mode ?? 'word',
        loose: false,
      });
    }
  }

  // توسيع القواميس: قاموس الشرط ثم القاموس الافتراضي للمجموعة إن اختلف.
  const dictionaries = new Set<string>();
  if (condition.dictionary_id) dictionaries.add(condition.dictionary_id);
  if (ruleDefaultDictionary) dictionaries.add(ruleDefaultDictionary);
  for (const dictionaryId of dictionaries) {
    for (const term of dictionaryTerms.get(dictionaryId) ?? []) {
      push({
        display: term.term,
        normalized: term.term_normalized,
        mode: term.match_mode,
        loose: term.loose,
      });
    }
  }

  return terms;
}

/** بناء لقطة التقييم من صفوف القاعدة (دالة نقية، قابلة للاختبار). */
export function buildRules(
  ruleRows: RuleRow[],
  conditionRows: ConditionRow[],
  termRows: ConditionTermRow[],
  dictionaryTerms: Map<string, DictionaryTermRow[]>,
  bindings: Map<string, string[]>,
  kind: 'filter' | 'classification' = 'filter',
): RuleInput[] {
  const conditionsByRule = new Map<string, ConditionRow[]>();
  for (const condition of conditionRows) {
    const list = conditionsByRule.get(condition.rule_set_id) ?? [];
    list.push(condition);
    conditionsByRule.set(condition.rule_set_id, list);
  }
  const termsByCondition = new Map<string, ConditionTermRow[]>();
  for (const term of termRows) {
    const list = termsByCondition.get(term.condition_id) ?? [];
    list.push(term);
    termsByCondition.set(term.condition_id, list);
  }

  return ruleRows.map((rule) => ({
    id: rule.id,
    name: rule.name,
    kind,
    priority: rule.priority,
    appliesTo: rule.applies_to,
    sourceIds: rule.scope === 'all_sources' ? null : (bindings.get(rule.id) ?? []),
    version: Number(rule.version),
    conditions: (conditionsByRule.get(rule.id) ?? [])
      .sort((a, b) => a.position - b.position)
      .map((condition) => ({
        id: condition.id,
        mode: condition.mode,
        negate: condition.negate,
        minMatches: condition.min_matches,
        terms: expandTerms(
          condition,
          termsByCondition.get(condition.id) ?? [],
          dictionaryTerms,
          rule.dictionary_id,
        ),
      })),
  }));
}

/**
 * تطبيع مصطلحات البذور يُحسب **مرة واحدة** لكل عملية (لا لكل مستخدم).
 * المعجم الموسّع يضم أكثر من ألف مصطلح؛ تطبيعها عند بذر كل مستخدم كان يستهلك CPU بلا داعٍ
 * (تأخير ملموس في أول استخدام وفي الاختبارات التي تنشئ مستخدمين كثيرين).
 */
let seedTermCache: Map<string, { term: string; normalized: string; mode: string; loose: boolean }[]> | null = null;

function normalizedSeedTerms(dictionaryName: string, terms: { term: string; mode?: TermMatchMode; loose?: boolean }[]) {
  // المفتاح اسم القاموس: محتواه ثابت في هذه النسخة من البذور.
  if (!seedTermCache) seedTermCache = new Map();
  const cached = seedTermCache.get(dictionaryName);
  if (cached) return cached;
  const rows = terms.map((term) => ({
    term: term.term,
    normalized: normalizeArabic(term.term, term.loose ? { foldTaMarbuta: true } : {}),
    mode: term.mode ?? 'word',
    loose: Boolean(term.loose),
  }));
  seedTermCache.set(dictionaryName, rows);
  return rows;
}

export class PgRuleConfigRepository implements RuleConfigStore {
  /** ينشئ صف حالة الإعدادات ويبذر القيم الافتراضية عند أول استخدام. */
  async ensureReady(userId: string): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        'insert into user_config_state (user_id) values ($1) on conflict (user_id) do nothing',
        [userId],
      );
      const state = await client.query<{ seeded_at: Date | null; seed_version: number }>(
        'select seeded_at, seed_version from user_config_state where user_id = $1 for update',
        [userId],
      );
      const row = state.rows[0];
      if (!row?.seeded_at) {
        await this.seedDefaultsInTx(client, userId);
        return;
      }
      // مستخدم قديم: إن تغيّر محتوى البذور (بصمة مختلفة)، تُضاف المصطلحات/القوالب الناقصة فقط.
      if ((row.seed_version ?? 0) !== SEED_VERSION) {
        await this.refreshSeedsInTx(client, userId);
      }
    });
  }

  /**
   * البذور الأولى: قواميس ثم قواعد ثم قوالب ثم روابط — idempotent بالكامل.
   * (بعدها تُستخدم `refreshSeedsInTx` للتوسعات اللاحقة.)
   */
  private async seedDefaultsInTx(client: PoolClient, userId: string): Promise<void> {
    const dictionaryIds = await this.ensureDictionariesInTx(client, userId);
    await this.ensureRuleSetsInTx(client, userId, 'filter', SEED_FILTERS, dictionaryIds);
    await this.ensureRuleSetsInTx(client, userId, 'classification', SEED_CLASSIFICATIONS, dictionaryIds);
    await this.ensureGenericClassificationGuardInTx(client, userId, dictionaryIds);
    const templateIds = await this.ensureTemplatesInTx(client, userId);
    await this.ensureTemplateBindingsInTx(client, userId, templateIds);

    // القالب الأعمّ هو الافتراضي عند أول بذر.
    const defaultTemplateId = templateIds.get('الخدمات والطلبات العامة') ?? null;
    if (defaultTemplateId) {
      await client.query(
        'update user_config_state set default_template_id = coalesce(default_template_id, $2) where user_id = $1',
        [userId, defaultTemplateId],
      );
    }

    await client.query(
      `update user_config_state
          set seeded_at = now(), seed_version = $2,
              processing_version = processing_version + 1, updated_at = now()
        where user_id = $1`,
      [userId, SEED_VERSION],
    );
  }

  /**
   * ترقية بذور مستخدم قائم إلى `SEED_VERSION` الحالية — **إضافة ناقصة فقط**:
   * مصطلحات وقواميس وقوالب وروابط غير موجودة، دون حذف شرط أو تعديل قاعدة عدّلها المستخدم.
   *
   * الاستثناء الوحيد المقصود: إزالة مصطلحات استبعاد أثبتت التجربة أنها تُسقط طلبات مشروعة
   * (`SEED_EXCLUSION_REMOVALS`)، وهي مصطلحات بذرها النظام نفسه لا المستخدم.
   */
  private async refreshSeedsInTx(client: PoolClient, userId: string): Promise<void> {
    const dictionaryIds = await this.ensureDictionariesInTx(client, userId);

    // تصحيحات معجمية: إزالة مصطلحات بذرها نظام سابق وكانت تضرّ الدقة (بمطابقة تامة فقط).
    for (const removal of SEED_TERM_REMOVALS) {
      const dictionaryId = dictionaryIds.get(removal.dictionary);
      if (!dictionaryId) continue;
      const normalized = [...new Set(
        removal.terms.flatMap((term) => [normalizeArabic(term), normalizeArabic(term, { foldTaMarbuta: true })]),
      )];
      if (normalized.length === 0) continue;
      await client.query(
        'delete from dictionary_terms where user_id = $1 and dictionary_id = $2 and term_normalized = any($3::text[])',
        [userId, dictionaryId, normalized],
      );
    }

    await this.ensureRuleSetsInTx(client, userId, 'filter', SEED_FILTERS, dictionaryIds);
    await this.ensureRuleSetsInTx(client, userId, 'classification', SEED_CLASSIFICATIONS, dictionaryIds);
    // القواعد المدمجة التي لم يعدّلها المستخدم تُرقّى إلى تعريف البذور الحالي.
    await this.upgradeBuiltinRulesInTx(client, userId, 'filter', SEED_FILTERS, dictionaryIds);
    await this.upgradeBuiltinRulesInTx(client, userId, 'classification', SEED_CLASSIFICATIONS, dictionaryIds);
    await this.ensureGenericClassificationGuardInTx(client, userId, dictionaryIds);
    const templateIds = await this.ensureTemplatesInTx(client, userId);
    await this.ensureTemplateBindingsInTx(client, userId, templateIds);

    await client.query(
      `update user_config_state
          set seed_version = $2, processing_version = processing_version + 1, updated_at = now()
        where user_id = $1`,
      [userId, SEED_VERSION],
    );
  }

  /** ينشئ القواميس الناقصة ويضيف المصطلحات الناقصة (لا يحذف شيئاً). */
  private async ensureDictionariesInTx(client: PoolClient, userId: string): Promise<Map<string, string>> {
    const dictionaryIds = new Map<string, string>();
    for (const dictionary of SEED_DICTIONARIES) {
      const inserted = await client.query<{ id: string }>(
        `insert into dictionaries (user_id, name, kind) values ($1, $2, $3)
         on conflict (user_id, name) do nothing returning id`,
        [userId, dictionary.name, dictionary.kind],
      );
      let dictionaryId = inserted.rows[0]?.id;
      if (!dictionaryId) {
        const existing = await client.query<{ id: string }>(
          'select id from dictionaries where user_id = $1 and name = $2',
          [userId, dictionary.name],
        );
        dictionaryId = existing.rows[0]?.id;
      }
      if (!dictionaryId) continue;
      dictionaryIds.set(dictionary.name, dictionaryId);
      // إدراج مجمّع لكل قاموس: المعجم الموسّع يضم أكثر من ألف مصطلح، والإدراج سطراً سطراً
      // كان يجعل التهيئة الأولى (وكل مستخدم اختبار) بطيئة بشكل ملموس.
      if (dictionary.terms.length === 0) continue;
      const rows = normalizedSeedTerms(dictionary.name, dictionary.terms);
      await client.query(
        `insert into dictionary_terms (user_id, dictionary_id, term, term_normalized, match_mode, loose)
         select $1, $2, t.term, t.normalized, t.mode::term_match_mode, t.loose
           from unnest($3::text[], $4::text[], $5::text[], $6::boolean[]) as t(term, normalized, mode, loose)
         on conflict (dictionary_id, term_normalized) do nothing`,
        [
          userId,
          dictionaryId,
          rows.map((row) => row.term),
          rows.map((row) => row.normalized),
          rows.map((row) => row.mode),
          rows.map((row) => row.loose),
        ],
      );
    }
    return dictionaryIds;
  }

  /**
   * يضيف إلى التصنيف العام «طلبات عامة» شرطاً منفيّاً بقاموس النطاقات المتخصصة إن لم يكن موجوداً.
   *
   * العلة: بلا هذا الشرط يُطابق التصنيف العام كل طلب فيه صيغة طلب («مطلوب شقة») فينافس التصنيف
   * المتخصص ⇒ `ambiguous=true` ⇒ تُحجز الرسالة للمراجعة بلا سبب. الشرط يجعله **احتياطاً فعلياً**.
   * الترقية محصورة بهذا التصنيف وبهذا القاموس، وidempotent، ولا تمسّ أي شرط أدخله المستخدم.
   */
  private async ensureGenericClassificationGuardInTx(
    client: PoolClient,
    userId: string,
    dictionaryIds: Map<string, string>,
  ): Promise<void> {
    const dictionaryId = dictionaryIds.get('مفردات النطاقات المتخصصة');
    if (!dictionaryId) return;
    const rule = await client.query<{ id: string }>(
      `select id from rule_sets where user_id = $1 and kind = 'classification' and name = 'طلبات عامة'`,
      [userId],
    );
    const ruleId = rule.rows[0]?.id;
    if (!ruleId) return;
    const existing = await client.query(
      'select 1 from rule_conditions where rule_set_id = $1 and negate and dictionary_id = $2',
      [ruleId, dictionaryId],
    );
    if (existing.rowCount && existing.rowCount > 0) return;
    const next = await client.query<{ position: number }>(
      'select coalesce(max(position), 0) + 1 as position from rule_conditions where rule_set_id = $1',
      [ruleId],
    );
    await client.query(
      `insert into rule_conditions (user_id, rule_set_id, position, mode, negate, min_matches, dictionary_id)
       values ($1, $2, $3, 'any', true, 1, $4)`,
      [userId, ruleId, next.rows[0]!.position, dictionaryId],
    );
  }

  /** ينشئ مجموعات القواعد الناقصة بشرطها كاملة؛ الموجودة تُترك كما هي (تعديلات المستخدم محفوظة). */
  private async ensureRuleSetsInTx(
    client: PoolClient,
    userId: string,
    kind: 'filter' | 'classification',
    group: SeedFilter[],
    dictionaryIds: Map<string, string>,
  ): Promise<void> {
    for (const rule of group) {
      const inserted = await client.query<{ id: string }>(
        `insert into rule_sets (user_id, kind, name, description, priority, scope, applies_to, is_builtin)
         values ($1, $2::rule_kind, $3, $4, $5, 'all_sources', 'any', true)
         on conflict (user_id, kind, name) do nothing returning id`,
        [userId, kind, rule.name, rule.description, rule.priority],
      );
      const ruleId = inserted.rows[0]?.id;
      if (!ruleId) continue; // موجودة سابقاً: لا نعيد إدخال شروطها ولا نُبطل تعديلاتها
      await this.insertConditionsInTx(client, userId, ruleId, rule, dictionaryIds);
    }
  }

  /**
   * يُرقّي شروط القاعدة المدمجة إلى تعريف البذور الحالي **فقط** إذا لم يعدّلها المستخدم
   * (`version = 1` و`is_builtin`). أي تعديل من الواجهة/الـAPI يرقّي الإصدار فيُستثنى تلقائياً.
   *
   * سبب الحاجة: توسيع القاموس لا يُصلح شروطاً حرفية قديمة؛ «بحث» في شرط حرفي لا تلتقط «بحوث»،
   * فتبقى الرسالة غير مطابقة رغم أن القاموس غني. الترقية تجعل التعريف الحرفي قائماً على القواميس.
   */
  private async upgradeBuiltinRulesInTx(
    client: PoolClient,
    userId: string,
    kind: 'filter' | 'classification',
    group: SeedFilter[],
    dictionaryIds: Map<string, string>,
  ): Promise<void> {
    for (const rule of group) {
      const found = await client.query<{ id: string; version: number }>(
        `select id, version from rule_sets
          where user_id = $1 and kind = $2::rule_kind and name = $3 and is_builtin`,
        [userId, kind, rule.name],
      );
      const row = found.rows[0];
      if (!row || row.version > 1) continue; // معدَّلة من المستخدم أو غير مدمجة: لا تُمسّ
      // لا نعتمد على عدد الشروط (تعريفان مختلفان قد يتساويان عدداً) — إعادة البناء هي المرجع.
      // إعادة بناء الشروط من التعريف (condition_terms تُحذف تلقائياً بمفتاح أجنبي متسلسل).
      await client.query('delete from rule_conditions where rule_set_id = $1', [row.id]);
      await this.insertConditionsInTx(client, userId, row.id, rule, dictionaryIds);
    }
  }

  /** إدراج شروط قاعدة من تعريف بذرة (مشترك بين البذر والترقية). */
  private async insertConditionsInTx(
    client: PoolClient,
    userId: string,
    ruleId: string,
    rule: SeedFilter,
    dictionaryIds: Map<string, string>,
  ): Promise<void> {
    let position = 0;
    for (const condition of rule.conditions) {
      position += 1;
      const conditionRow = await client.query<{ id: string }>(
        `insert into rule_conditions (user_id, rule_set_id, position, mode, negate, min_matches, dictionary_id)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          userId,
          ruleId,
          position,
          condition.mode,
          Boolean(condition.negate),
          condition.minMatches ?? 1,
          condition.dictionary ? (dictionaryIds.get(condition.dictionary) ?? null) : null,
        ],
      );
      const conditionId = conditionRow.rows[0]!.id;
      for (const term of condition.terms ?? []) {
        const normalized = normalizeArabic(term.term, term.loose ? { foldTaMarbuta: true } : {});
        await client.query(
          `insert into condition_terms (user_id, condition_id, literal, literal_normalized, match_mode)
           values ($1, $2, $3, $4, $5)
           on conflict do nothing`,
          [userId, conditionId, term.term, normalized, term.mode ?? null],
        );
      }
    }
  }

  /** ينشئ القوالب الناقصة وحقولها؛ الموجود يُترك كما هو. */
  private async ensureTemplatesInTx(client: PoolClient, userId: string): Promise<Map<string, string>> {
    const templateIds = new Map<string, string>();
    for (const template of SEED_TEMPLATES) {
      const inserted = await client.query<{ id: string }>(
        `insert into templates (user_id, name, description, is_builtin)
         values ($1, $2, $3, true)
         on conflict (user_id, name) do nothing returning id`,
        [userId, template.name, template.description],
      );
      let templateId = inserted.rows[0]?.id;
      if (!templateId) {
        const existing = await client.query<{ id: string }>(
          'select id from templates where user_id = $1 and name = $2',
          [userId, template.name],
        );
        templateId = existing.rows[0]?.id;
      }
      if (!templateId) continue;
      templateIds.set(template.name, templateId);
      let position = 0;
      for (const field of template.fields) {
        await client.query(
          `insert into template_fields (user_id, template_id, position, field_key, label)
           values ($1, $2, $3, $4, $5)
           on conflict (template_id, position) do nothing`,
          [userId, templateId, position, field.key, field.label],
        );
        position += 1;
      }
    }
    return templateIds;
  }

  /** يربط القوالب بتصنيفاتها إن لم يكن للتصنيف رابط بعد (ربط المستخدم القائم لا يُستبدل). */
  private async ensureTemplateBindingsInTx(
    client: PoolClient,
    userId: string,
    templateIds: Map<string, string>,
  ): Promise<void> {
    for (const binding of SEED_TEMPLATE_BINDINGS) {
      const templateId = templateIds.get(binding.templateName);
      if (!templateId) continue;
      const rule = await client.query<{ id: string }>(
        `select id from rule_sets where user_id = $1 and kind = 'classification' and name = $2`,
        [userId, binding.ruleName],
      );
      const ruleId = rule.rows[0]?.id;
      if (!ruleId) continue;
      const existing = await client.query(
        'select 1 from template_bindings where user_id = $1 and rule_set_id = $2 and scope <> \'source\'',
        [userId, ruleId],
      );
      if (existing.rowCount && existing.rowCount > 0) continue;
      await client.query(
        `insert into template_bindings (user_id, template_id, scope, rule_set_id)
         values ($1, $2, 'classification', $3)
         on conflict do nothing`,
        [userId, templateId, ruleId],
      );
    }
  }

  async currentVersion(userId: string): Promise<string> {
    const res = await query<{ version: string }>(
      'select coalesce(processing_version, 0)::text as version from user_config_state where user_id = $1',
      [userId],
    );
    return res.rows[0]?.version ?? '0';
  }

  async loadSnapshot(userId: string): Promise<ConfigSnapshot> {
    await this.ensureReady(userId);

    const [
      state,
      ruleRows,
      conditionRows,
      terms,
      dictionaryTerms,
      bindings,
      templateRows,
      templateFieldRows,
      templateBindingRows,
    ] = await Promise.all([
      query<{ processing_version: string; default_template_id: string | null }>(
        `select processing_version::text as processing_version, default_template_id
           from user_config_state where user_id = $1`,
        [userId],
      ),
      query<RuleRow & { kind: 'filter' | 'classification' }>(
        `select id, name, kind, priority, scope, applies_to, dictionary_id, version::text as version
           from rule_sets
          where user_id = $1 and kind in ('filter', 'classification') and enabled
          order by priority, name, id`,
        [userId],
      ),
      query<ConditionRow & { kind: 'filter' | 'classification' }>(
        `select c.id, c.rule_set_id, c.position, c.mode, c.negate, c.min_matches, c.dictionary_id,
                s.kind
           from rule_conditions c
           join rule_sets s on s.id = c.rule_set_id
          where c.user_id = $1 and s.enabled and s.kind in ('filter', 'classification')
          order by c.rule_set_id, c.position`,
        [userId],
      ),
      query<ConditionTermRow>(
        `select ct.condition_id, ct.literal, ct.literal_normalized, ct.match_mode,
                dt.id as dict_term_id, dt.term as dict_term, dt.term_normalized as dict_normalized,
                dt.match_mode as dict_mode, dt.loose as dict_loose, dt.dictionary_id as dict_dictionary_id
           from condition_terms ct
           left join dictionary_terms dt
             on dt.id = ct.dictionary_term_id and dt.enabled
          where ct.user_id = $1`,
        [userId],
      ),
      query<DictionaryTermRow>(
        `select id, dictionary_id, term, term_normalized, match_mode, loose
           from dictionary_terms where user_id = $1 and enabled`,
        [userId],
      ),
      query<{ filter_id: string; source_id: string }>(
        `select filter_id, source_id from filter_source_bindings where user_id = $1 and enabled`,
        [userId],
      ),
      query<{ id: string; name: string; is_builtin: boolean; enabled: boolean }>(
        `select id, name, is_builtin, enabled from templates
          where user_id = $1 and enabled order by name, id`,
        [userId],
      ),
      query<{ template_id: string; field_key: string; label: string; position: number; enabled: boolean }>(
        `select template_id, field_key, label, position, enabled from template_fields
          where user_id = $1 order by template_id, position`,
        [userId],
      ),
      query<{ template_id: string; scope: 'source' | 'filter' | 'classification'; source_id: string | null; rule_set_id: string | null }>(
        `select template_id, scope, source_id::text as source_id, rule_set_id::text as rule_set_id
           from template_bindings where user_id = $1`,
        [userId],
      ),
    ]);

    const byDictionary = new Map<string, DictionaryTermRow[]>();
    for (const term of dictionaryTerms.rows) {
      const list = byDictionary.get(term.dictionary_id) ?? [];
      list.push(term);
      byDictionary.set(term.dictionary_id, list);
    }
    const bindingMap = new Map<string, string[]>();
    for (const binding of bindings.rows) {
      const list = bindingMap.get(binding.filter_id) ?? [];
      list.push(binding.source_id);
      bindingMap.set(binding.filter_id, list);
    }

    const filterRuleRows = ruleRows.rows.filter((row) => row.kind === 'filter');
    const classificationRows = ruleRows.rows.filter((row) => row.kind === 'classification');
    const filterConditionRows = conditionRows.rows.filter((row) => row.kind === 'filter');
    const classificationConditionRows = conditionRows.rows.filter((row) => row.kind === 'classification');

    const ruleInputs = buildRules(filterRuleRows, filterConditionRows, terms.rows, byDictionary, bindingMap);
    const classificationInputs = buildRules(
      classificationRows,
      classificationConditionRows,
      terms.rows,
      byDictionary,
      new Map<string, string[]>(),
      'classification',
    );
    const hasLooseTerms = [...ruleInputs, ...classificationInputs].some((rule) =>
      rule.conditions.some((condition) => condition.terms.some((term) => term.loose)),
    );

    const fieldsByTemplate = new Map<string, TemplateFieldConfig[]>();
    for (const field of templateFieldRows.rows) {
      const list = fieldsByTemplate.get(field.template_id) ?? [];
      list.push({
        fieldKey: field.field_key,
        label: field.label,
        position: field.position,
        enabled: field.enabled,
      });
      fieldsByTemplate.set(field.template_id, list);
    }
    const templates: TemplateConfig[] = templateRows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      isBuiltin: row.is_builtin,
      enabled: row.enabled,
      fields: (fieldsByTemplate.get(row.id) ?? []).sort((a, b) => a.position - b.position),
    }));

    const templateBindings: TemplateBindingMaps = { source: {}, filter: {}, classification: {} };
    for (const binding of templateBindingRows.rows) {
      if (binding.scope === 'source' && binding.source_id) {
        templateBindings.source[binding.source_id] = binding.template_id;
      } else if (binding.scope === 'filter' && binding.rule_set_id) {
        templateBindings.filter[binding.rule_set_id] = binding.template_id;
      } else if (binding.scope === 'classification' && binding.rule_set_id) {
        templateBindings.classification[binding.rule_set_id] = binding.template_id;
      }
    }

    return {
      version: state.rows[0]?.processing_version ?? '0',
      rules: compileRules(ruleInputs),
      classifications: compileRules(classificationInputs),
      hasLooseTerms,
      filterCount: ruleInputs.length,
      classificationCount: classificationInputs.length,
      templates,
      templateBindings,
      defaultTemplateId: state.rows[0]?.default_template_id ?? null,
    };
  }

  // ── الفلاتر ────────────────────────────────────────────────────────────────
  async listFilters(userId: string): Promise<FilterSummary[]> {
    await this.ensureReady(userId);
    const res = await query<{
      id: string;
      name: string;
      description: string | null;
      enabled: boolean;
      priority: number;
      scope: RuleScope;
      applies_to: RuleAppliesTo;
      is_builtin: boolean;
      version: string;
      condition_count: number;
      term_count: number;
      source_ids: string[];
      updated_at: Date;
    }>(
      `select s.id, s.name, s.description, s.enabled, s.priority, s.scope, s.applies_to, s.is_builtin,
              s.version::text as version,
              (select count(*)::int from rule_conditions c where c.rule_set_id = s.id) as condition_count,
              (select count(*)::int from rule_conditions c
                 join condition_terms t on t.condition_id = c.id
                where c.rule_set_id = s.id) as term_count,
              coalesce((select array_agg(b.source_id::text) from filter_source_bindings b
                         where b.filter_id = s.id and b.enabled), '{}') as source_ids,
              s.updated_at
         from rule_sets s
        where s.user_id = $1 and s.kind = 'filter'
        order by s.priority, s.name, s.id`,
      [userId],
    );
    return res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      priority: row.priority,
      scope: row.scope,
      appliesTo: row.applies_to,
      isBuiltin: row.is_builtin,
      version: row.version,
      conditionCount: row.condition_count,
      termCount: row.term_count,
      sourceIds: row.source_ids,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async getFilter(userId: string, filterId: string): Promise<FilterDetail | null> {
    await this.ensureReady(userId);
    const summaries = await this.listFilters(userId);
    const summary = summaries.find((item) => item.id === filterId);
    if (!summary) return null;
    const conditions = await query<ConditionRow>(
      `select id, rule_set_id, position, mode, negate, min_matches, dictionary_id
         from rule_conditions where user_id = $1 and rule_set_id = $2 order by position`,
      [userId, filterId],
    );
    const terms = await query<{
      id: string;
      condition_id: string;
      literal: string | null;
      match_mode: TermMatchMode | null;
      dict_term: string | null;
    }>(
      `select ct.id, ct.condition_id, ct.literal, ct.match_mode, dt.term as dict_term
         from condition_terms ct
         left join dictionary_terms dt on dt.id = ct.dictionary_term_id
        where ct.user_id = $1 and ct.condition_id = any($2::uuid[])`,
      [userId, conditions.rows.map((row) => row.id)],
    );
    return {
      ...summary,
      conditions: conditions.rows.map((condition) => ({
        id: condition.id,
        position: condition.position,
        mode: condition.mode,
        negate: condition.negate,
        minMatches: condition.min_matches,
        dictionaryId: condition.dictionary_id,
        terms: terms.rows
          .filter((term) => term.condition_id === condition.id)
          .map((term) => ({
            id: term.id,
            display: term.dict_term ?? term.literal ?? '',
            literal: term.dict_term === null,
            matchMode: term.match_mode,
          })),
      })),
    };
  }

  async createFilter(userId: string, input: FilterInput): Promise<{ id: string }> {
    return this.createRuleSet(userId, 'filter', input);
  }

  /**
   * إنشاء قاعدة بأي نوع. الفلاتر والتصنيفات تشترك في نفس الجداول والمحرّك،
   * فالتعميم هنا يمنع ازدواج المنطق (وبالتالي ازدواج الأخطاء).
   */
  async createRuleSet(userId: string, kind: RuleKind, input: FilterInput): Promise<{ id: string }> {
    await this.ensureReady(userId);
    return withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into rule_sets (user_id, kind, name, description, priority, scope, applies_to, enabled, is_builtin)
         values ($1, $2::rule_kind, $3, $4, $5, $6, $7, $8, false) returning id`,
        [
          userId,
          kind,
          input.name,
          input.description ?? null,
          input.priority ?? 100,
          input.scope ?? 'all_sources',
          input.appliesTo ?? 'any',
          input.enabled ?? true,
        ],
      );
      const ruleSetId = inserted.rows[0]!.id;
      await this.writeConditions(client, userId, ruleSetId, input.conditions ?? []);
      await this.bumpVersion(client, userId);
      return { id: ruleSetId };
    });
  }

  async updateFilter(userId: string, filterId: string, patch: Partial<FilterInput>): Promise<boolean> {
    return this.updateRuleSet(userId, 'filter', filterId, patch);
  }

  /** تعديل قاعدة بأي نوع؛ `kind` شرط عزل إضافي فلا يمكن تعديل تصنيف عبر مسار الفلاتر. */
  async updateRuleSet(
    userId: string,
    kind: RuleKind,
    ruleSetId: string,
    patch: Partial<FilterInput>,
  ): Promise<boolean> {
    return withTransaction(async (client) => {
      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (column: string, value: unknown) => {
        values.push(value);
        fields.push(`${column} = $${values.length}`);
      };
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.description !== undefined) set('description', patch.description);
      if (patch.priority !== undefined) set('priority', patch.priority);
      if (patch.scope !== undefined) set('scope', patch.scope);
      if (patch.appliesTo !== undefined) set('applies_to', patch.appliesTo);
      if (patch.enabled !== undefined) set('enabled', patch.enabled);
      if (fields.length > 0) {
        values.push(userId, ruleSetId, kind);
        const res = await client.query(
          `update rule_sets set ${fields.join(', ')}, version = version + 1
            where user_id = $${values.length - 2} and id = $${values.length - 1} and kind = $${values.length}::rule_kind`,
          values,
        );
        if (res.rowCount === 0) return false;
      } else {
        const exists = await client.query(
          'select 1 from rule_sets where user_id = $1 and id = $2 and kind = $3::rule_kind',
          [userId, ruleSetId, kind],
        );
        if (exists.rowCount === 0) return false;
      }
      if (patch.conditions) {
        await client.query('delete from rule_conditions where user_id = $1 and rule_set_id = $2', [
          userId,
          ruleSetId,
        ]);
        await this.writeConditions(client, userId, ruleSetId, patch.conditions);
        await client.query('update rule_sets set version = version + 1 where id = $1', [ruleSetId]);
      }
      await this.bumpVersion(client, userId);
      return true;
    });
  }

  async deleteFilter(userId: string, filterId: string): Promise<boolean> {
    return this.deleteRuleSet(userId, 'filter', filterId);
  }

  async deleteRuleSet(userId: string, kind: RuleKind, ruleSetId: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const res = await client.query(
        'delete from rule_sets where user_id = $1 and id = $2 and kind = $3::rule_kind',
        [userId, ruleSetId, kind],
      );
      if (res.rowCount === 0) return false;
      await this.bumpVersion(client, userId);
      return true;
    });
  }

  /** قراءة قاعدة (فلتر أو تصنيف) بشروطها — تُستخدم في شاشات التحرير. */
  async getRuleSet(userId: string, ruleSetId: string): Promise<FilterDetail | null> {
    await this.ensureReady(userId);
    const summaryRes = await query<{
      id: string;
      name: string;
      description: string | null;
      enabled: boolean;
      priority: number;
      scope: RuleScope;
      applies_to: RuleAppliesTo;
      is_builtin: boolean;
      version: string;
      term_count: string;
      updated_at: Date;
      condition_count: number;
    }>(
      `select s.id, s.name, s.description, s.enabled, s.priority, s.scope, s.applies_to, s.is_builtin,
              s.version::text as version,
              (select count(*) from condition_terms ct
                 join rule_conditions c on c.id = ct.condition_id where c.rule_set_id = s.id)::text as term_count,
              (select count(*)::int from rule_conditions c where c.rule_set_id = s.id) as condition_count,
              s.updated_at
         from rule_sets s where s.user_id = $1 and s.id = $2`,
      [userId, ruleSetId],
    );
    const row = summaryRes.rows[0];
    if (!row) return null;
    const conditions = await query<ConditionRow>(
      `select id, rule_set_id, position, mode, negate, min_matches, dictionary_id
         from rule_conditions where user_id = $1 and rule_set_id = $2 order by position`,
      [userId, ruleSetId],
    );
    const terms = await query<{
      id: string;
      condition_id: string;
      literal: string | null;
      match_mode: TermMatchMode | null;
      dict_term: string | null;
    }>(
      `select ct.id, ct.condition_id, ct.literal, ct.match_mode, dt.term as dict_term
         from condition_terms ct
         left join dictionary_terms dt on dt.id = ct.dictionary_term_id
        where ct.user_id = $1 and ct.condition_id = any($2::uuid[])`,
      [userId, conditions.rows.map((condition) => condition.id)],
    );
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      priority: row.priority,
      scope: row.scope,
      appliesTo: row.applies_to,
      isBuiltin: row.is_builtin,
      version: row.version,
      conditionCount: row.condition_count,
      termCount: Number(row.term_count),
      sourceIds: [],
      updatedAt: row.updated_at.toISOString(),
      conditions: conditions.rows.map((condition) => ({
        id: condition.id,
        position: condition.position,
        mode: condition.mode,
        negate: condition.negate,
        minMatches: condition.min_matches,
        dictionaryId: condition.dictionary_id,
        terms: terms.rows
          .filter((term) => term.condition_id === condition.id)
          .map((term) => ({
            id: term.id,
            display: term.dict_term ?? term.literal ?? '',
            literal: term.dict_term === null,
            matchMode: term.match_mode,
          })),
      })),
    };
  }

  async bindSources(userId: string, filterId: string, sourceIds: string[]): Promise<boolean> {
    return withTransaction(async (client) => {
      const exists = await client.query("select 1 from rule_sets where user_id = $1 and id = $2 and kind = 'filter'", [
        userId,
        filterId,
      ]);
      if (exists.rowCount === 0) return false;
      // الملكية تُفرض بالمفتاح المركّب: مصدر مستخدم آخر يفشل الإدراج (23503).
      await client.query('delete from filter_source_bindings where user_id = $1 and filter_id = $2', [
        userId,
        filterId,
      ]);
      for (const sourceId of sourceIds) {
        await client.query(
          `insert into filter_source_bindings (user_id, filter_id, source_id) values ($1, $2, $3)`,
          [userId, filterId, sourceId],
        );
      }
      await client.query('update rule_sets set version = version + 1 where id = $1', [filterId]);
      await this.bumpVersion(client, userId);
      return true;
    });
  }

  // ── القواميس ───────────────────────────────────────────────────────────────
  async listDictionaries(userId: string): Promise<DictionarySummary[]> {
    await this.ensureReady(userId);
    const dictionaries = await query<{ id: string; name: string; kind: string; enabled: boolean }>(
      'select id, name, kind, enabled from dictionaries where user_id = $1 order by created_at',
      [userId],
    );
    const terms = await query<{
      id: string;
      dictionary_id: string;
      term: string;
      match_mode: TermMatchMode;
      loose: boolean;
      enabled: boolean;
    }>('select id, dictionary_id, term, match_mode, loose, enabled from dictionary_terms where user_id = $1 order by term', [
      userId,
    ]);
    return dictionaries.rows.map((dictionary) => {
      const list = terms.rows.filter((term) => term.dictionary_id === dictionary.id);
      return {
        id: dictionary.id,
        name: dictionary.name,
        kind: dictionary.kind,
        enabled: dictionary.enabled,
        termCount: list.length,
        terms: list.map((term) => ({
          id: term.id,
          term: term.term,
          matchMode: term.match_mode,
          loose: term.loose,
          enabled: term.enabled,
        })),
      };
    });
  }

  async createDictionary(
    userId: string,
    input: { name: string; kind: DictionarySummary['kind'] },
  ): Promise<{ id: string }> {
    await this.ensureReady(userId);
    return withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        'insert into dictionaries (user_id, name, kind) values ($1, $2, $3) returning id',
        [userId, input.name, input.kind],
      );
      await this.bumpVersion(client, userId);
      return { id: inserted.rows[0]!.id };
    });
  }

  async addTerms(
    userId: string,
    dictionaryId: string,
    terms: { term: string; matchMode?: TermMatchMode; loose?: boolean }[],
  ): Promise<{ inserted: number } | null> {
    return withTransaction(async (client) => {
      const exists = await client.query('select 1 from dictionaries where user_id = $1 and id = $2', [
        userId,
        dictionaryId,
      ]);
      if (exists.rowCount === 0) return null;
      let inserted = 0;
      for (const term of terms) {
        const normalized = normalizeArabic(term.term, term.loose ? { foldTaMarbuta: true } : {});
        const res = await client.query(
          `insert into dictionary_terms (user_id, dictionary_id, term, term_normalized, match_mode, loose)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (dictionary_id, term_normalized) do nothing`,
          [userId, dictionaryId, term.term.trim(), normalized, term.matchMode ?? 'word', Boolean(term.loose)],
        );
        inserted += res.rowCount ?? 0;
      }
      await client.query('update dictionaries set version = version + 1 where id = $1', [dictionaryId]);
      await this.bumpVersion(client, userId);
      return { inserted };
    });
  }

  async deleteTerm(userId: string, dictionaryId: string, termId: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const res = await client.query(
        'delete from dictionary_terms where user_id = $1 and dictionary_id = $2 and id = $3',
        [userId, dictionaryId, termId],
      );
      if (res.rowCount === 0) return false;
      await client.query('update dictionaries set version = version + 1 where id = $1', [dictionaryId]);
      await this.bumpVersion(client, userId);
      return true;
    });
  }

  async deleteDictionary(userId: string, dictionaryId: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const res = await client.query('delete from dictionaries where user_id = $1 and id = $2', [
        userId,
        dictionaryId,
      ]);
      if (res.rowCount === 0) return false;
      await this.bumpVersion(client, userId);
      return true;
    });
  }

  async listClassifications(userId: string): Promise<ClassificationSummary[]> {
    await this.ensureReady(userId);
    const res = await query<{
      id: string;
      name: string;
      description: string | null;
      priority: number;
      enabled: boolean;
      is_builtin: boolean;
      condition_count: number;
      version: string;
    }>(
      `select s.id, s.name, s.description, s.priority, s.enabled, s.is_builtin,
              (select count(*)::int from rule_conditions c where c.rule_set_id = s.id) as condition_count,
              s.version::text as version
         from rule_sets s
        where s.user_id = $1 and s.kind = 'classification'
        order by s.priority, s.name, s.id`,
      [userId],
    );
    return res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      priority: row.priority,
      enabled: row.enabled,
      isBuiltin: row.is_builtin,
      conditionCount: row.condition_count,
      version: row.version,
    }));
  }

  async listTemplates(userId: string): Promise<{ templates: TemplateDetail[]; defaultTemplateId: string | null }> {
    await this.ensureReady(userId);
    const [state, templateRows, fieldRows, bindingRows] = await Promise.all([
      query<{ default_template_id: string | null }>(
        'select default_template_id from user_config_state where user_id = $1',
        [userId],
      ),
      query<{ id: string; name: string; description: string | null; is_builtin: boolean; enabled: boolean }>(
        `select id, name, description, is_builtin, enabled from templates
          where user_id = $1 order by name, id`,
        [userId],
      ),
      query<{ template_id: string; field_key: string; label: string; position: number; enabled: boolean }>(
        `select template_id, field_key, label, position, enabled from template_fields
          where user_id = $1 order by template_id, position`,
        [userId],
      ),
      query<{ template_id: string; scope: 'source' | 'filter' | 'classification'; source_id: string | null; rule_set_id: string | null }>(
        `select template_id, scope, source_id::text as source_id, rule_set_id::text as rule_set_id
           from template_bindings where user_id = $1`,
        [userId],
      ),
    ]);

    const defaultTemplateId = state.rows[0]?.default_template_id ?? null;
    const templates: TemplateDetail[] = templateRows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      isBuiltin: row.is_builtin,
      enabled: row.enabled,
      isDefault: row.id === defaultTemplateId,
      fields: fieldRows.rows
        .filter((field) => field.template_id === row.id)
        .sort((a, b) => a.position - b.position)
        .map((field) => ({
          fieldKey: field.field_key,
          label: field.label,
          position: field.position,
          enabled: field.enabled,
        })),
      bindings: {
        sourceIds: bindingRows.rows
          .filter((binding) => binding.template_id === row.id && binding.scope === 'source')
          .map((binding) => binding.source_id!)
          .filter(Boolean),
        filterIds: bindingRows.rows
          .filter((binding) => binding.template_id === row.id && binding.scope === 'filter')
          .map((binding) => binding.rule_set_id!)
          .filter(Boolean),
        classificationIds: bindingRows.rows
          .filter((binding) => binding.template_id === row.id && binding.scope === 'classification')
          .map((binding) => binding.rule_set_id!)
          .filter(Boolean),
      },
    }));

    return { templates, defaultTemplateId };
  }

  async updateTemplate(
    userId: string,
    templateId: string,
    patch: {
      name?: string;
      enabled?: boolean;
      fields?: { fieldKey: string; label: string; enabled?: boolean }[];
    },
  ): Promise<boolean> {
    await this.ensureReady(userId);
    return withTransaction(async (client) => {
      const exists = await client.query('select 1 from templates where user_id = $1 and id = $2', [
        userId,
        templateId,
      ]);
      if (exists.rowCount === 0) return false;

      if (patch.name !== undefined || patch.enabled !== undefined) {
        await client.query(
          `update templates
              set name = coalesce($3, name), enabled = coalesce($4, enabled), updated_at = now()
            where user_id = $1 and id = $2`,
          [userId, templateId, patch.name ?? null, patch.enabled ?? null],
        );
      }

      if (patch.fields) {
        // استبدال كامل: الترتيب هو ترتيب المصفوفة الممرَّرة (§7.3).
        await client.query('delete from template_fields where user_id = $1 and template_id = $2', [
          userId,
          templateId,
        ]);
        let position = 0;
        for (const field of patch.fields) {
          await client.query(
            `insert into template_fields (user_id, template_id, position, field_key, label, enabled)
             values ($1, $2, $3, $4, $5, $6)`,
            [userId, templateId, position, field.fieldKey, field.label, field.enabled ?? true],
          );
          position += 1;
        }
      }

      await this.bumpVersion(client, userId);
      return true;
    });
  }

  async setTemplateBindings(
    userId: string,
    templateId: string,
    input: { sourceIds?: string[]; filterIds?: string[]; classificationIds?: string[] },
  ): Promise<boolean> {
    await this.ensureReady(userId);
    return withTransaction(async (client) => {
      const exists = await client.query('select 1 from templates where user_id = $1 and id = $2', [
        userId,
        templateId,
      ]);
      if (exists.rowCount === 0) return false;

      await client.query('delete from template_bindings where user_id = $1 and template_id = $2', [
        userId,
        templateId,
      ]);

      for (const sourceId of input.sourceIds ?? []) {
        await client.query(
          `insert into template_bindings (user_id, template_id, scope, source_id)
           values ($1, $2, 'source', $3)
           on conflict do nothing`,
          [userId, templateId, sourceId],
        );
      }
      for (const filterId of input.filterIds ?? []) {
        await client.query(
          `insert into template_bindings (user_id, template_id, scope, rule_set_id)
           values ($1, $2, 'filter', $3)
           on conflict do nothing`,
          [userId, templateId, filterId],
        );
      }
      for (const classificationId of input.classificationIds ?? []) {
        await client.query(
          `insert into template_bindings (user_id, template_id, scope, rule_set_id)
           values ($1, $2, 'classification', $3)
           on conflict do nothing`,
          [userId, templateId, classificationId],
        );
      }

      await this.bumpVersion(client, userId);
      return true;
    });
  }

  async setDefaultTemplate(userId: string, templateId: string | null): Promise<boolean> {
    await this.ensureReady(userId);
    return withTransaction(async (client) => {
      if (templateId) {
        const exists = await client.query('select 1 from templates where user_id = $1 and id = $2', [
          userId,
          templateId,
        ]);
        if (exists.rowCount === 0) return false;
      }
      await client.query('update user_config_state set default_template_id = $2, updated_at = now() where user_id = $1', [
        userId,
        templateId,
      ]);
      await this.bumpVersion(client, userId);
      return true;
    });
  }

  // ── أدوات داخلية ───────────────────────────────────────────────────────────
  private async writeConditions(
    client: PoolClient,
    userId: string,
    filterId: string,
    conditions: ConditionInput[],
  ): Promise<void> {
    let position = 0;
    for (const condition of conditions) {
      position += 1;
      const row = await client.query<{ id: string }>(
        `insert into rule_conditions (user_id, rule_set_id, position, mode, negate, min_matches, dictionary_id)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          userId,
          filterId,
          position,
          condition.mode,
          Boolean(condition.negate),
          condition.minMatches ?? 1,
          condition.dictionaryId ?? null,
        ],
      );
      const conditionId = row.rows[0]!.id;
      for (const literal of condition.terms ?? []) {
        const normalized = normalizeArabic(literal);
        await client.query(
          `insert into condition_terms (user_id, condition_id, literal, literal_normalized, match_mode)
           values ($1, $2, $3, $4, $5) on conflict do nothing`,
          [userId, conditionId, literal.trim(), normalized, condition.matchMode ?? null],
        );
      }
    }
  }

  private async bumpVersion(client: PoolClient, userId: string): Promise<void> {
    await client.query(
      `insert into user_config_state (user_id, processing_version, seeded_at)
       values ($1, 1, now())
       on conflict (user_id) do update
         set processing_version = user_config_state.processing_version + 1, updated_at = now()`,
      [userId],
    );
  }
}
