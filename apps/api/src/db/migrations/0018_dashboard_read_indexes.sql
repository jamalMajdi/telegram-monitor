-- 0018_dashboard_read_indexes
-- الغرض: المرحلة الرابعة — الدفعة P4-أ. فهارس نموذج القراءة (عدّادات اللوحة)، بلا أي جدول جديد ولا تغيير سلوك.
-- المرجع: §12.1 (الصفحة الرئيسية)، Q16 (استعلامات تجميعية حيّة + ذاكرة 15 ثانية)، Q30 (فهارس الأداء).
--
-- المبدأ: كل عدّاد معروض في اللوحة يُخدم بفهرس مناسب، والاستعلامات قراءة فقط ولا تكتب شيئاً.
-- (فهارس الملكية القائمة من 0006/0011/0014/0016 تُستخدم كما هي؛ هنا نضيف الناقص فقط.)

-- عدّادات المطابقات: message_matches لا تحمل user_id (الملكية تُستنتج من الهوية)،
-- فالفهرس القائم (filter_id, matched_at) لا يخدم العدّ لكل مالك.
create index message_matches_identity_time_idx on message_matches (identity_id, matched_at desc);

-- عمق الطابور في لوحة التشغيل: أجزاء «معلّقة» فقط — فهرس جزئي رخيص.
create index delivery_parts_pending_idx on delivery_parts (delivery_id) where status = 'pending';

-- عدّادات المحاولات في نافذة زمنية (آخر ساعة/24 ساعة).
create index delivery_attempts_started_idx on delivery_attempts (started_at desc);

-- عدّادات التسليمات لكل مالك وحالة مع نافذة زمنية («آخر 24 ساعة») بلا مسح.
create index deliveries_user_status_time_idx on deliveries (user_id, status, created_at desc);

comment on index message_matches_identity_time_idx is
  'خدمة عدّادات المطابقات في لوحة المستخدم (P4-أ) بلا مسح كامل.';
