/**
 * اختبارات إعادة النشر (P4-هـ، Q20) — الصرامة أولاً.
 *
 * الثوابت التي يفحصها هذا الملف:
 * 1) `uncertain` **ممنوعة منعاً باتاً**: لا خطة جديدة قبل دليل بشري، والرفض برمز صريح.
 * 2) المسموح فقط: `failed` / `cancelled` / `blocked`.
 * 3) السقف 3، والرابع مرفوض.
 * 4) إعادة النشر إعادة **تخطيط** لا إرسالاً مباشراً: الأجزاء تُبنى من جديد، والنسخة ترتفع،
 *    والموافقة القديمة تُبطَل، والحدث يُدقَّق.
 * 5) لا يرى أحد تسليم غيره (404).
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

const TEXT = 'مطلوب مبرمج خبرة سنتين للعمل في شركة تقنية، للتواصل 777123456';

before(async () => {
  const fakes = await import('./publish-fakes.js');
  gateway = new FakeGateway();
  botApi = new fakes.FakeBotApiClient();
  server = await startTestServer({ telegramGateway: gateway, botApiClient: botApi, logLevel: 'silent' });
  scenario = new PublishScenario({ server, gateway, botApi, makeToken: fakes.fakeBotToken });
});

after(async () => {
  await server.close();
});

interface DeliveryState {
  id: string;
  status: string;
  republish: { allowed: boolean; reason: string | null; remaining: number };
  republishCount: number;
}

/** مستخدم بمسار فعّال ورسالة واحدة ⇒ تسليم واحد بخطة جاهزة. */
async function withDelivery(): Promise<{ h: ScenarioHarness; deliveryId: string; identityId: string }> {
  const h = await scenario.create();
  await scenario.route(h);
  const identityId = await scenario.emit(h, TEXT);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = await server.sql<{ id: string }>('select id from deliveries where identity_id = $1', [identityId]);
    if (row.rows.length > 0) return { h, deliveryId: row.rows[0]!.id, identityId };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('لم يُنشأ تسليم في الوقت المتوقع');
}

async function setStatus(deliveryId: string, status: string, extra = ''): Promise<void> {
  await server.sql(`update deliveries set status = $2::delivery_status ${extra} where id = $1`, [deliveryId, status]);
}

async function detail(h: ScenarioHarness, deliveryId: string): Promise<DeliveryState> {
  const res = await h.api.get(`/api/v1/telegram/publish/deliveries/${deliveryId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body as { delivery: DeliveryState }).delivery;
}

describe('إعادة النشر: ما يُسمح وما يُمنع', () => {
  it('ترفض `uncertain` دائماً وبرمز صريح — لا خطة قبل دليل بشري', async () => {
    const { h, deliveryId } = await withDelivery();
    await setStatus(deliveryId, 'uncertain');

    const res = await h.api.post(`/api/v1/telegram/publish/deliveries/${deliveryId}/republish`);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    const error = (res.body as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'republish_uncertain_forbidden');
    assert.ok(error.message.includes('دليل'), 'الرسالة تشرح البديل: دليل بشري');

    // الحالة لم تتغيّر: لا خطة جديدة ولا عدّاد مرفوع.
    const row = await server.sql<{ status: string; republish_count: number }>(
      'select status::text as status, republish_count from deliveries where id = $1',
      [deliveryId],
    );
    assert.equal(row.rows[0]?.status, 'uncertain');
    assert.equal(row.rows[0]?.republish_count, 0);

    const audit = await server.sql("select 1 from audit_events where action = 'publishing.delivery_republished'");
    assert.equal(audit.rowCount, 0, 'لا تدقيق نجاح لعملية مرفوضة');
  });

  it('ترفض ما ليس في (failed, cancelled, blocked)', async () => {
    const cases: { status: string; code: string }[] = [
      { status: 'published', code: 'delivery_not_republishable' },
      { status: 'queued', code: 'delivery_not_republishable' },
      { status: 'sending', code: 'delivery_not_republishable' },
      { status: 'awaiting_review', code: 'delivery_not_republishable' },
      { status: 'partial', code: 'delivery_not_republishable' },
    ];
    for (const item of cases) {
      const { h, deliveryId } = await withDelivery();
      await setStatus(deliveryId, item.status, ', review = \'not_required\', approved_version = plan_version');
      const res = await h.api.post(`/api/v1/telegram/publish/deliveries/${deliveryId}/republish`);
      assert.equal(res.status, 409, `${item.status} ⇒ 409`);
      assert.equal((res.body as { error: { code: string } }).error.code, item.code);
    }
  });

  it('تسمح بالثلاثة المسموحة وتُعيد بناء الخطة فعلاً', async () => {
    const { h, deliveryId } = await withDelivery();

    const beforeRow = await server.sql<{ plan_version: number; parts: number }>(
      `select d.plan_version, (select count(*)::int from delivery_parts p where p.delivery_id = d.id) as parts
         from deliveries d where d.id = $1`,
      [deliveryId],
    );
    assert.ok(Number(beforeRow.rows[0]?.parts) >= 1);

    await setStatus(deliveryId, 'failed', ", last_error_code = 'bot_forbidden'");
    const res = await h.api.post(`/api/v1/telegram/publish/deliveries/${deliveryId}/republish`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = (res.body as { delivery: DeliveryState }).delivery;
    assert.equal(after.republishCount, 1);
    assert.equal(after.republish.remaining, 2);
    assert.ok(['queued', 'awaiting_review'].includes(after.status), `الحالة بعد إعادة التخطيط: ${after.status}`);

    const row = await server.sql<{ plan_version: number; parts: number; last_error_code: string | null; republish_count: number }>(
      `select d.plan_version, d.last_error_code, d.republish_count,
              (select count(*)::int from delivery_parts p where p.delivery_id = d.id) as parts
         from deliveries d where d.id = $1`,
      [deliveryId],
    );
    assert.ok(row.rows[0]!.plan_version > Number(beforeRow.rows[0]!.plan_version), 'نسخة الخطة ترتفع');
    assert.ok(Number(row.rows[0]!.parts) >= 1, 'أجزاء جديدة مبنية من المصدر نفسه');
    assert.equal(row.rows[0]!.last_error_code, null, 'رمز الفشل القديم يُمسح بعد نجاح الإعادة');
    assert.equal(row.rows[0]!.republish_count, 1);

    const audit = await server.sql<{ metadata: { republishCount?: number; previousStatus?: string } }>(
      "select metadata from audit_events where action = 'publishing.delivery_republished' order by id desc limit 1",
    );
    assert.equal(audit.rows[0]?.metadata.republishCount, 1);
    assert.equal(audit.rows[0]?.metadata.previousStatus, 'failed');
  });

  it('تُبطل الموافقة القديمة عند إعادة التخطيط لمسار يطلب مراجعة', async () => {
    const { h, deliveryId } = await withDelivery();
    await server.sql(
      `update deliveries set review = 'approved', approved_version = plan_version, approved_at = now() where id = $1`,
      [deliveryId],
    );
    await setStatus(deliveryId, 'cancelled');

    const res = await h.api.post(`/api/v1/telegram/publish/deliveries/${deliveryId}/republish`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await server.sql<{ review: string; approved_version: number | null; status: string }>(
      'select review::text as review, approved_version, status::text as status from deliveries where id = $1',
      [deliveryId],
    );
    assert.equal(row.rows[0]?.review, 'pending', 'الموافقة القديمة أُبطلت');
    assert.equal(row.rows[0]?.approved_version, null);
    assert.equal(row.rows[0]?.status, 'awaiting_review', 'لا إرسال قبل موافقة جديدة');
  });

  it('تطبّق السقف: ثلاث إعادات، والرابعة مرفوضة، والقاعدة ترفض الرقم الرابع أيضاً', async () => {
    const { h, deliveryId } = await withDelivery();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await setStatus(deliveryId, 'failed');
      const res = await h.api.post(`/api/v1/telegram/publish/deliveries/${deliveryId}/republish`);
      assert.equal(res.status, 200, `الإعادة ${attempt}: ${JSON.stringify(res.body)}`);
      assert.equal((res.body as { delivery: DeliveryState }).delivery.republishCount, attempt);
    }

    const current = await detail(h, deliveryId);
    assert.equal(current.republish.allowed, false);
    assert.equal(current.republish.reason, 'limit_reached');
    assert.equal(current.republish.remaining, 0);

    await setStatus(deliveryId, 'failed');
    const fourth = await h.api.post(`/api/v1/telegram/publish/deliveries/${deliveryId}/republish`);
    assert.equal(fourth.status, 409);
    assert.equal((fourth.body as { error: { code: string } }).error.code, 'republish_limit_reached');

    // حتى لو حاول أحد تجاوز الـAPI: القيد في المخطط يرفض العدّاد الرابع.
    const raw = await server
      .sql('update deliveries set republish_count = 4 where id = $1', [deliveryId])
      .then(() => 'updated')
      .catch((err: Error) => err.message);
    assert.match(String(raw), /deliveries_republish_count_range/);
  });

  it('ترفض إعادة التخطيط بعد انتهاء احتفاظ المحتوى', async () => {
    const { h, deliveryId, identityId } = await withDelivery();
    await server.sql("update message_content set retention_expires_at = now() - interval '1 hour' where identity_id = $1", [
      identityId,
    ]);
    await setStatus(deliveryId, 'blocked');

    const res = await h.api.post(`/api/v1/telegram/publish/deliveries/${deliveryId}/republish`);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal((res.body as { error: { code: string } }).error.code, 'republish_content_expired');

    const row = await server.sql<{ republish_count: number }>(
      'select republish_count from deliveries where id = $1',
      [deliveryId],
    );
    assert.equal(row.rows[0]?.republish_count, 0, 'الفشل لا يستهلك عدّاد الإعادة');
  });

  it('لا يُعيد نشر تسليم مستخدم آخر (404) ويتطلب جلسة', async () => {
    const { deliveryId } = await withDelivery();
    const other = await scenario.create();
    const res = await other.api.post(`/api/v1/telegram/publish/deliveries/${deliveryId}/republish`);
    assert.equal(res.status, 404);

    const anonymous = await fetch(`${server.baseUrl}/api/v1/telegram/publish/deliveries/${deliveryId}/republish`, {
      method: 'POST',
    });
    assert.equal(anonymous.status, 401);
  });
});
