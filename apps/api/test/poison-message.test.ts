/**
 * تدقيق 2026-11-26 — الرسائل السامّة (Poison Messages).
 *
 * **ما ثبت عملياً:** PostgreSQL يرفض المحرف NUL في أعمدة `text`
 * (`invalid byte sequence for encoding "UTF8": 0x00`). رسالة واحدة تحمل هذا المحرف
 * كانت تُفشِل حفظ المحتوى ⇒ تُثبَّت نقطة الاستئناف ⇒ تُعاد الرسالة نفسها بلا نهاية،
 * فيتوقف التقاط الحساب كله عند رسالة واحدة (تعطّل كامل عن بُعد بمحتوى رسالة).
 *
 * هذه الاختبارات تثبت:
 *  1) المخطِّط يُزيل المحارف غير القابلة للتخزين قبل أي كتابة (NUL ومحارف التحكم).
 *  2) يحفظ المحارف المشروعة: العربية، الإيموجي المركّب (ZWJ)، وعلامات الاتجاه (RTL).
 *  3) الرسالة بعد التنقية تُخزَّن فعلاً في قاعدة البيانات بلا خطأ وبطول مطابق.
 *  4) الرسالة التي لا يبقى منها نص بعد التنقية تُتجاهل بدل إنشاء صف فارغ.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './harness.js';
import { FakeGateway } from './telegram-fakes.js';
import { PublishScenario, type ScenarioHarness } from './publish-scenario.js';
import type { FakeBotApiClient } from './publish-fakes.js';
import { mapIncomingText, sanitizeInboundText } from '../src/modules/telegram/messageMapper.js';
import type { IncomingTextMessage } from '../src/modules/telegram/gateway.js';

const ACC = '11111111-1111-4111-8111-111111111111';

describe('تنقية النص الوارد — وحدة', () => {
  it('يُزيل NUL ومحارف التحكم ويُبقي السطر الجديد والجدولة', () => {
    const raw = 'مطلوب\u0000 مبرمج\u0007\u001B[31m\nسطر\u0009جدول\u0085';
    const clean = sanitizeInboundText(raw);
    assert.equal(clean.includes('\u0000'), false);
    assert.equal(clean.includes('\u0007'), false);
    assert.equal(clean.includes('\u001B'), false);
    assert.equal(clean.includes('\u0085'), false);
    assert.ok(clean.includes('\n'), 'السطر الجديد محفوظ');
    assert.ok(clean.includes('\t'), 'الجدولة محفوظة');
    assert.ok(clean.includes('مطلوب') && clean.includes('مبرمج'));
  });

  it('يحفظ الإيموجي المركّب وعلامات الاتجاه (لازمة للعربية)', () => {
    const family = '👨\u200D👩\u200D👧';
    const mixed = `سعر\u200F 100\u200E ريال ${family}`;
    assert.equal(sanitizeInboundText(mixed), mixed);
  });

  it('نص الرسالة والنص المصاحب يُنقّيان معاً في المخطِّط', () => {
    const mapped = mapIncomingText(
      {
        message: {
          className: 'Message',
          id: 501,
          message: 'نص\u0000 فيه محرف قاتل',
          date: 1700000200,
          peerId: { className: 'PeerChannel', channelId: 991 },
          media: { caption: 'وسائط\u0000 بنص مصاحب' },
        },
      },
      ACC,
    );
    assert.ok(mapped);
    assert.equal(mapped.text.includes('\u0000'), false);
    assert.equal(mapped.caption.includes('\u0000'), false);
    assert.equal(mapped.text, 'نص فيه محرف قاتل');
    assert.equal(mapped.caption, 'وسائط بنص مصاحب');
  });

  it('رسالة لا يبقى منها نص بعد التنقية تُتجاهل بلا صف', () => {
    const mapped = mapIncomingText(
      {
        message: {
          className: 'Message',
          id: 502,
          message: '\u0000\u0007\u001B',
          date: 1700000201,
          peerId: { className: 'PeerChannel', channelId: 992 },
        },
      },
      ACC,
    );
    assert.equal(mapped, null);
  });
});

let server: TestServer;
let gateway: FakeGateway;
let botApi: FakeBotApiClient;
let scenario: PublishScenario;

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

async function contentOf(h: ScenarioHarness, identityId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const res = await server.sql<{ message_text: string | null; text_length: number }>(
      'select message_text, text_length from message_content where identity_id = $1',
      [identityId],
    );
    if (res.rows.length > 0) return res.rows[0]!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

describe('الرسالة السامّة — عبر خط الالتقاط', () => {
  it('رسالة تحمل NUL تُخزَّن بعد التنقية بدل أن تُوقف الالتقاط', async () => {
    const h = await scenario.create();
    const mapped = mapIncomingText(
      {
        message: {
          className: 'Message',
          id: 777,
          message: 'مطلوب مندوب\u0000 مبيعات — الراتب مجزٍ',
          date: 1700000300,
          peerId: { className: 'PeerChannel', channelId: Number(h.peerId) },
        },
      },
      h.accountId,
    );
    assert.ok(mapped, 'المخطِّط يجب أن يُنتج رسالة نظيفة');
    assert.equal(mapped.text.includes('\u0000'), false);

    // النص كما يصل بعد التنقية هو ما يدخل القاعدة (لو بقي NUL لفشل الحفظ).
    const identityId = await scenario.emit(h, mapped.text);
    const content = await contentOf(h, identityId);
    assert.ok(content, 'المحتوى يجب أن يُحفظ');
    assert.equal(content!.message_text?.includes('\u0000'), false);
    assert.equal(content!.text_length, content!.message_text?.length ?? 0, 'الطول مطابق للنص المخزَّن');

    const failures = await server.sql<{ failed_count: string }>(
      'select failed_count::text as failed_count from telegram_sources where id = $1',
      [h.sourceId],
    );
    assert.equal(failures.rows[0]!.failed_count, '0', 'لا فشل التقاط');
  });

  it('رسالة أطول من حد تيليجرام تُستبعد بسياسة صريحة (too_long) بلا اقتطاع وبلا تعطيل', async () => {
    const h = await scenario.create();
    await scenario.route(h, { lengthPolicy: 'reject' });
    const identityId = await scenario.emit(h, 'ط'.repeat(5000));

    // الحد 4096 (Q11): تُستبعد بسبب صريح، ولا تُقتطع بصمت، ولا يُحفظ محتواها.
    const identity = await server.sql<{ state: string; ignore_reason: string | null }>(
      'select state::text as state, ignore_reason::text as ignore_reason from message_identity where id = $1',
      [identityId],
    );
    assert.equal(identity.rows[0]!.state, 'ignored');
    assert.equal(identity.rows[0]!.ignore_reason, 'too_long');
    assert.equal(await contentOf(h, identityId), null, 'لا محتوى محفوظ لرسالة متجاوزة الحد');

    // ولا تُعطّل المصدر: رسالة صحيحة بعدها تُلتقط وتُحفظ (بالبادئة التي يطابقها فلتر الوظائف المبذور).
    const prefix = 'مطلوب مبرمج ';
    const okId = await scenario.emit(h, prefix + 'ط'.repeat(4096 - prefix.length));
    const content = await contentOf(h, okId);
    assert.ok(content, 'الحد الأقصى نفسه يُقبل ويُحفظ');
    assert.equal(content!.text_length, 4096);
    const stats = await server.sql<{ failed_count: string }>(
      'select failed_count::text as failed_count from telegram_sources where id = $1',
      [h.sourceId],
    );
    assert.equal(stats.rows[0]!.failed_count, '0');
  });

  it('المصدر يُعلن نجاح الالتقاط لعدّة رسائل شاذة متتابعة (لا توقّف)', async () => {
    const h = await scenario.create();
    const texts = [
      'رسالة فيها إيموجي 👨‍👩‍👧 ورموز #$%^&*()',
      'سطور\nمتعددة\n\nمع فراغات',
      'نص عربي مع علامة اتجاه \u200F داخل الجملة',
    ];
    for (const text of texts) await scenario.emit(h, text);
    const stats = await server.sql<{ ingested_count: string; failed_count: string }>(
      'select ingested_count::text as ingested_count, failed_count::text as failed_count from telegram_sources where id = $1',
      [h.sourceId],
    );
    assert.equal(stats.rows[0]!.ingested_count, '3');
    assert.equal(stats.rows[0]!.failed_count, '0');
  });
});
