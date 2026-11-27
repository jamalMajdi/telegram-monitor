/**
 * اختبارات وحدة لمحرك التوجيه وأدوات منع الحلقات — بلا قاعدة بيانات وبلا شبكة.
 *
 * تغطي: تجميع التسليمات لكل وجهة (D05)، أسبقية المراجعة (D01/Q4)، اختيار القالب (O02)،
 * هوية المحادثة الفنية، وقراءة حق النشر في القناة/المجموعة، وتطبيع معرّفات الوجهات.
 */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDestinationChatId, normalizeChatId, sourceChatId } from '../src/modules/publishing/loopGuard.js';
import { evaluateRights, normalizeIdentifier } from '../src/modules/publishing/destinationService.js';
import { planDeliveries } from '../src/modules/publishing/routingService.js';
import type { RoutingCandidateRow } from '../src/modules/publishing/publishRepository.js';

function candidate(overrides: Partial<RoutingCandidateRow> & { destinationId: string; routeId: string }): RoutingCandidateRow {
  return {
    templateId: null,
    publishMode: 'auto',
    lengthPolicy: 'split',
    maxParts: 10,
    destinationTitle: 'وجهة',
    ...overrides,
  };
}

describe('تخطيط التسليمات (D05)', () => {
  it('يدمج عدة مسارات إلى وجهة واحدة في تسليم واحد', () => {
    const plan = planDeliveries(
      [
        candidate({ destinationId: 'd1', routeId: 'r1', templateId: 't1' }),
        candidate({ destinationId: 'd1', routeId: 'r2', templateId: 't2' }),
        candidate({ destinationId: 'd2', routeId: 'r3', templateId: 't3' }),
      ],
      { resolvedTemplateId: 't0', messageNeedsReview: false },
    );
    assert.equal(plan.length, 2);
    const d1 = plan.find((item) => item.destinationId === 'd1')!;
    assert.equal(d1.routeId, 'r1', 'الأقدم يحكم القالب (كسر تعادل حتمي)');
    assert.equal(d1.templateId, 't1');
    assert.equal(d1.reviewRequired, false);
  });

  it('قالب المسار يتقدّم على القالب المحدَّد في المعالجة، ويُستخدم الأخير عند غيابه', () => {
    const withRoute = planDeliveries([candidate({ destinationId: 'd1', routeId: 'r1', templateId: 'route-t' })], {
      resolvedTemplateId: 'resolved-t',
      messageNeedsReview: false,
    });
    assert.equal(withRoute[0]?.templateId, 'route-t');

    const withoutRoute = planDeliveries([candidate({ destinationId: 'd1', routeId: 'r1' })], {
      resolvedTemplateId: 'resolved-t',
      messageNeedsReview: false,
    });
    assert.equal(withoutRoute[0]?.templateId, 'resolved-t');
  });

  it('طلب أي مسار للمراجعة يُلزم الوجهة كلها', () => {
    const plan = planDeliveries(
      [
        candidate({ destinationId: 'd1', routeId: 'r1', publishMode: 'auto' }),
        candidate({ destinationId: 'd1', routeId: 'r2', publishMode: 'review' }),
      ],
      { resolvedTemplateId: null, messageNeedsReview: false },
    );
    assert.equal(plan.length, 1);
    assert.equal(plan[0]?.reviewRequired, true);
    assert.equal(plan[0]?.reviewReason, 'route');
  });

  it('غموض المعالجة يفرض المراجعة حتى مع مسار تلقائي (Q4)', () => {
    const plan = planDeliveries([candidate({ destinationId: 'd1', routeId: 'r1' })], {
      resolvedTemplateId: null,
      messageNeedsReview: true,
    });
    assert.equal(plan[0]?.reviewRequired, true);
    assert.equal(plan[0]?.reviewReason, 'message');
  });

  it('لا ينشئ تسليماً بلا مرشّحين', () => {
    assert.deepEqual(planDeliveries([], { resolvedTemplateId: null, messageNeedsReview: false }), []);
  });
});

describe('هوية المحادثة الفنية (O05)', () => {
  it('يحوّل معرّف المصدر إلى معرّف محادثة سالب من نمط القنوات', () => {
    assert.equal(sourceChatId('channel', '1234567890'), '-1001234567890');
    assert.equal(sourceChatId('group', '1234567890'), '-1001234567890');
    assert.equal(isDestinationChatId(sourceChatId('channel', '1')), true);
  });

  it('يرفض معرّفات مصادر غير موجبة أو غير رقمية', () => {
    assert.throws(() => sourceChatId('channel', '0'), RangeError);
    assert.throws(() => sourceChatId('channel', '-5'), RangeError);
    assert.throws(() => normalizeChatId('abc'), RangeError);
    assert.equal(normalizeChatId('-1001234567890'), '-1001234567890');
    assert.equal(normalizeChatId('-000123'), '-123');
  });
});

describe('حق النشر في الوجهة', () => {
  it('القناة تتطلب إشرافاً وحق النشر معاً', () => {
    assert.deepEqual(evaluateRights('channel', { status: 'administrator', canPostMessages: true, canEditMessages: false }), {
      canPost: true,
      errorCode: null,
    });
    assert.equal(
      evaluateRights('channel', { status: 'administrator', canPostMessages: false, canEditMessages: false }).errorCode,
      'missing_post_rights',
    );
    assert.equal(
      evaluateRights('channel', { status: 'member', canPostMessages: false, canEditMessages: false }).errorCode,
      'not_administrator',
    );
  });

  it('المجموعة تكفي فيها العضوية أو الإدارة', () => {
    for (const status of ['member', 'administrator', 'creator']) {
      assert.equal(
        evaluateRights('supergroup', { status, canPostMessages: false, canEditMessages: false }).canPost,
        true,
        status,
      );
    }
    assert.equal(evaluateRights('group', { status: 'left', canPostMessages: false, canEditMessages: false }).errorCode, 'bot_not_member');
    assert.equal(evaluateRights('supergroup', null).errorCode, 'bot_not_member');
  });

  it('يطبّع معرّفات الوجهات المقبولة ويرفض غيرها', () => {
    assert.equal(normalizeIdentifier('@jobs'), '@jobs');
    assert.equal(normalizeIdentifier('jobs'), '@jobs');
    assert.equal(normalizeIdentifier('https://t.me/jobs'), '@jobs');
    assert.equal(normalizeIdentifier('t.me/jobs'), '@jobs');
    assert.equal(normalizeIdentifier('-1001234567890'), '-1001234567890');
    assert.throws(() => normalizeIdentifier('أ ب'), /اسم القناة غير صالح|غير صالح/);
    assert.throws(() => normalizeIdentifier('   '), /غير صالح|أدخل/);
  });
});
