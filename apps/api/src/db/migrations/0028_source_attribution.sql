-- هوية المصدر والمرسل في المنشورات (متطلب تجاري: تُدمج أسفل المنشور).
--
-- ثلاثة مستويات تحكم:
--   1) افتراضي المستخدم: مفعّل (Opt-out) — يعمل لكل الرسائل فور التشغيل.
--   2) ماذا يُعرض: المصدر وحده / المرسل وحده / كلاهما، مع إظهار @username والمعرّف الرقمي أو إخفائهما.
--   3) تجاوز لكل مسار نشر: NULL = وراثة إعداد المستخدم، وإلا 'off' أو أحد الأنماط ⇒ يخصّ تلك الوجهة وحدها.
--
-- بيانات المرسل تُلتقط من MTProto وقت الاستقبال (بلا أي طلب شبكة إضافي): معرّف المرسل من `fromId`
-- واسمه/@username من كيانات التحديث (`_entities`)، وتوقيع المنشور من `postAuthor` للقنوات.

alter table message_identity
  add column if not exists sender_id bigint,
  add column if not exists sender_username text,
  add column if not exists sender_display_name text,
  add column if not exists post_author text;

comment on column message_identity.sender_id is 'معرّف المرسل الرقمي في تيليجرام (PeerUser) إن وُجد.';
comment on column message_identity.sender_username is 'اسم مستخدم المرسل وقت الاستقبال (قد يغيب لو لم يُرسله التحديث).';
comment on column message_identity.sender_display_name is 'اسم المرسل المعروض (اسم/لقب) وقت الاستقبال.';
comment on column message_identity.post_author is 'توقيع المنشور في القنوات (postAuthor) إن وُجد.';

alter table user_settings
  add column if not exists attribution_enabled boolean not null default true,
  add column if not exists attribution_mode text not null default 'both',
  add column if not exists attribution_show_username boolean not null default true,
  add column if not exists attribution_show_id boolean not null default false;

alter table user_settings
  drop constraint if exists user_settings_attribution_mode_allowed;
alter table user_settings
  add constraint user_settings_attribution_mode_allowed
  check (attribution_mode in ('source', 'sender', 'both'));

alter table publish_routes
  add column if not exists attribution_mode text;

alter table publish_routes
  drop constraint if exists publish_routes_attribution_mode_allowed;
alter table publish_routes
  add constraint publish_routes_attribution_mode_allowed
  check (attribution_mode is null or attribution_mode in ('off', 'source', 'sender', 'both'));

comment on column publish_routes.attribution_mode is
  'تجاوز هوية المصدر/المرسل لهذا المسار: NULL = وراثة إعداد المستخدم، off = إخفاء، أو نمط صريح.';
