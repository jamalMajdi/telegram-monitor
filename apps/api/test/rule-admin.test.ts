/**
 * اختبارات شاشات تحرير القواعد (فلاتر + تصنيفات) — الخلفية التي تعتمد عليها الواجهة.
 *
 * يغطّي:
 *  - البذور بعد دمج تصنيفات الطلبات الدراسية في «خدمات طلابية» (لا بقايا للأسماء القديمة).
 *  - إنشاء/قراءة/تعديل/حذف تصنيف، وأن التعديل يستبدل الشروط فعلاً (لا يراكمها).
 *  - العزل بين المستخدمين: لا قراءة ولا تعديل ولا حذف لقاعدة يملكها غيرك.
 *  - أن مسار الفلاتر لم ينكسر بعد تعميم طبقة التخزين (نفس الدالة تخدم النوعين).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, client, type TestClient, type TestServer } from './harness.js';

const PASSWORD = 'CorrectHorse123';
let server: TestServer;
let counter = 0;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

async function newUser(): Promise<{ api: TestClient; email: string }> {
  const api = client(server.baseUrl);
  counter += 1;
  const email = `rules${counter}@example.test`;
  const res = await api.post('/api/v1/auth/register', {
    email,
    displayName: `مستخدم قواعد ${counter}`,
    password: PASSWORD,
  });
  assert.equal(res.status, 201);
  return { api, email };
}

interface ClassificationRow {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  conditionCount: number;
}

async function listClassifications(api: TestClient): Promise<ClassificationRow[]> {
  const res = await api.get('/api/v1/telegram/classifications');
  assert.equal(res.status, 200);
  return res.body.classifications as ClassificationRow[];
}

describe('تحرير التصنيفات من الـAPI', () => {
  it('البذور تعرض «خدمات طلابية» ولا تعرض التصنيفات المدمجة القديمة', async () => {
    const { api } = await newUser();
    const rows = await listClassifications(api);
    const names = rows.map((row) => row.name);
    assert.ok(names.includes('خدمات طلابية'), 'التصنيف الموحّد يجب أن يكون مبذوراً');
    for (const removed of ['طلبات المساعدة الدراسية', 'واجبات واختبارات', 'مشاريع جامعية', 'خدمات']) {
      assert.ok(!names.includes(removed), `يجب ألّا يبقى التصنيف المدمج «${removed}»`);
    }
  });

  it('ينشئ تصنيفاً بشروط ويقرأه كاملاً', async () => {
    const { api } = await newUser();
    const created = await api.post('/api/v1/telegram/classifications', {
      name: 'تصنيف اختباري',
      description: 'وصف',
      priority: 33,
      conditions: [{ mode: 'any', terms: ['كلمة١', 'كلمة٢'], matchMode: 'word' }],
    });
    assert.equal(created.status, 201);
    const id = created.body.classification.id as string;
    assert.equal(created.body.classification.name, 'تصنيف اختباري');
    assert.equal(created.body.classification.conditions.length, 1);

    const detail = await api.get(`/api/v1/telegram/classifications/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.classification.conditions[0].terms.length, 2);
    assert.equal(detail.body.classification.priority, 33);
  });

  it('التعديل يستبدل الشروط ولا يراكمها', async () => {
    const { api } = await newUser();
    const created = await api.post('/api/v1/telegram/classifications', {
      name: 'تصنيف للاستبدال',
      conditions: [{ mode: 'any', terms: ['أ', 'ب'], matchMode: 'word' }],
    });
    const id = created.body.classification.id as string;

    const patched = await api.patch(`/api/v1/telegram/classifications/${id}`, {
      enabled: false,
      priority: 7,
      conditions: [
        { mode: 'all', terms: ['ج'], matchMode: 'phrase' },
        { mode: 'any', negate: true, terms: ['د'] },
      ],
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.classification.enabled, false);
    assert.equal(patched.body.classification.priority, 7);
    assert.equal(patched.body.classification.conditions.length, 2);
    const allTerms = patched.body.classification.conditions.flatMap(
      (condition: { terms: { display: string }[] }) => condition.terms.map((term) => term.display),
    );
    assert.deepEqual(allTerms.sort(), ['ج', 'د']);
  });

  it('الحذف يُزيل التصنيف من القائمة', async () => {
    const { api } = await newUser();
    const created = await api.post('/api/v1/telegram/classifications', {
      name: 'تصنيف للحذف',
      conditions: [{ mode: 'any', terms: ['هـ'] }],
    });
    const id = created.body.classification.id as string;
    const removed = await api.delete(`/api/v1/telegram/classifications/${id}`);
    assert.equal(removed.status, 204);
    const rows = await listClassifications(api);
    assert.ok(!rows.some((row) => row.id === id));
  });

  it('يرفض التصنيف بلا شروط', async () => {
    const { api } = await newUser();
    const res = await api.post('/api/v1/telegram/classifications', { name: 'بلا شروط', conditions: [] });
    assert.equal(res.status, 400);
  });
});

describe('العزل بين المستخدمين', () => {
  it('لا يقرأ ولا يعدّل ولا يحذف تصنيف غيره', async () => {
    const first = await newUser();
    const second = await newUser();

    const created = await first.api.post('/api/v1/telegram/classifications', {
      name: 'خاص بالمستخدم الأول',
      conditions: [{ mode: 'any', terms: ['خاص'] }],
    });
    const id = created.body.classification.id as string;

    assert.equal((await second.api.get(`/api/v1/telegram/classifications/${id}`)).status, 404);
    assert.equal((await second.api.patch(`/api/v1/telegram/classifications/${id}`, { priority: 1 })).status, 404);
    assert.equal((await second.api.delete(`/api/v1/telegram/classifications/${id}`)).status, 404);

    const rows = await listClassifications(second.api);
    assert.ok(!rows.some((row) => row.id === id), 'قائمة المستخدم الثاني لا تحتوي تصنيف غيره');
  });
});

describe('عدم انكسار مسار الفلاتر', () => {
  it('ينشئ فلتراً ويعدّله ويحذفه (نفس الطبقة بعد التعميم)', async () => {
    const { api } = await newUser();
    const created = await api.post('/api/v1/telegram/filters', {
      name: 'فلتر اختباري',
      priority: 40,
      conditions: [{ mode: 'any', terms: ['كلمة'], matchMode: 'word' }],
    });
    assert.equal(created.status, 201);
    const id = created.body.filter.id as string;

    const patched = await api.patch(`/api/v1/telegram/filters/${id}`, { enabled: false });
    assert.equal(patched.status, 200);

    const removed = await api.delete(`/api/v1/telegram/filters/${id}`);
    assert.equal(removed.status, 204);
  });
});
