-- 0009_drop_unused_gap_columns
-- الغرض: إزالة عمودَي الفجوات من 0008 لأنهما بلا مصدر إشارة موثّق قابل للاستهلاك:
--   * teleproto يستهلك UpdateChannelTooLong داخلياً (UpdateManager.feed) ولا يوزّعه على المعالجات،
--     ولا يوفّر واجهة عامة لإشعار «فجوة غير قابلة للاستعادة».
--   * تسجيل «فجوة» بلا إشارة حقيقية سيكون ادّعاء تغطية غير صادق (D03/O09)، وهو ممنوع.
-- الأثر: لا تغيير في أي عقد API (العدّادات المعروضة: مُلتقطة/مكررة/مستبعدة فقط).
-- إعادة إضافتهما لاحقاً تتطلب تحديد إشارة موثّقة أولاً (تحديث نقطة تقدم في المكتبة أو ترقية تسمح بمراقبة الفجوات).

alter table telegram_sources drop constraint telegram_sources_gap_count_non_negative;
alter table telegram_sources drop column gap_count;
alter table telegram_sources drop column last_gap_at;
