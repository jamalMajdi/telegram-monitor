/**
 * اختبارات اختبار الفلتر (P4-هـ): في الذاكرة، بلا حفظ وبلا استخراج.
 *
 * المحور: «اختبار» يجب ألا يكون كتابةً خفية. لذلك نقيس **قبل/بعد** كل جدول معنيّ:
 * الهويات، المحتوى، الاستخراج، المطابقات، وأحداث الأخطاء — ويجب أن تبقى الأعداد كما هي حرفياً.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let seeded: ScenarioHarness;

const JOB_TEXT = 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية، للتواصل 777123456';

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });
  // مستخدم مُهيّأ: إرسال رسالة واحدة يجعل البذور (فلاتر) موجودة فعلاً.
  seeded = await scenario.create();
  await scenario.emit(seeded, JOB_TEXT);
});

after(async () => {
  await server.close();
});

async function counts(userId: string): Promise<Record<string, number>> {
  const res = await server.sql<Record<string, number>>(
    `select
       (select count(*)::int from message_identity where user_id = $1) as identities,
       (select count(*)::int from message_content c join message_identity i on i.id = c.identity_id where i.user_id = $1) as content,
       (select count(*)::int from message_extraction x join message_identity i on i.id = x.identity_id where i.user_id = $1) as extraction,
       (select count(*)::int from message_matches m join message_identity i on i.id = m.identity_id where i.user_id = $1) as matches,
       (select count(*)::int from error_events where user_id = $1) as errors,
       (select count(*)::int from deliveries where user_id = $1) as deliveries`,
    [userId],
  );
  return res.rows[0] as Record<string, number>;
}

interface FilterRow {
  id: string;
  name: string;
  enabled: boolean;
  version: string;
}

interface FilterDetail {
  id: string;
  name: string;
  enabled: boolean;
  conditions: { mode: string; terms?: { id: string; display: string }[] }[];
}

/** تفصيل الفلتر يحمل الشروط والمصطلحات؛ القائمة تعيد ملخّصات فقط. */
async function detailOf(api: ScenarioHarness['api'], filterId: string): Promise<FilterDetail> {
  const res = await api.get(`/api/v1/telegram/filters/${filterId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body as { filter: FilterDetail }).filter;
}

describe('اختبار فلتر محفوظ', () => {
  it('يعيد المطابقة والتفصيل بلا أي كتابة في قاعدة البيانات', async () => {
    const filters = (await seeded.api.get('/api/v1/telegram/filters')).body as { filters: FilterRow[] };
    assert.ok(filters.filters.length >= 1, 'البذور أنشأت فلاتر');
    const filter = filters.filters[0]!;

    const before = await counts(seeded.userId);

    const res = await seeded.api.post(`/api/v1/telegram/filters/${filter.id}/test`, {
      text: JOB_TEXT,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const result = (res.body as {
      result: { matched: boolean; evaluated: number; matches: { ruleId: string; ruleName: string; hits: unknown[] }[]; normalizedPreview: string };
    }).result;
    assert.equal(result.evaluated, 1, 'يُقيَّم فلتر واحد فقط');
    assert.equal(typeof result.matched, 'boolean');
    assert.ok(result.normalizedPreview.length > 0);

    const after = await counts(seeded.userId);
    assert.deepEqual(after, before, 'الاختبار لا يكتب أي صف في أي جدول');
  });

  it('يطابق نصاً يحتوي كلمة الفلتر ويعيد الأدلة', async () => {
    // فلتر مُنشأ لهذا الاختبار: مصطلح فريد، شرط واحد — فلا تتشابك دلالات البذور مع النتيجة.
    const term = 'زرقنمف';
    const created = await seeded.api.post('/api/v1/telegram/filters', {
      name: 'فلتر اختبار P4-هـ',
      conditions: [{ mode: 'any', terms: [term], matchMode: 'word' }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const filterId = (created.body as { filter: { id: string } }).filter.id;

    const matched = await seeded.api.post(`/api/v1/telegram/filters/${filterId}/test`, {
      text: `إعلان تجريبي يحتوي كلمة ${term} بوضوح`,
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    const result = (matched.body as { result: { matched: boolean; matches: { hits: unknown[] }[] } }).result;
    assert.equal(result.matched, true, `المصطلح «${term}» يجب أن يطابق`);
    assert.ok(result.matches[0]!.hits.length >= 1);

    // نص لا يحتوي المصطلح: لا مطابقة ولا خطأ.
    const unmatched = await seeded.api.post(`/api/v1/telegram/filters/${filterId}/test`, {
      text: 'zzz qqq xxx',
    });
    assert.equal(unmatched.status, 200);
    assert.equal((unmatched.body as { result: { matched: boolean } }).result.matched, false);
  });

  it('يرفض النص الفارغ والطويل ويحمي حدود المالك', async () => {
    const filters = (await seeded.api.get('/api/v1/telegram/filters')).body as { filters: FilterRow[] };
    const filter = filters.filters[0]!;

    assert.equal((await seeded.api.post(`/api/v1/telegram/filters/${filter.id}/test`, { text: '' })).status, 400);
    assert.equal(
      (await seeded.api.post(`/api/v1/telegram/filters/${filter.id}/test`, { text: 'ا'.repeat(5000) })).status,
      400,
    );

    // مستخدم آخر لا يستطيع اختبار فلتر غيره.
    const other = await scenario.create();
    assert.equal(
      (await other.api.post(`/api/v1/telegram/filters/${filter.id}/test`, { text: JOB_TEXT })).status,
      404,
    );

    // بلا جلسة: 401.
    const anonymous = await fetch(`${server.baseUrl}/api/v1/telegram/filters/${filter.id}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: JOB_TEXT }),
    });
    assert.equal(anonymous.status, 401);
  });

  it('يختبر مسوّدة غير محفوظة بلا قاعدة بيانات', async () => {
    const before = await counts(seeded.userId);
    const res = await seeded.api.post('/api/v1/telegram/filters/test', {
      definition: {
        name: 'مسوّدة اختبار',
        conditions: [{ mode: 'any', terms: ['مبرمج'], matchMode: 'word' }],
      },
      text: JOB_TEXT,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const result = (res.body as { result: { matched: boolean; normalizedPreview: string } }).result;
    assert.equal(result.matched, true);
    const after = await counts(seeded.userId);
    assert.deepEqual(after, before);
  });
});
