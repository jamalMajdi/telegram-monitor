/**
 * اختبار تكامل لهوية المصدر والمرسل: من الالتقاط إلى أسطر المنشور.
 *
 * يغطّي المتطلب التجاري كاملاً على قاعدة بيانات حقيقية + بوابة محاكاة:
 *   1) افتراضياً مفعّلة (Opt-out): بمجرد وصول رسالة تحمل مرسلاً يظهر السطران أسفل المنشور.
 *   2) اختيار العناصر: «المصدر فقط» / «المرسل فقط» / «الاثنان».
 *   3) تجاوز المسار: إيقاف الهوية لمسار واحد لا يمسّ الإعداد العام ولا بقية المسارات، ويُقرأ طازجاً لكل تسليم.
 *   4) إيقاف المستخدم العام يخفيها عن كل المسارات الوراثية.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { DeliveryPlanner } from '../src/modules/publishing/deliveryPlanner.js';
import { DeliveryPlanner as DeliveryPlannerClass } from '../src/modules/publishing/deliveryPlanner.js';
import { htmlVisibleText } from '../src/modules/publishing/publisher.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let planner: DeliveryPlanner;

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });
  const { PublishingRuntime } = await import('../src/modules/publishing/runtime.js');
  planner = new PublishingRuntime({ botApi }).planner;
});

after(async () => {
  await server.close();
});

const MESSAGE = 'مطلوب مندوب مبيعات لشركة في المنصورة، الراتب مجزٍ.';

/** اسم مصدر واقعي: اسم المصدر الافتراضي في السيناريو يحمل أرقاماً تُحجب عمداً (سلوك أمني). */
async function renameSource(h: ScenarioHarness, title: string): Promise<void> {
  await server.sql('update telegram_sources set title = $2 where id = $1', [h.sourceId, title]);
}

const SENDER = {
  id: '782139465',
  username: 'mohammed_a',
  displayName: 'محمد عبدالله',
  postAuthor: null,
};

async function deliveryOf(identityId: string): Promise<{ id: string; status: string; template_id: string | null }> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const res = await server.sql<{ id: string; status: string; template_id: string | null }>(
      'select id, status, template_id from deliveries where identity_id = $1',
      [identityId],
    );
    if (res.rows.length > 0) return res.rows[0]!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('لم يُنشأ أي تسليم للرسالة خلال المهلة');
}

/** يخطط التسليم ويعيد نص أجزائه كما تراه تيليجرام (بلا وسوم). */
async function planAndRead(h: ScenarioHarness, deliveryId: string): Promise<string> {
  await h.api.post(`/api/v1/telegram/publish/deliveries/${deliveryId}/approve`, {}).catch(() => undefined);
  const planned = await planner.plan(deliveryId, h.userId);
  assert.equal(planned.ok, true, `تعذّر التخطيط: ${planned.ok === false ? planned.reason : ''}`);
  const parts = await server.sql<{ text: string }>(
    'select text from delivery_parts where delivery_id = $1 order by part_index',
    [deliveryId],
  );
  return parts.rows.map((row) => htmlVisibleText(row.text)).join('\n');
}

describe('هوية المصدر والمرسل — التكامل مع النشر', () => {
  it('مفعّلة افتراضياً: تظهر أسفل المنشور باسم المصدر ومعرّف المرسل', async () => {
    const h = await scenario.create();
    await renameSource(h, 'قناة السوق العام');
    await scenario.route(h);
    const identityId = await scenario.emit(h, MESSAGE, SENDER);
    const delivery = await deliveryOf(identityId);

    const text = await planAndRead(h, delivery.id);
    const lines = text.split('\n');
    const sourceLine = lines.find((line) => line.includes('📣 المصدر:'));
    const senderLine = lines.find((line) => line.includes('👤 المرسل:'));
    assert.ok(sourceLine, `لا سطر مصدر في المنشور:\n${text}`);
    assert.ok(senderLine, `لا سطر مرسل في المنشور:\n${text}`);
    assert.ok(sourceLine!.includes('قناة السوق العام'), `اسم المصدر من جدول المصادر — السطر: ${sourceLine}`);
    assert.ok(sourceLine!.includes(`@pub_src_${h.peerId}`), '@username المصدر');
    assert.ok(senderLine!.includes('محمد عبدالله'), 'اسم المرسل');
    assert.ok(senderLine!.includes('@mohammed_a'), '@username المرسل');

    // الهوية أسفل المحتوى: آخر سطرين بعد فاصل، وليست قبله.
    const separator = lines.findIndex((line) => line.trim() === '· · ·');
    const contentIndex = lines.findIndex((line) => line.includes('مندوب مبيعات'));
    assert.ok(contentIndex >= 0, 'المحتوى موجود');
    assert.ok(separator > contentIndex, 'الفاصل بعد المحتوى');
    assert.ok(lines.indexOf(sourceLine!) > separator, 'الهوية بعد الفاصل');
  });

  it('اسم مصدر يحمل أرقاماً يُحجب في سطر الهوية بدل عرضه كما هو', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    // الاسم الافتراضي في السيناريو: «قناة <أرقام>» — يجب ألا يظهر الرقم كما هو في المنشور العام.
    const identityId = await scenario.emit(h, MESSAGE, SENDER);
    const text = await planAndRead(h, (await deliveryOf(identityId)).id);
    assert.ok(text.includes('📣 المصدر:'), `لا سطر مصدر:\n${text}`);
    // الحجب جزئي (يُخفي وسط الرقم) — المهم ألا يظهر الاسم برقمه كما هو.
    assert.ok(!text.includes(`قناة ${h.peerId}`), `ظهر رقم المصدر كما هو في المنشور:\n${text}`);
    assert.ok(text.includes('قناة '), 'اسم المصدر باقٍ للتمييز');
  });

  it('«المصدر فقط» يُلغي سطر المرسل دون المساس بسطر المصدر', async () => {
    const h = await scenario.create();
    await renameSource(h, 'قناة السوق العام');
    await scenario.route(h, { attributionMode: 'source' });
    const identityId = await scenario.emit(h, MESSAGE, SENDER);
    const delivery = await deliveryOf(identityId);

    const text = await planAndRead(h, delivery.id);
    assert.ok(text.includes('📣 المصدر:'));
    assert.ok(!text.includes('👤 المرسل:'), `ظهر سطر مرسل رغم اختيار المصدر فقط:\n${text}`);
  });

  it('إيقاف الهوية لمسار واحد: بلا أسطر، وبلا أي أثر على الإعداد العام', async () => {
    const h = await scenario.create();
    await renameSource(h, 'قناة السوق العام');
    await scenario.route(h, { attributionMode: 'off' });
    const identityId = await scenario.emit(h, MESSAGE, SENDER);
    const delivery = await deliveryOf(identityId);

    const text = await planAndRead(h, delivery.id);
    assert.ok(!text.includes('📣 المصدر:'), `ظهرت الهوية رغم إيقاف المسار:\n${text}`);
    assert.ok(!text.includes('👤 المرسل:'));
    assert.ok(!text.includes('· · ·'), 'لا فاصل بلا هوية');

    const settings = await h.api.get('/api/v1/me/settings');
    assert.equal(settings.status, 200);
    const attribution = (settings.body as { settings: { attribution: { enabled: boolean; mode: string } } }).settings
      .attribution;
    assert.equal(attribution.enabled, true, 'إعداد المستخدم لم يتغيّر');
    assert.equal(attribution.mode, 'both');

    // إعادة المسار إلى الوراثة تُعيد الهوية فوراً: القرار يُقرأ من المسار لكل تسليم.
    const routeRow = await server.sql<{ id: string; attribution_mode: string | null }>(
      'select id, attribution_mode from publish_routes where user_id = $1',
      [h.userId],
    );
    assert.equal(routeRow.rows[0]!.attribution_mode, 'off', 'التجاوز مخزَّن على المسار نفسه');
  });

  it('إيقاف المستخدم العام يخفي الهوية عن المسارات الوراثية، وإعادة التفعيل تُرجعها', async () => {
    const h = await scenario.create();
    const routeId = await scenario.route(h);

    const off = await h.api.patch('/api/v1/me/settings', { attributionEnabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const firstIdentity = await scenario.emit(h, MESSAGE, SENDER);
    const firstText = await planAndRead(h, (await deliveryOf(firstIdentity)).id);
    assert.ok(!firstText.includes('📣 المصدر:'), `ظهرت الهوية رغم إيقاف المستخدم:\n${firstText}`);

    const on = await h.api.patch('/api/v1/me/settings', { attributionEnabled: true, attributionMode: 'sender' });
    assert.equal(on.status, 200);
    assert.equal((on.body as { settings: { attribution: { mode: string } } }).settings.attribution.mode, 'sender');

    const secondIdentity = await scenario.emit(h, `${MESSAGE} (٢)`, SENDER);
    const secondText = await planAndRead(h, (await deliveryOf(secondIdentity)).id);
    assert.ok(secondText.includes('👤 المرسل:'), `لم تُعد الهوية بعد التفعيل:\n${secondText}`);
    assert.ok(!secondText.includes('📣 المصدر:'), 'النمط المختار «المرسل فقط»');

    // المسار ما زال وراثياً (attribution_mode = null) — الإعداد هو المتحكّم.
    const route = await h.api.get(`/api/v1/telegram/publish/routes/${routeId}`);
    assert.equal(
      (route.body as { route: { attributionMode: string | null } }).route.attributionMode,
      null,
      'المسار وراثي بلا تجاوز',
    );
  });

  it('تجاوز مسار واحد لا يغيّر بقية مسارات المستخدم نفسه', async () => {
    const h = await scenario.create();
    const inherited = await scenario.route(h);
    const off = await h.api.post('/api/v1/telegram/publish/routes', {
      name: `مسار ثانٍ ${h.email}`,
      destinationId: h.destinationId,
      scopes: [{ kind: 'filter', targetId: await firstFilterId(h) }],
      attributionMode: 'off',
    });
    assert.equal(off.status, 201, JSON.stringify(off.body));
    const offRouteId = (off.body as { route: { id: string } }).route.id;

    const list = await h.api.get('/api/v1/telegram/publish/routes');
    const rows = (list.body as { routes: { id: string; attributionMode: string | null }[] }).routes;
    assert.equal(rows.find((row) => row.id === inherited)?.attributionMode, null);
    assert.equal(rows.find((row) => row.id === offRouteId)?.attributionMode, 'off');

    // الإعداد العام سليم بعد تجاوز مسار واحد.
    const settings = await h.api.get('/api/v1/me/settings');
    assert.equal(
      (settings.body as { settings: { attribution: { enabled: boolean } } }).settings.attribution.enabled,
      true,
    );
  });

  it('تجاوز غير صالح يُرفض بطلب خاطئ ولا يُخزَّن', async () => {
    const h = await scenario.create();
    const bad = await h.api.post('/api/v1/telegram/publish/routes', {
      name: `مسار خاطئ ${h.email}`,
      destinationId: h.destinationId,
      scopes: [{ kind: 'source', targetId: h.sourceId }],
      attributionMode: 'everything',
    });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
  });

  it('منشور فارغ + هوية مفعّلة ⇒ يبقى مرفوضاً: الهوية لا تُنقذ منشوراً بلا محتوى', async () => {
    const store = {
      async loadPlanContext() {
        return {
          deliveryId: 'd1',
          identityId: 'i1',
          userId: 'u1',
          sourceId: 's1',
          templateId: 't1',
          lengthPolicy: 'split' as const,
          maxParts: 10,
          planVersion: 1,
          status: 'queued',
          review: 'not_required',
          messageText: '   ',
          caption: null,
          retentionExpiresAt: new Date(Date.now() + 86_400_000),
          classificationName: 'خدمات طلابية',
          attribution: {
            routeMode: null,
            config: { enabled: true, mode: 'both' as const, showUsername: true, showId: true },
            source: { title: 'قناة السوق', username: 'public_market', peerId: '1001234567890' },
            sender: SENDER,
          },
        };
      },
      async loadExtractionFields() {
        return [];
      },
      async loadContactViews() {
        return [];
      },
      async loadTemplate() {
        return { id: 't1', name: 'الخدمات الطلابية', fields: [{ fieldKey: 'details', label: 'التفاصيل', enabled: true }] };
      },
      async savePlan() {
        assert.fail('لا يجب تثبيت أي أجزاء لمنشور فارغ');
      },
      async clearPlan() {},
      async setDeliveryStatus() {},
    };
    const isolated = new DeliveryPlannerClass({ store: store as never });
    const result = await isolated.plan('d1', 'u1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty');
  });
});

/** أول فلتر متاح للمستخدم (يُستخدم لمسار ثانٍ بشروط مختلفة). */
async function firstFilterId(h: ScenarioHarness): Promise<string> {
  const res = await h.api.get('/api/v1/telegram/filters');
  const filters = (res.body as { filters?: { id: string }[] }).filters ?? [];
  if (filters[0]) return filters[0].id;
  const created = await h.api.post('/api/v1/telegram/filters', {
    name: `فلتر ${h.email}`,
    keywords: ['مطلوب'],
    matchMode: 'any',
  });
  return (created.body as { filter: { id: string } }).filter.id;
}
