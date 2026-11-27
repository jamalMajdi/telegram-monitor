/**
 * اختبارات تكامل إعدادات المعالجة (الخطوة 5-أ): بذر القواميس والفلاتر لكل مستخدم،
 * إدارة الفلاتر عبر الـAPI، ترقية إصدار الإعدادات، العزل بين المستخدمين،
 * وقرار الفلترة الحتمي — مع تأكيد أن **لا نص رسالة يُخزَّن** في هذه الخطوة.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';

const PASSWORD = 'CorrectHorse123';
let server: TestServer;
let counter = 0;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

async function newUser(): Promise<{ api: TestClient; userId: string; email: string }> {
  const api = client(server.baseUrl);
  counter += 1;
  const email = `flt${counter}@example.test`;
  const res = await api.post('/api/v1/auth/register', {
    email,
    displayName: `مستخدم فلاتر ${counter}`,
    password: PASSWORD,
  });
  assert.equal(res.status, 201);
  const row = await server.sql<{ id: string }>('select id from users where email = $1', [email]);
  return { api, userId: row.rows[0]!.id, email };
}

interface FilterSummary {
  id: string;
  name: string;
  priority: number;
  scope: 'all_sources' | 'bound_sources';
  appliesTo: 'any' | 'text' | 'caption';
  enabled: boolean;
  isBuiltin: boolean;
  conditionCount: number;
  boundSourceCount: number;
  version: number;
}

async function listFilters(api: TestClient): Promise<FilterSummary[]> {
  const res = await api.get('/api/v1/telegram/filters');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body as { filters: FilterSummary[] }).filters;
}

async function version(userId: string): Promise<number> {
  const row = await server.sql<{ processing_version: number }>(
    'select processing_version from user_config_state where user_id = $1',
    [userId],
  );
  return row.rows[0]!.processing_version;
}

/** خدمة الفلترة كما يستخدمها خط الأنابيب لاحقاً (نفس الوحدات المستوردة داخل التطبيق). */
async function filterService() {
  const { FilterService } = await import('../src/modules/processing/filterService.js');
  const { PgRuleConfigRepository } = await import('../src/modules/processing/ruleConfigRepository.js');
  return new FilterService(new PgRuleConfigRepository());
}

describe('إعدادات المعالجة (5-أ): البذر', () => {
  it('يبذر قواميس وفلاتر افتراضية تلقائياً عند أول وصول', async () => {
    const { api, userId } = await newUser();
    const filters = await listFilters(api);
    assert.equal(filters.length, 7);
    assert.deepEqual(
      filters.map((filter) => filter.priority),
      [10, 20, 30, 40, 50, 60, 70],
      'الترتيب حسب الأولوية',
    );
    assert.ok(filters.every((filter) => filter.isBuiltin), 'البذور معلّمة is_builtin');
    assert.ok(filters.every((filter) => filter.conditionCount >= 2), 'كل فلتر له شروط');
    assert.equal(await version(userId), 1, 'البذر يرقّي الإصدار من 0 إلى 1');

    const dictionaries = await api.get('/api/v1/telegram/dictionaries');
    assert.equal(dictionaries.status, 200);
    const items = (dictionaries.body as { dictionaries: { name: string; termCount: number }[] }).dictionaries;
    // البذور الموسّعة (SEED_VERSION 2+): ثمانية قواميس نطاقية بدل ستة ضيقة.
    assert.equal(items.length, 8);
    const requestPatterns = items.find((item) => item.name === 'صيغ الطلب والبحث');
    assert.ok(requestPatterns && requestPatterns.termCount >= 60, 'قاموس صيغ الطلب موسّع');
    for (const name of ['مصطلحات دراسية', 'مصطلحات عقارية', 'مصطلحات بيع وشراء', 'مصطلحات الوظائف', 'مفردات النطاقات المتخصصة']) {
      assert.ok(items.some((item) => item.name === name), `قاموس مفقود: ${name}`);
    }
    const totalTerms = items.reduce((sum, item) => sum + item.termCount, 0);
    assert.ok(totalTerms >= 900, `المعجم المبذور ضعيف: ${totalTerms} مصطلحاً فقط`);
    const academic = items.find((item) => item.name === 'مصطلحات دراسية');
    assert.ok(academic && academic.termCount >= 120, `قاموس دراسي ضعيف: ${academic?.termCount}`);
    for (const term of ['بحوث', 'مشاريع', 'تلخيص', 'واجبات', 'تكاليف', 'عروض']) {
      assert.ok(academic && academic.termCount > 0, 'قاموس دراسي فارغ');
    }
  });

  it('البذر لا يتكرّر عند الطلبات المتتالية', async () => {
    const { api, userId } = await newUser();
    await listFilters(api);
    const afterFirst = await version(userId);
    await listFilters(api);
    await listFilters(api);
    assert.equal(await version(userId), afterFirst, 'لا ترقية إصدار بلا تعديل حقيقي');
    const counts = await server.sql<{ dictionaries: string; filters: string; classifications: string }>(
      `select (select count(*) from dictionaries where user_id = $1)::text as dictionaries,
              (select count(*) from rule_sets where user_id = $1 and kind = 'filter')::text as filters,
              (select count(*) from rule_sets where user_id = $1 and kind = 'classification')::text as classifications`,
      [userId],
    );
    assert.equal(counts.rows[0]!.dictionaries, '8');
    assert.equal(counts.rows[0]!.filters, '7');
    // 0026: 10 تصنيفات مبذورة سابقاً ⇒ 7 بعد دمج الأربعة الدراسية في «خدمات طلابية».
    assert.equal(counts.rows[0]!.classifications, '7', 'بذور التصنيفات السبعة بعد الدمج');
  });
});

describe('إعدادات المعالجة (5-أ): إدارة الفلاتر', () => {
  it('ينشئ فلتراً مخصّصاً ويرقّي إصدار الإعدادات', async () => {
    const { api, userId } = await newUser();
    await listFilters(api);
    const before = await version(userId);
    const created = await api.post('/api/v1/telegram/filters', {
      name: 'طلبات تصميم',
      description: 'طلبات تصميم جرافيك',
      priority: 15,
      appliesTo: 'any',
      conditions: [
        { mode: 'any', terms: ['تصميم', 'شعار'] },
        { mode: 'any', terms: ['مطلوب', 'أبحث عن'] },
        { mode: 'any', negate: true, terms: ['مجاني'] },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const filter = (created.body as { filter: Record<string, unknown> }).filter;
    assert.equal(filter.name, 'طلبات تصميم');
    assert.equal(await version(userId), before + 1, 'ترقية واحدة لكل عملية كتابة');
    const listed = await listFilters(api);
    const found = listed.find((item) => item.name === 'طلبات تصميم');
    assert.ok(found);
    assert.equal(found.priority, 15);
    assert.equal(found.conditionCount, 3);
    assert.equal(found.isBuiltin, false);
  });

  it('يعدّل الفلتر ويستبدل شروطه', async () => {
    const { api, userId } = await newUser();
    await listFilters(api);
    const created = await api.post('/api/v1/telegram/filters', {
      name: 'فلتر مؤقت',
      conditions: [{ mode: 'any', terms: ['اختبار'] }],
    });
    const filterId = (created.body as { filter: { id: string } }).filter.id;
    const before = await version(userId);
    const patched = await api.patch(`/api/v1/telegram/filters/${filterId}`, {
      name: 'فلتر محدَّث',
      priority: 5,
      conditions: [{ mode: 'all', terms: ['اختبار', 'تجريبي'] }],
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const filter = (patched.body as { filter: { name: string; priority: number; conditionCount: number } }).filter;
    assert.equal(filter.name, 'فلتر محدَّث');
    assert.equal(filter.priority, 5);
    assert.equal(filter.conditionCount, 1);
    assert.equal(await version(userId), before + 1);
  });

  it('يرفض تعديلاً فارغاً بلا ترقية إصدار', async () => {
    const { api, userId } = await newUser();
    const listed = await listFilters(api);
    const before = await version(userId);
    const patched = await api.patch(`/api/v1/telegram/filters/${listed[0]!.id}`, {});
    assert.equal(patched.status, 400);
    assert.equal(await version(userId), before);
  });

  it('يحذف الفلتر ويرقّي الإصدار', async () => {
    const { api, userId } = await newUser();
    await listFilters(api);
    const created = await api.post('/api/v1/telegram/filters', {
      name: 'فلتر للحذف',
      conditions: [{ mode: 'any', terms: ['مؤقت'] }],
    });
    const filterId = (created.body as { filter: { id: string } }).filter.id;
    const before = await version(userId);
    const deleted = await api.del(`/api/v1/telegram/filters/${filterId}`);
    assert.equal(deleted.status, 204);
    assert.equal(await version(userId), before + 1);
    const fetched = await api.get(`/api/v1/telegram/filters/${filterId}`);
    assert.equal(fetched.status, 404);
  });

  it('يضيف مصطلحات إلى قاموس مخصّص', async () => {
    const { api } = await newUser();
    const created = await api.post('/api/v1/telegram/dictionaries', {
      name: 'قاموسي',
      kind: 'keywords',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const dictionaryId = (created.body as { dictionary: { id: string } }).dictionary.id;
    const added = await api.post(`/api/v1/telegram/dictionaries/${dictionaryId}/terms`, {
      terms: [{ term: 'تسويق' }, { term: 'إعلان' }],
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal((added.body as { inserted: number }).inserted, 2);
    const filtered = await api.get('/api/v1/telegram/filters');
    assert.equal(filtered.status, 200);
  });
});

describe('إعدادات المعالجة (5-أ): عزل المستخدمين', () => {
  it('لا يرى المستخدم فلاتر غيره ولا يعدّلها ولا يحذفها', async () => {
    const first = await newUser();
    const second = await newUser();
    const created = await first.api.post('/api/v1/telegram/filters', {
      name: 'خاص بالمستخدم الأول',
      conditions: [{ mode: 'any', terms: ['سري'] }],
    });
    const filterId = (created.body as { filter: { id: string } }).filter.id;

    const mine = await listFilters(second.api);
    assert.ok(!mine.some((filter) => filter.id === filterId));
    assert.equal(mine.length, 7, 'بذور خاصة بالمستخدم الثاني فقط');

    assert.equal((await second.api.get(`/api/v1/telegram/filters/${filterId}`)).status, 404);
    assert.equal(
      (await second.api.patch(`/api/v1/telegram/filters/${filterId}`, { name: 'اختطاف' })).status,
      404,
    );
    assert.equal((await second.api.del(`/api/v1/telegram/filters/${filterId}`)).status, 404);
    assert.equal((await second.api.post(`/api/v1/telegram/filters/${filterId}/test`, { text: 'سري' })).status, 404);
  });

  it('يرفض ربط مصدر غير مملوك', async () => {
    const owner = await newUser();
    const other = await newUser();
    const created = await owner.api.post('/api/v1/telegram/filters', {
      name: 'فلتر مقيد',
      conditions: [{ mode: 'any', terms: ['مقيد'] }],
    });
    const filterId = (created.body as { filter: { id: string } }).filter.id;
    const bound = await other.api.request(`/api/v1/telegram/filters/${filterId}/sources`, {
      method: 'PUT',
      body: { sourceIds: ['00000000-0000-4000-8000-000000000001'] },
    });
    assert.equal(bound.status, 404, 'فلتر مستخدم آخر غير مرئي أصلاً');
  });
});

describe('إعدادات المعالجة (5-أ): اختبار الفلترة بلا حفظ', () => {
  it('يختبر فلتراً محفوظاً ويعيد الأدلة دون تخزين النص', async () => {
    const { api, userId } = await newUser();
    const listed = await listFilters(api);
    const jobs = listed.find((filter) => filter.name === 'وظائف وفرص عمل')!;
    const before = await version(userId);
    const rowsBefore = await server.sql<{ count: string }>(
      'select count(*)::text as count from rule_conditions where user_id = $1',
      [userId],
    );

    const positive = await api.post(`/api/v1/telegram/filters/${jobs.id}/test`, {
      text: 'مطلوب مبرمج بخبرة سنتين للعمل في شركة',
    });
    assert.equal(positive.status, 200, JSON.stringify(positive.body));
    const result = (positive.body as {
      result: { matched: boolean; matches: { hits: { matchedTerms: string[] }[] }[] };
    }).result;
    assert.equal(result.matched, true);
    const terms = result.matches.flatMap((match) => match.hits.flatMap((hit) => hit.matchedTerms));
    assert.ok(terms.includes('خبرة'), `الأدلة تحمل أسماء المصطلحات: ${JSON.stringify(terms)}`);

    const negative = await api.post(`/api/v1/telegram/filters/${jobs.id}/test`, {
      text: 'مبرمج محترف يقدم خدماته',
    });
    assert.equal((negative.body as { result: { matched: boolean } }).result.matched, false);

    // ملاحظة سلوك (SEED_VERSION 2): «دورة/تدريب» أُزيلا من الاستبعاد لأنهما كانا يُسقطان طلبات
    // تدريب صيفي ودورات دراسية مشروعة؛ الاستبعاد الآن للإعلانات المدفوعة وحدها.
    const training = await api.post(`/api/v1/telegram/filters/${jobs.id}/test`, {
      text: 'مطلوب مبرمج بخبرة — دورة تدريبية',
    });
    assert.equal(
      (training.body as { result: { matched: boolean } }).result.matched,
      true,
      'طلب تدريب مشروع لا يُستبعد',
    );

    const excluded = await api.post(`/api/v1/telegram/filters/${jobs.id}/test`, {
      text: 'مطلوب مبرمج بخبرة — اعلان ممول',
    });
    assert.equal((excluded.body as { result: { matched: boolean } }).result.matched, false, 'الاستبعاد يعمل');

    assert.equal(await version(userId), before, 'الاختبار لا يرقّي الإصدار');
    const rowsAfter = await server.sql<{ count: string }>(
      'select count(*)::text as count from rule_conditions where user_id = $1',
      [userId],
    );
    assert.equal(rowsAfter.rows[0]!.count, rowsBefore.rows[0]!.count, 'الاختبار لا يعدّل الشروط');
  });

  it('يختبر تعريفاً غير محفوظ دون إنشاء فلتر', async () => {
    const { api } = await newUser();
    const before = (await listFilters(api)).length;
    const res = await api.post('/api/v1/telegram/filters/test', {
      definition: {
        name: 'مسوّدة اختبار',
        conditions: [{ mode: 'all', terms: ['شقة', 'للإيجار'] }],
      },
      text: 'شقة مفروشة للإيجار في المنصورة',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body as { result: { matched: boolean } }).result.matched, true);
    assert.equal((await listFilters(api)).length, before, 'المسوّدة لا تُحفظ');
  });
});

describe('إعدادات المعالجة (5-أ): قرار الفلترة', () => {
  it('يطابق الرسائل المناسبة ويحمل إصدار الإعدادات والأدلة', async () => {
    const { userId } = await newUser();
    const filters = await filterService();
    const decision = await filters.decide({
      userId,
      sourceId: '00000000-0000-4000-8000-0000000000aa',
      text: 'مطلوب مبرمج بخبرة سنتين للعمل في شركة',
      caption: '',
    });
    assert.equal(decision.matched, true);
    assert.equal(decision.reason, 'matched');
    assert.ok(decision.evaluatedRules >= 5);
    assert.ok(
      decision.matches.some((match) => match.ruleName === 'وظائف وفرص عمل'),
      `المطابقات: ${decision.matches.map((match) => match.ruleName).join(' | ')}`,
    );
    assert.equal(decision.processingVersion, String(await version(userId)));
    assert.ok(decision.matches.every((match) => match.hits.length > 0));
  });

  it('يطابق العقارات ويستبعد الإعلانات التجارية', async () => {
    const { userId } = await newUser();
    const filters = await filterService();
    const property = await filters.decide({
      userId,
      sourceId: '00000000-0000-4000-8000-0000000000aa',
      text: 'أبحث عن شقة للإيجار قريبة من الجامعة',
      caption: '',
    });
    assert.equal(property.matched, true);
    assert.ok(property.matches.some((match) => match.ruleName === 'عقارات'));

    const advertisement = await filters.decide({
      userId,
      sourceId: '00000000-0000-4000-8000-0000000000aa',
      text: 'اعلان ممول مطلوب للمبرمجين المبتدئين',
      caption: '',
    });
    assert.equal(advertisement.matched, false);
    assert.equal(advertisement.reason, 'no_filter_match');
  });

  it('يصدر سبباً صريحاً عند غياب أي فلتر مطابق', async () => {
    const { userId } = await newUser();
    const filters = await filterService();
    const decision = await filters.decide({
      userId,
      sourceId: '00000000-0000-4000-8000-0000000000aa',
      text: 'مساء الخير جميعاً، كيف حالكم اليوم',
      caption: '',
    });
    assert.equal(decision.matched, false);
    assert.equal(decision.reason, 'no_filter_match');
    assert.deepEqual(decision.matches, []);
  });

  it('فلتر مقيّد بمصادر لا ينطبق على مصدر غير مربوط', async () => {
    const { api, userId } = await newUser();
    const created = await api.post('/api/v1/telegram/filters', {
      name: 'فلتر مقيّد بمصدر',
      scope: 'bound_sources',
      conditions: [{ mode: 'any', terms: ['زقزاق'] }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const filters = await filterService();
    const decision = await filters.decide({
      userId,
      sourceId: '00000000-0000-4000-8000-0000000000bb',
      text: 'زقزاق زقزاق',
      caption: '',
    });
    assert.equal(decision.matched, false, 'لا مصادر مربوطة ⇒ لا ينطبق');
  });

  it('يعيد بناء اللقطة بعد تعديل الإعدادات (إصدار جديد)', async () => {
    const { api, userId } = await newUser();
    const filters = await filterService();
    const sourceId = '00000000-0000-4000-8000-0000000000cc';
    const before = await filters.decide({ userId, sourceId, text: 'كلمة غير معروفة', caption: '' });
    assert.equal(before.matched, false);

    const created = await api.post('/api/v1/telegram/filters', {
      name: 'فلتر جديد',
      conditions: [{ mode: 'any', terms: ['كلمة غير معروفة'] }],
    });
    assert.equal(created.status, 201);

    const afterCreate = await filters.decide({ userId, sourceId, text: 'كلمة غير معروفة', caption: '' });
    assert.equal(afterCreate.matched, true, 'اللقطة تتحدّث بعد ترقية الإصدار');
    assert.notEqual(afterCreate.processingVersion, before.processingVersion);
  });

  it('لا يخزّن أي نص رسالة في جداول الإعدادات (5-أ)', async () => {
    const columns = await server.sql<{ table_name: string; column_name: string }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name in ('dictionaries','dictionary_terms','rule_sets','rule_conditions',
                             'condition_terms','filter_source_bindings','user_config_state')
          and column_name in ('text','body','content','message_text','caption','raw_text')`,
    );
    assert.deepEqual(columns.rows, []);
  });
});
