-- 0029 — مستهلك صندوق البريد + إشعار البريد للتنبيهات (P0، تدقيق ما قبل التسليم)
--
-- الخلفية: كان `notification_outbox` يُكتب فيه (استعادة كلمة المرور) **بلا مستهلك**:
-- لا شيء يقرأه ولا يُرسل، فيبقى `pending` إلى الأبد ولا تصل رسالة للمستخدم.
--
-- ما تُضيفه هذه الترقية:
-- 1) أعمدة استحواذ/إعادة محاولة للمستهلك (لُقية، عدد محاولات، موعد المحاولة التالية،
--    مفتاح منع التكرار) — بنفس نمط لُقى الإرسال، فلا يتكرر بريد ولا يضيع.
-- 2) `alert_notifications.notified_at`: يُختم عند إدراج بريد التنبيه، فلا يُرسل التنبيه
--    نفسه مرتين ولو تكرر المسح كل دقيقة.

alter table notification_outbox
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  /** مفتاح منع تكرار (مثال: `alert:<uuid>` أو `reset:<uuid>`) — فريد عند وجوده. */
  add column if not exists dedupe_key text;

-- فريد: لا صفَّان لنفس الحدث (إعادة المحاولة تُحدِّث الصف نفسه لا تُنشئ آخر).
create unique index if not exists notification_outbox_dedupe_key_idx
  on notification_outbox (dedupe_key)
  where dedupe_key is not null;

-- استحواذ المستهلك: الأقدم أولاً، والمستحق فقط.
create index if not exists notification_outbox_claim_idx
  on notification_outbox (created_at)
  where status = 'pending';

-- حماية من انفجار المحاولات: لا صف Pending بلا حد أقصى.
alter table notification_outbox
  drop constraint if exists notification_outbox_attempts_range;
alter table notification_outbox
  add constraint notification_outbox_attempts_range check (attempts >= 0 and attempts <= 20);

alter table alert_notifications
  add column if not exists notified_at timestamptz;

-- فحص المستهلك للتنبيهات غير المُبلَّغ عنها بالبريد.
create index if not exists alert_notifications_unnotified_idx
  on alert_notifications (user_id, last_seen_at desc)
  where resolved_at is null and notified_at is null;

-- عنوان المستخدم مطلوب لإرسال البريد: الفهرس القائم على email_normalized يكفي للقراءة،
-- ونحتاج قراءة `email` الخام للتسليم (لا يُسجَّل ولا يُعاد في أي استجابة).
comment on column alert_notifications.notified_at is
  'وقت إدراج تنبيه البريد في صندوق الصادر؛ يمنع تكرار البريد لنفس التنبيه.';
comment on column notification_outbox.dedupe_key is
  'مفتاح منع تكرار التسليم لنفس الحدث (مثال alert:<uuid>).';
