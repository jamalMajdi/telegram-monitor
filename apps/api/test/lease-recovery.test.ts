/**
 * تدقيق 2026-11-26 — اختبار «اللُّقية المنتهية» ومنع النشر المكرر.
 *
 * **الخلل الذي كان قائماً:** عند انتهاء لُقية جزء حالته `sending` كان يُعاد `pending` مباشرة.
 * فلو أرسل العامل الجزء فعلاً ثم سقط قبل `markPartSent` (نشرة/إعادة تشغيل/OOM)، أعاده عامل
 * آخر ⇒ **منشور مكرر في القناة الوجهة**، خلافاً لقاعدة O04 («المجهول لا يُعاد تلقائياً»).
 *
 * **القاعدة بعد الإصلاح:**
 *   - محاولة مفتوحة (`outcome = 'started'`) ⇒ الطلب قد يكون وصل ⇒ الجزء والتسليم `uncertain`،
 *     والمحاولة تُغلق `lease_expired_unknown`، ولا استحواذ عليه مرة أخرى.
 *   - بلا أي محاولة ⇒ لم يُرسَل شيء قطعاً ⇒ يعود `pending` ويُستأنف بأمان.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import type { DeliveryPlanner } from '../src/modules/publishing/deliveryPlanner.js';
import { DeliveryPlanner as DeliveryPlannerClass } from '../src/modules/publishing/deliveryPlanner.js';
import { PgDeliveryStore } from '../src/modules/publishing/deliveryStore.js';

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;
let planner: DeliveryPlanner;
const store = new PgDeliveryStore();

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

async function deliveryOf(identityId: string): Promise<{ id: string; status: string }> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const res = await server.sql<{ id: string; status: string }>(
      'select id, status from deliveries where identity_id = $1',
      [identityId],
    );
    if (res.rows.length > 0) return res.rows[0]!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('لم يُنشأ أي تسليم خلال المهلة');
}

async function planned(h: ScenarioHarness, text: string): Promise<{ deliveryId: string; partId: string; attemptNo: number }> {
  const identityId = await scenario.emit(h, text);
  const delivery = await deliveryOf(identityId);
  await h.api.post(`/api/v1/telegram/publish/deliveries/${delivery.id}/approve`, {}).catch(() => undefined);
  const result = await planner.plan(delivery.id, h.userId);
  assert.equal(result.ok, true, `تعذّر التخطيط: ${result.ok === false ? result.reason : ''}`);
  const part = await server.sql<{ id: string }>(
    'select id from delivery_parts where delivery_id = $1 order by part_index limit 1',
    [delivery.id],
  );
  return { deliveryId: delivery.id, partId: part.rows[0]!.id, attemptNo: 1 };
}

/** يضع الجزء والتسليم في حالة «قيد الإرسال بلُقية منتهية» كما يحدث عند سقوط عامل. */
async function expireLease(input: { deliveryId: string; partId: string }): Promise<void> {
  await server.sql(
    `update delivery_parts
        set status = 'sending', lease_owner = 'dead-worker', lease_expires_at = now() - interval '2 minutes',
            attempts = 1
      where id = $1`,
    [input.partId],
  );
  await server.sql(
    `update deliveries
        set status = 'sending', lease_owner = 'dead-worker', lease_expires_at = now() - interval '2 minutes'
      where id = $1`,
    [input.deliveryId],
  );
}

describe('اللُّقية المنتهية — لا نشر مكرر', () => {
  it('محاولة مفتوحة ⇒ uncertain (لا إعادة إرسال) وتُغلق المحاولة بالرمز الصحيح', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    const target = await planned(h, 'مطلوب مبرمج — تدقيق اللُّقية (محاولة مفتوحة)');
    await expireLease(target);

    // العامل سقط بعد فتح المحاولة: قد يكون المنشور وصل فعلاً.
    await server.sql(
      `insert into delivery_attempts (delivery_id, part_id, attempt_no, outcome)
       values ($1, $2, $3, 'started')`,
      [target.deliveryId, target.partId, target.attemptNo],
    );

    await store.recoverExpiredLeases();

    const part = await server.sql<{ status: string; last_error_code: string | null }>(
      'select status::text as status, last_error_code from delivery_parts where id = $1',
      [target.partId],
    );
    assert.equal(part.rows[0]!.status, 'uncertain', 'الجزء لا يعود pending');
    assert.equal(part.rows[0]!.last_error_code, 'lease_expired_unknown');

    const delivery = await server.sql<{ status: string }>(
      'select status::text as status from deliveries where id = $1',
      [target.deliveryId],
    );
    assert.equal(delivery.rows[0]!.status, 'uncertain', 'التسليم نتيجة مجهولة تنتظر دليلاً بشرياً');

    const attempt = await server.sql<{ outcome: string; error_code: string | null; finished_at: Date | null }>(
      'select outcome::text as outcome, error_code, finished_at from delivery_attempts where part_id = $1',
      [target.partId],
    );
    assert.equal(attempt.rows[0]!.outcome, 'uncertain', 'المحاولة تُغلق ولا تبقى started');
    assert.equal(attempt.rows[0]!.error_code, 'lease_expired_unknown');
    assert.ok(attempt.rows[0]!.finished_at, 'المحاولة لها وقت انتهاء');

    // ولا يعود العامل يستحوذ عليه: لا إرسال مكرر بأي حال.
    const claim = await store.claimPart('worker-after-recovery', 90_000, { userId: h.userId });
    assert.equal(claim, null, 'لا استحواذ على جزء نتيجة مجهولة');
  });

  it('بلا أي محاولة ⇒ يعود يعمل بأمان (استعادة سريعة بلا إسقاط)', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    const target = await planned(h, 'مطلوب مبرمج — تدقيق اللُّقية (بلا محاولة)');
    await expireLease(target);

    await store.recoverExpiredLeases();

    const part = await server.sql<{ status: string }>('select status::text as status from delivery_parts where id = $1', [
      target.partId,
    ]);
    assert.equal(part.rows[0]!.status, 'pending', 'لا طلب HTTP حدث ⇒ آمن للاستئناف');

    const delivery = await server.sql<{ status: string }>(
      'select status::text as status from deliveries where id = $1',
      [target.deliveryId],
    );
    assert.equal(delivery.rows[0]!.status, 'queued', 'التسليم يعود للطابور');

    const claim = await store.claimPart('worker-after-recovery', 90_000, { userId: h.userId });
    assert.ok(claim, 'الجزء صار قابلاً للاستحواذ من جديد');
    assert.equal(claim!.partId, target.partId);
  });

  it('جزء أُرسل فعلاً وبقي `sending` لا يعود للطابور ولو كان التسليم بلا أجزاء مرسلة', async () => {
    const h = await scenario.create();
    await scenario.route(h);
    const target = await planned(h, 'مطلوب مبرمج — تدقيق اللُّقية (أُرسل ثم سقط العامل)');
    await expireLease(target);
    await server.sql(
      `insert into delivery_attempts (delivery_id, part_id, attempt_no, outcome, http_status)
       values ($1, $2, $3, 'started', null)`,
      [target.deliveryId, target.partId, target.attemptNo],
    );

    // مرّتان متتاليتان: الاستعادة يجب ألا تُعيد الجزء pending في الدورة الثانية أيضاً.
    await store.recoverExpiredLeases();
    await store.recoverExpiredLeases();

    const part = await server.sql<{ status: string }>('select status::text as status from delivery_parts where id = $1', [
      target.partId,
    ]);
    assert.equal(part.rows[0]!.status, 'uncertain', 'الحالة مستقرة ولا تتقلّب بين الدورات');
  });
});
