/**
 * سياسة التنبيهات (P4-و) — اختبار وحدة بلا قاعدة بيانات.
 *
 * المحاور: من يهمّه أي تنبيه، عتبة التصعيد، ترتيب الأولوية، خلّو الحمولات من أي نص حر،
 * وسلامة مؤشِّر الترقيم (ترميز/فك/رفض التالف).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNotificationDrafts,
  decodeCursor,
} from '../src/modules/notifications/notificationsService.js';
import type { DashboardCounts } from '../src/modules/dashboard/dashboardRepository.js';

function counts(overrides: {
  uncertain?: number;
  awaitingReview?: number;
  needsReauth?: number;
  sources?: number;
  activeDestinations?: number;
  totalDestinations?: number;
} = {}): DashboardCounts {
  return {
    telegram: {
      accounts: 1,
      active: 1,
      needsReauth: overrides.needsReauth ?? 0,
      lastConnectedAt: null,
    },
    sources: { total: overrides.sources ?? 1, active: overrides.sources ?? 1, paused: 0 },
    filters: { total: 1, active: 1 },
    templates: { total: 1 },
    destinations: {
      total: overrides.totalDestinations ?? overrides.activeDestinations ?? 1,
      active: overrides.activeDestinations ?? 1,
    },
    messages: { matchedTotal: 3, matchedLast24h: 3, processedTotal: 5, lastSeenAt: null },
    deliveries: {
      total: 2,
      awaitingReview: overrides.awaitingReview ?? 0,
      queued: 0,
      published: 1,
      publishedLast24h: 1,
      failed: 0,
      uncertain: overrides.uncertain ?? 0,
      blocked: 0,
    },
  };
}

const healthy = { state: 'ok' as const, lastSeenSeconds: 3 };
const thresholds = { uncertainThreshold: 3 };

describe('سياسة التنبيهات (P4-و)', () => {
  it('لا تنبيهات لحالة سليمة ومصدر ووجهة موجودان', () => {
    const drafts = buildNotificationDrafts({ counts: counts(), worker: healthy, thresholds });
    assert.deepEqual(drafts, []);
  });

  it('فشل الوجهات المتكرر: تحذير لوجهة، وحرج عند وجهتين (P0)', () => {
    // غياب المصدر ≠ صفر: لا تنبيه بلا حقيقة.
    const unknown = buildNotificationDrafts({ counts: counts(), worker: healthy, thresholds });
    assert.equal(unknown.some((d) => d.key === 'destination_failures'), false);

    const zero = buildNotificationDrafts({
      counts: counts(),
      worker: healthy,
      thresholds,
      failingDestinations: 0,
    });
    assert.equal(zero.some((d) => d.key === 'destination_failures'), false);

    const one = buildNotificationDrafts({
      counts: counts(),
      worker: healthy,
      thresholds,
      failingDestinations: 1,
    }).find((d) => d.key === 'destination_failures');
    assert.ok(one);
    assert.equal(one!.severity, 'warning');
    assert.equal(one!.observedCount, 1);
    assert.deepEqual(one!.payload, { destinations: 1, threshold: 3 });

    const two = buildNotificationDrafts({
      counts: counts(),
      worker: healthy,
      thresholds,
      failingDestinations: 2,
    }).find((d) => d.key === 'destination_failures');
    assert.equal(two!.severity, 'critical');
    assert.equal(two!.observedCount, 2);
  });

  it('النتيجة المجهولة تبدأ تحذيراً وتصعد حرجاً عند العتبة المضبوطة', () => {
    const warn = buildNotificationDrafts({
      counts: counts({ uncertain: 1 }),
      worker: healthy,
      thresholds,
    });
    assert.equal(warn.length, 1);
    assert.equal(warn[0]!.key, 'uncertain_delivery');
    assert.equal(warn[0]!.severity, 'warning');
    assert.equal(warn[0]!.observedCount, 1);

    const atThreshold = buildNotificationDrafts({
      counts: counts({ uncertain: 3 }),
      worker: healthy,
      thresholds,
    });
    assert.equal(atThreshold[0]!.severity, 'critical', 'بلوغ العتبة يصعد التنبيه');

    const custom = buildNotificationDrafts({
      counts: counts({ uncertain: 2 }),
      worker: healthy,
      thresholds: { uncertainThreshold: 2 },
    });
    assert.equal(custom[0]!.severity, 'critical', 'العتبة قابلة للضبط لا مضمّنة');
  });

  it('تعطّل العامل يخصّ من ينشر فقط، وتوقّفه الكامل حرج', () => {
    const withoutDestination = buildNotificationDrafts({
      counts: counts({ totalDestinations: 0, activeDestinations: 0 }),
      worker: { state: 'stale', lastSeenSeconds: 400 },
      thresholds,
    });
    assert.equal(
      withoutDestination.some((draft) => draft.key === 'publish_worker_stale'),
      false,
      'من لا ينشر لا يُزعج بتنبه نظام',
    );
    assert.ok(withoutDestination.some((draft) => draft.key === 'no_destination'));

    for (const state of ['stale', 'missing'] as const) {
      const drafts = buildNotificationDrafts({
        counts: counts(),
        worker: { state, lastSeenSeconds: state === 'stale' ? 400 : null },
        thresholds,
      });
      const worker = drafts.find((draft) => draft.key === 'publish_worker_stale');
      assert.ok(worker, `حالة ${state} يجب أن تُنبّه`);
      assert.equal(worker!.severity, 'critical');
    }
  });

  it('الحساب الذي يحتاج إعادة دخول حرج، والمراجعة المعلّقة تحذير', () => {
    const drafts = buildNotificationDrafts({
      counts: counts({ needsReauth: 2, awaitingReview: 4 }),
      worker: healthy,
      thresholds,
    });
    const byKey = new Map(drafts.map((draft) => [draft.key, draft]));
    assert.equal(byKey.get('needs_reauth')!.severity, 'critical');
    assert.equal(byKey.get('needs_reauth')!.observedCount, 2);
    assert.equal(byKey.get('awaiting_review')!.severity, 'warning');
    assert.equal(byKey.get('awaiting_review')!.observedCount, 4);
  });

  it('لا نص حر ولا مفاتيح غير مطابقة للقاموس المغلق', () => {
    const drafts = buildNotificationDrafts({
      counts: counts({ uncertain: 5, needsReauth: 1, awaitingReview: 2, sources: 0 }),
      worker: { state: 'missing', lastSeenSeconds: null },
      thresholds,
    });
    const allowedKeys = new Set([
      'publish_worker_stale',
      'uncertain_delivery',
      'needs_reauth',
      'awaiting_review',
      'no_source',
      'no_destination',
    ]);
    for (const draft of drafts) {
      assert.ok(allowedKeys.has(draft.key), `مفتاح غير معروف: ${draft.key}`);
      assert.match(draft.key, /^[a-z][a-z0-9_]{2,39}$/);
      // الحمولة: رقم/بوليان/null أو رمز مغلق قصير من قاموس الكود — لا جمل ولا أسماء ولا عربية.
      for (const value of Object.values(draft.payload)) {
        const closedSlug = typeof value === 'string' && /^[a-z_]{3,16}$/.test(value);
        assert.ok(
          value === null || typeof value === 'number' || typeof value === 'boolean' || closedSlug,
          `قيمة غير مسموحة في الحمولة: ${String(value)}`,
        );
      }
      assert.ok(JSON.stringify(draft.payload).length <= 400, 'الحمولة قابلة للتخزين بلا نص');
    }
    // لا تكرار لنفس المفتاح داخل مسح واحد (المخزن يعتمد على ذلك).
    const keys = drafts.map((draft) => draft.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('مؤشِّر الترقيم: يقرأ ما كتبه، ويرفض التالف', () => {
    const id = '5b0f0c3a-9f0e-4b6a-9a4e-0d3b9b7c1e21';
    const firstSeenAt = new Date('2026-11-24T10:00:00.000Z');
    const raw = Buffer.from(`n1|${firstSeenAt.toISOString()}|${id}`, 'utf8').toString('base64url');
    const decoded = decodeCursor(raw);
    assert.ok(decoded);
    assert.equal(decoded!.id, id);
    assert.equal(decoded!.firstSeenAt.toISOString(), firstSeenAt.toISOString());

    for (const bad of [
      '',
      'not-base64!!',
      Buffer.from('n2|2026-11-24T10:00:00.000Z|' + id).toString('base64url'),
      Buffer.from(`n1|not-a-date|${id}`).toString('base64url'),
      Buffer.from('n1|2026-11-24T10:00:00.000Z|not-a-uuid').toString('base64url'),
    ]) {
      assert.equal(decodeCursor(bad), null, `يجب رفض: ${bad.slice(0, 12)}`);
    }
  });
});
