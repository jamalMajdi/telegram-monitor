-- 0023 — إعادة النشر (P4-هـ، Q20) وفهرس الترقيم المؤشِّر للنتائج (Q30).
--
-- إعادة النشر ليست «إرسالاً ثانياً» بل **إعادة تخطيط** لخطة جديدة على التسليم نفسه:
-- القيد الفريد (identity_id, destination_id) يمنع تسليماً ثانياً للرسالة إلى الوجهة نفسها،
-- وهو ما يمنع النشر المزدوج أصلاً. لذلك نُعيد استخدام الصف ونرفع نسخة الخطة.

alter table deliveries
  add column republish_count smallint not null default 0,
  add column last_republished_at timestamptz,
  add constraint deliveries_republish_count_range check (republish_count between 0 and 3),
  add constraint deliveries_republish_timestamp_shape
    check ((republish_count = 0) = (last_republished_at is null));

comment on column deliveries.republish_count is
  'عدد مرات إعادة التخطيط (Q20): سقف 3 صريح في المخطط. لا يُزاد أبداً لتسليم نتيجته مجهولة.';

-- مسار قراءة النتائج بالترقيم المؤشِّر: (first_seen_at desc, id desc) مفتاحاً مركّباً.
create index message_identity_user_cursor_idx
  on message_identity (user_id, first_seen_at desc, id desc);

-- البحث عن تسليمات رسالة في الخط الزمني الموحّد.
create index deliveries_identity_idx on deliveries (identity_id, created_at desc);
