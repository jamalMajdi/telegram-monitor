/**
 * اختبارات تكامل الخطوة السادسة (6-أ + 6-ب): من رسالة واردة إلى تصنيف وقالب ونتائج مراجعة عبر الـAPI.
 *
 * تغطي: التصنيف الحتمي، أولوية القالب (O02)، حذف الحقول الغائبة (§7.4)، الحجب الإلزامي (O03)،
 * التعديل اليدوي الغالب في العرض، العزل بين المستخدمين، والحذف مع انتهاء احتفاظ المحتوى (Q12).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { client, startTestServer, type TestClient, type TestServer } from './harness.js';
import { FakeGateway, fakeSource, type FakeAccountClient } from './telegram-fakes.js';
import type { IncomingTextMessage } from '../src/modules/telegram/gateway.js';

const PASSWORD = 'CorrectHorse123';
let server: TestServer;
let gateway: FakeGateway;
let counter = 0;
let peerCounter = 900000;

before(async () => {
  gateway = new FakeGateway();
  server = await startTestServer({ telegramGateway: gateway });
});

after(async () => {
  await server.close();
});

async function newUser(): Promise<TestClient> {
  const api = client(server.baseUrl);
  counter += 1;
  const res = await api.post('/api/v1/auth/register', {
    email: `res${counter}@example.test`,
    displayName: `مستخدم نتائج ${counter}`,
    password: PASSWORD,
  });
  assert.equal(res.status, 201);
  return api;
}

async function linkedAccount(api: TestClient, telegramUserId: string): Promise<string> {
  gateway.outcomeSelf = { id: telegramUserId, username: `reader_${telegramUserId}` };
  gateway.loginBehaviours.push({ submitCode: () => ({ status: 'authorized', self: { id: telegramUserId } }) });
  const started = await api.post('/api/v1/telegram/accounts', { phoneNumber: `+9677${telegramUserId}` });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const accountId = (started.body as { account: { id: string } }).account.id;
  const verified = await api.post(`/api/v1/telegram/accounts/${accountId}/verify`, { code: '12345' });
  assert.equal(verified.status, 200);
  return accountId;
}

function liveClient(accountId: string): FakeAccountClient {
  const found = gateway.created.filter((c) => c.accountId === accountId && c.subscribers.size > 0);
  assert.ok(found.length > 0);
  return found[found.length - 1]!;
}

interface Harness {
  api: TestClient;
  accountId: string;
  sourceId: string;
  peerId: string;
}

async function newMonitoredUser(): Promise<Harness> {
  const api = await newUser();
  const accountId = await linkedAccount(api, String(600 + counter));
  peerCounter += 1;
  const peerId = String(peerCounter);
  gateway.sourceConfig.resolved.set(peerId, fakeSource({ peerId, title: `قناة ${peerId}`, username: `src_${peerId}` }));
  const created = await api.post('/api/v1/telegram/sources', { accountId, peerId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { api, accountId, sourceId: (created.body as { source: { id: string } }).source.id, peerId };
}

async function emit(h: Harness, message: Partial<IncomingTextMessage>) {
  await liveClient(h.accountId).emit({
    accountId: h.accountId,
    peerKey: `channel:${h.peerId}`,
    peerKind: 'channel',
    messageId: 1,
    text: 'مطلوب مبرمج بخبرة سنتين',
    caption: '',
    hasMedia: false,
    ...message,
  });
}

interface ResultListResponse {
  results: {
    identityId: string;
    classificationName: string | null;
    classificationOrigin: string | null;
    templateName: string | null;
    resolvedBy: string | null;
    reviewState: string;
    contentAvailable: boolean;
    contactCount: number;
  }[];
  /** الترقيم أصبح مؤشِّراً (P4-هـ)؛ `total` يبقى فقط في الوضع القديم (offset). */
  total?: number;
  nextCursor: string | null;
}

async function listResults(api: TestClient, query = ''): Promise<ResultListResponse> {
  const res = await api.get(`/api/v1/telegram/results${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as ResultListResponse;
}

async function firstResult(api: TestClient): Promise<string> {
  const list = await listResults(api);
  assert.ok(list.results.length >= 1, 'يجب أن توجد نتيجة واحدة على الأقل');
  return list.results[0]!.identityId;
}

interface DetailResponse {
  message: {
    identityId: string;
    state: string;
    reviewState: string;
    classificationName: string | null;
    classification: {
      name: string | null;
      origin: string | null;
      confidence: number | null;
      automatic: { name: string | null } | null;
      manual: { name: string | null } | null;
    };
    templateName: string | null;
    resolvedBy: string | null;
    contentAvailable: boolean;
  };
  originalText: string | null;
  caption: string | null;
  fields: { key: string; value: string; confidence: number; ambiguous: boolean; span: [number, number] }[];
  contacts: { kind: string; masked: string; ambiguous: boolean }[];
  filters: { name: string }[];
  rendered: { text: string; fields: { key: string; label: string; value: string; masked: boolean }[]; missingFields: { key: string }[] };
}

async function detailOf(api: TestClient, identityId: string): Promise<DetailResponse> {
  const res = await api.get(`/api/v1/telegram/results/${identityId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as DetailResponse;
}

async function templateByName(api: TestClient, name: string): Promise<{ id: string }> {
  const res = await api.get('/api/v1/telegram/templates');
  assert.equal(res.status, 200);
  const templates = (res.body as { templates: { id: string; name: string }[] }).templates;
  const found = templates.find((template) => template.name === name);
  assert.ok(found, `القالب «${name}» غير موجود`);
  return found!;
}

async function classificationByName(api: TestClient, name: string): Promise<{ id: string }> {
  const res = await api.get('/api/v1/telegram/classifications');
  assert.equal(res.status, 200);
  const list = (res.body as { classifications: { id: string; name: string }[] }).classifications;
  const found = list.find((item) => item.name === name);
  assert.ok(found, `التصنيف «${name}» غير موجود`);
  return found!;
}

describe('التصنيف والقوالب (6-أ/6-ب): البذر والاختيار', () => {
  it('يبذر التصنيفات السبعة (بعد دمج الطلبات الدراسية) والقوالب الثمانية', async () => {
    const h = await newMonitoredUser();
    const classifications = await h.api.get('/api/v1/telegram/classifications');
    assert.equal(classifications.status, 200);
    const list = (classifications.body as { classifications: { name: string }[] }).classifications;
    assert.equal(list.length, 7);
    assert.ok(list.some((item) => item.name === 'غير مصنف'));
    // 0026: دُمجت تصنيفات الطلبات الدراسية الأربعة في تصنيف واحد شامل.
    assert.ok(list.some((item) => item.name === 'خدمات طلابية'));
    for (const merged of ['طلبات المساعدة الدراسية', 'واجبات واختبارات', 'مشاريع جامعية', 'خدمات']) {
      assert.ok(!list.some((item) => item.name === merged), `التصنيف «${merged}» يجب أن يكون قد دُمج`);
    }

    const templates = await h.api.get('/api/v1/telegram/templates');
    const body = templates.body as { templates: { name: string; fields: unknown[]; isDefault: boolean }[] };
    // SEED_VERSION 2: أُضيف «الخدمات الطلابية» ليكون للتصنيف الموحّد قالب يخصّه.
    assert.equal(body.templates.length, 8);
    assert.ok(body.templates.some((template) => template.name === 'الخدمات الطلابية'));
    assert.ok(body.templates.every((template) => template.fields.length >= 5));
    assert.equal(body.templates.filter((template) => template.isDefault).length, 1);
  });

  it('يصنّف الرسالة ويختار قالب تصنيفها المبذور ويخزّنهما', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 200, text: 'أبحث عن شقة للإيجار في صنعاء' });
    const identityId = await firstResult(h.api);
    const detail = await detailOf(h.api, identityId);
    assert.equal(detail.message.state, 'processed');
    assert.equal(detail.message.classificationName, 'عقارات');
    assert.equal(detail.message.classification.origin, 'automatic');
    // SEED_VERSION 2: رُبط كل تصنيف بقالبه عند البذر، فصار القالب «العقارات» لا الافتراضي.
    assert.equal(detail.message.templateName, 'العقارات');
    assert.equal(detail.message.resolvedBy, 'classification');

    const counters = await server.sql<{ classified_count: string }>(
      'select classified_count::text from telegram_sources where id = $1',
      [h.sourceId],
    );
    assert.equal(counters.rows[0]!.classified_count, '1');
  });

  it('يعلّم المراجعة عند تعدّد التصنيفات المطابقة (Q7 + O02)', async () => {
    const h = await newMonitoredUser();
    // غموض حقيقي: عقار مطلوب لشركة ⇒ يطابق «عقارات» و«وظائف وفرص عمل» معاً.
    await emit(h, { messageId: 201, text: 'مطلوب شقة للإيجار لشركة' });
    const identityId = await firstResult(h.api);
    const detail = await detailOf(h.api, identityId);
    assert.ok(
      ['عقارات', 'وظائف وفرص عمل'].includes(String(detail.message.classificationName)),
      `الفائز من المتنافسين: ${detail.message.classificationName}`,
    );
    assert.equal(detail.message.classificationAmbiguous, true, 'تعدّد المطابقات مسجَّل');
    assert.equal(detail.message.reviewState, 'needs_review');
  });

  it('لا يعلّم المراجعة لطلب متخصص واضح (لا منافس للتصنيف العام)', async () => {
    const h = await newMonitoredUser();
    // كان هذا النص سابقاً يُحجز خطأً لأن «طلبات عامة» كان ينافس «وظائف وفرص عمل».
    await emit(h, { messageId: 202, text: 'مطلوب مبرمج بخبرة سنتين للعمل' });
    const detail = await detailOf(h.api, await firstResult(h.api));
    assert.equal(detail.message.classificationName, 'وظائف وفرص عمل');
    assert.equal(detail.message.classificationAmbiguous, false);
    assert.equal(detail.message.reviewState, 'none', 'طلب واضح لا يُحجز للمراجعة');
  });
});

describe('مُحدِّد القالب (6-ب): الأولويات مطبَّقة عبر الـAPI', () => {
  it('ربط القالب بالتصنيف يتقدّم على الافتراضي', async () => {
    const h = await newMonitoredUser();
    const template = await templateByName(h.api, 'العقارات');
    const classification = await classificationByName(h.api, 'عقارات');
    const bound = await h.api.request(`/api/v1/telegram/templates/${template.id}/bindings`, {
      method: 'PUT',
      body: { classificationIds: [classification.id] },
    });
    assert.equal(bound.status, 200, JSON.stringify(bound.body));

    await emit(h, { messageId: 210, text: 'شقة للإيجار في حدة، المساحة 120 متر' });
    const detail = await detailOf(h.api, await firstResult(h.api));
    assert.equal(detail.message.templateName, 'العقارات');
    assert.equal(detail.message.resolvedBy, 'classification');
  });

  it('تخصيص المصدر يتقدّم على ربط التصنيف والفلتر', async () => {
    const h = await newMonitoredUser();
    const bySource = await templateByName(h.api, 'الوظائف');
    const byClassification = await templateByName(h.api, 'العقارات');
    const classification = await classificationByName(h.api, 'عقارات');

    const classificationBinding = await h.api.request(`/api/v1/telegram/templates/${byClassification.id}/bindings`, {
      method: 'PUT',
      body: { classificationIds: [classification.id] },
    });
    assert.equal(classificationBinding.status, 200);

    const sourceBinding = await h.api.request(`/api/v1/telegram/templates/${bySource.id}/bindings`, {
      method: 'PUT',
      body: { sourceIds: [h.sourceId] },
    });
    assert.equal(sourceBinding.status, 200);

    await emit(h, { messageId: 211, text: 'شقة للإيجار في حدة' });
    const detail = await detailOf(h.api, await firstResult(h.api));
    assert.equal(detail.message.resolvedBy, 'source');
    assert.equal(detail.message.templateName, 'الوظائف');
  });

  it('تغيير القالب الافتراضي يؤثر على الرسائل التي لا ربط لتصنيفها', async () => {
    const h = await newMonitoredUser();
    // البذور تربط «عقارات» بقالبه؛ نُلغي الربط صراحةً لاختبار مستوى «الافتراضي».
    const bound = await templateByName(h.api, 'العقارات');
    const cleared = await h.api.request(`/api/v1/telegram/templates/${bound.id}/bindings`, {
      method: 'PUT',
      body: { classificationIds: [] },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    const target = await templateByName(h.api, 'البيع والشراء');
    const changed = await h.api.post('/api/v1/telegram/templates/default', { templateId: target.id });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    await emit(h, { messageId: 212, text: 'أبحث عن شقة للإيجار' });
    const detail = await detailOf(h.api, await firstResult(h.api));
    assert.equal(detail.message.templateName, 'البيع والشراء');
    assert.equal(detail.message.resolvedBy, 'default');
  });
});

describe('المعاينة والحذف والحجب (6-ب)', () => {
  it('المعاينة تحذف الحقول الغائبة وتحفظ ترتيب القالب', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 220, text: 'أبحث عن شقة للإيجار\nالموقع: حدة\nالسعر: 500 دولار' });
    const detail = await detailOf(h.api, await firstResult(h.api));
    const rendered = detail.rendered;
    // التسميات من قالب «العقارات» (المبذور والمربوط بتصنيفه): المنطقة / السعر.
    assert.ok(rendered.text.includes('المنطقة: حدة'), `المعاينة: ${rendered.text}`);
    assert.ok(rendered.text.includes('السعر: 500 دولار'), `المعاينة: ${rendered.text}`);
    // حقول القالب بلا قيم («نوع العقار»، «نوع العملية»، «المساحة»، «المواصفات»، «رقم التواصل») تُحذف.
    assert.deepEqual(
      rendered.missingFields.map((field) => field.key).sort(),
      ['area_size', 'contact', 'request_type', 'role', 'specs'],
      'لا تُكتب قيم افتراضية للحقول الغائبة',
    );
    const ordering = rendered.fields.map((field) => field.key).join(',');
    assert.equal(ordering, 'location,budget', `الترتيب من القالب — الفعلي: ${ordering}`);
  });

  it('تعديل القالب (تسمية/ترتيب/تعطيل) ينعكس على المعاينة', async () => {
    const h = await newMonitoredUser();
    const template = await templateByName(h.api, 'العقارات');
    const patched = await h.api.patch(`/api/v1/telegram/templates/${template.id}`, {
      fields: [
        { fieldKey: 'location', label: 'الحي' },
        { fieldKey: 'budget', label: 'الميزانية المتوقعة' },
        { fieldKey: 'details', label: 'التفاصيل', enabled: false },
      ],
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    await emit(h, { messageId: 221, text: 'أبحث عن شقة للإيجار\nالموقع: حدة\nالسعر: 500 دولار' });
    const detail = await detailOf(h.api, await firstResult(h.api));
    assert.ok(detail.rendered.text.startsWith('الحي: حدة'));
    assert.ok(detail.rendered.text.includes('الميزانية المتوقعة: 500 دولار'));
    assert.deepEqual(
      detail.rendered.fields.map((field) => field.key),
      ['location', 'budget'],
      'الحقل المعطّل لا يظهر',
    );
  });

  it('قيم التواصل محجوبة في كل مكان: لا رقم خام في التفاصيل ولا في المعاينة', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 222, text: 'أبحث عن شقة للإيجار\nللتواصل: 0771234567 أو @ahmed_dev' });
    const detail = await detailOf(h.api, await firstResult(h.api));

    assert.ok(detail.contacts.length >= 2);
    for (const contact of detail.contacts) {
      assert.ok(contact.masked.includes('•'), 'كل قيمة تواصل محجوبة');
    }
    const serialized = JSON.stringify(detail);
    assert.ok(!serialized.includes('0771234567'), 'لا رقم خام في أي جزء من الاستجابة');
    assert.ok(!serialized.includes('ahmed_dev'), 'لا اسم مستخدم خام');
    assert.ok(detail.originalText!.includes('•••'), 'النص الأصلي يُعاد مقنَّعاً');
  });
});

describe('المراجعة والتعديل اليدوي (6-أ + O02)', () => {
  it('التعديل اليدوي يغلب في العرض ويحفظ التصنيف التلقائي', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 230, text: 'أبحث عن شقة للإيجار في صنعاء' });
    const identityId = await firstResult(h.api);
    const before = await detailOf(h.api, identityId);
    assert.equal(before.message.classification.origin, 'automatic');

    const target = await classificationByName(h.api, 'بيع وشراء');
    const override = await h.api.post(`/api/v1/telegram/results/${identityId}/classification`, {
      classificationId: target.id,
    });
    assert.equal(override.status, 200, JSON.stringify(override.body));

    const after_ = await detailOf(h.api, identityId);
    assert.equal(after_.message.classificationName, 'بيع وشراء');
    assert.equal(after_.message.classification.origin, 'manual');
    assert.equal(after_.message.classification.confidence, 1);
    assert.equal(after_.message.classification.automatic?.name, 'عقارات', 'التلقائي محفوظ للتدقيق');
    assert.equal(after_.message.reviewState, 'reviewed', 'التعديل اليدوي يعني مراجعة');

    const cleared = await h.api.post(`/api/v1/telegram/results/${identityId}/classification`, {
      classificationId: null,
    });
    assert.equal(cleared.status, 200);
    const restored = await detailOf(h.api, identityId);
    assert.equal(restored.message.classification.origin, 'automatic');
    assert.equal(restored.message.classificationName, 'عقارات');
  });

  it('قائمة المراجعة تُصفّي حسب الحالة', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 231, text: 'مطلوب شقة للإيجار لشركة' }); // غامض: عقارات + وظائف
    await emit(h, { messageId: 232, text: 'مطلوب مبرمج بخبرة سنتين' }); // واضح: وظائف

    const needsReview = await listResults(h.api, '?review=needs_review');
    assert.ok(needsReview.results.length >= 1);
    assert.ok(needsReview.results.every((row) => row.reviewState === 'needs_review'));

    const reviewed = await listResults(h.api, '?review=reviewed');
    assert.equal(reviewed.results.length, 0);

    const target = needsReview.results[0]!.identityId;
    const marked = await h.api.post(`/api/v1/telegram/results/${target}/review`, { reviewState: 'reviewed' });
    assert.equal(marked.status, 200);
    const after_ = await listResults(h.api, '?review=reviewed');
    assert.equal(after_.results.length, 1);
  });

  it('يرفض تصنيفاً لا يملكه المستخدم', async () => {
    const first = await newMonitoredUser();
    const second = await newMonitoredUser();
    await emit(first, { messageId: 233, text: 'أبحث عن شقة للإيجار' });
    const identityId = await firstResult(first.api);
    const foreign = await classificationByName(second.api, 'بيع وشراء');
    const attempt = await first.api.post(`/api/v1/telegram/results/${identityId}/classification`, {
      classificationId: foreign.id,
    });
    assert.equal(attempt.status, 404, 'تصنيف مستخدم آخر غير مقبول');
  });
});

describe('العزل والاحتفاظ', () => {
  it('لا يرى المستخدم نتائج غيره', async () => {
    const first = await newMonitoredUser();
    const second = await newMonitoredUser();
    await emit(first, { messageId: 240, text: 'أبحث عن شقة للإيجار' });
    const identityId = await firstResult(first.api);

    const list = await listResults(second.api);
    assert.equal(list.results.length, 0);
    const detail = await second.api.get(`/api/v1/telegram/results/${identityId}`);
    assert.equal(detail.status, 404);
    const review = await second.api.post(`/api/v1/telegram/results/${identityId}/review`, {
      reviewState: 'reviewed',
    });
    assert.equal(review.status, 404);
  });

  it('انتهاء احتفاظ المحتوى يحذف النتائج ويُعلّم التفاصيل بغيابها', async () => {
    const h = await newMonitoredUser();
    await emit(h, { messageId: 241, text: 'أبحث عن شقة للإيجار\nالموقع: حدة\nللتواصل: 0771234567' });
    const identityId = await firstResult(h.api);
    assert.ok((await detailOf(h.api, identityId)).fields.length > 0);

    await server.sql(
      "update message_content set retention_expires_at = now() - interval '1 hour' where identity_id = $1",
      [identityId],
    );
    const { PgMessageProcessingStore } = await import('../src/modules/processing/messageProcessingRepository.js');
    await new PgMessageProcessingStore().purgeExpiredContent();

    const detail = await detailOf(h.api, identityId);
    assert.equal(detail.originalText, null, 'المحتوى محذوف');
    assert.deepEqual(detail.fields, [], 'الحقول محذوفة');
    assert.deepEqual(detail.contacts, [], 'التواصل محذوف');
    assert.equal(detail.message.classificationName, null, 'التصنيف نتيجة محذوفة أيضاً');
    assert.equal(detail.message.templateName, null);
    assert.equal(detail.message.contentAvailable, false);
    assert.equal(detail.message.state, 'processed', 'سجل الهوية يبقى');
  });
});
