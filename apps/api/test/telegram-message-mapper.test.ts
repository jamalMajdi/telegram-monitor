/** اختبارات وحدة لتحويل تحديثات تيليجرام إلى النطاق النصي للمشروع. */
import './telegram-test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapIncomingText } from '../src/modules/telegram/messageMapper.js';

const ACC = '11111111-1111-4111-8111-111111111111';

describe('تحويل تحديثات تيليجرام', () => {
  it('يحوّل رسالة قناة نصية كاملة', () => {
    const mapped = mapIncomingText(
      {
        className: 'UpdateNewChannelMessage',
        message: {
          className: 'Message',
          id: 42,
          message: 'مطلوب مبرمج لموقع صغير',
          date: 1700000000,
          out: false,
          peerId: { className: 'PeerChannel', channelId: 123456 },
        },
      },
      ACC,
    );
    assert.ok(mapped);
    assert.equal(mapped.peerKey, 'channel:123456');
    assert.equal(mapped.peerKind, 'channel');
    assert.equal(mapped.messageId, 42);
    assert.equal(mapped.text, 'مطلوب مبرمج لموقع صغير');
    assert.equal(mapped.caption, '');
    assert.equal(mapped.hasMedia, false);
    assert.equal(mapped.sentAt.toISOString(), new Date(1700000000 * 1000).toISOString());
    assert.equal(mapped.missed, false);
  });

  it('يميز المجموعات والمحادثات الفردية', () => {
    const group = mapIncomingText(
      { message: { className: 'Message', id: 1, message: 'نص', date: 1, peerId: { className: 'PeerChat', chatId: 7 } } },
      ACC,
    );
    const user = mapIncomingText(
      { message: { className: 'Message', id: 2, message: 'نص', date: 1, peerId: { className: 'PeerUser', userId: 9 } } },
      ACC,
    );
    assert.equal(group?.peerKind, 'group');
    assert.equal(group?.peerKey, 'chat:7');
    assert.equal(user?.peerKind, 'user');
    assert.equal(user?.peerKey, 'user:9');
  });

  it('يقرأ النص المصاحب لوسائط دون تنزيل أي ملف', () => {
    const mapped = mapIncomingText(
      {
        message: {
          className: 'Message',
          id: 3,
          message: '',
          date: 1700000002,
          peerId: { className: 'PeerChannel', channelId: 5 },
          media: { caption: 'فرصة تدريب — تفاصيل في النص' },
        },
      },
      ACC,
    );
    assert.ok(mapped);
    assert.equal(mapped.text, '');
    assert.equal(mapped.caption, 'فرصة تدريب — تفاصيل في النص');
    assert.equal(mapped.hasMedia, true);
  });

  it('يتجاهل الوسائط بلا نص مصاحب ورسائل الخدمة', () => {
    assert.equal(
      mapIncomingText(
        { message: { className: 'Message', id: 4, message: '', date: 1, peerId: { className: 'PeerChannel', channelId: 5 }, media: {} } },
        ACC,
      ),
      null,
    );
    assert.equal(mapIncomingText({ message: { className: 'MessageService', id: 5, date: 1 } }, ACC), null);
    assert.equal(mapIncomingText({}, ACC), null);
  });

  it('يميّز التحديثات المستعادة بعد انقطاع', () => {
    const mapped = mapIncomingText(
      { missed: true, message: { className: 'Message', id: 6, message: 'وصلت متأخرة', date: 1700000003, peerId: { className: 'PeerChannel', channelId: 5 } } },
      ACC,
    );
    assert.equal(mapped?.missed, true);
  });

  it('يحتفظ بالرسائل الصادرة والحقول الناقصة دون اختلاق', () => {
    const mapped = mapIncomingText({ message: { className: 'Message', message: 'نص', peerId: {} } }, ACC);
    assert.ok(mapped);
    assert.equal(mapped.outgoing, false);
    assert.equal(mapped.messageId, 0);
    assert.equal(mapped.peerKey, 'unknown:0');
  });
});
