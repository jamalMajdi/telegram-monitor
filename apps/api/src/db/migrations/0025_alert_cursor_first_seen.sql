-- 0025 — تصحيح أساس الترقيم في صندوق التنبيهات (الدفعة P4-و)
--
-- الخلل المكتشف: `0024` فهرس الفرز على `last_seen_at`، و`last_seen_at` يتغيّر مع كل مسح
-- (المزامنة تُحدِّثه). فأي مؤشِّر مبني عليه «يقفز» بين الصفحة والأخرى، وقد تُفقد صفوف.
-- التصحيح الأمامي: الفرز والترقيم على `first_seen_at` (ثابت بالتعريف).
--
-- لا حذف للبيانات ولا تغيير لأي عمود — فهارس فقط.

drop index if exists alert_notifications_open_idx;
drop index if exists alert_notifications_user_time_idx;

create index alert_notifications_open_idx
  on alert_notifications (user_id, first_seen_at desc, id desc)
  where resolved_at is null;

create index alert_notifications_user_time_idx
  on alert_notifications (user_id, first_seen_at desc, id desc);
