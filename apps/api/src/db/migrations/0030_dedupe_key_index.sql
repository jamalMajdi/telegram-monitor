-- 0030 — إصلاح فهرس منع التكرار في صندوق البريد (P0، اكتشفه الاختبار)
--
-- المشكلة: 0029 أنشأ الفهرس **جزئياً**:
--     create unique index ... on notification_outbox (dedupe_key) where dedupe_key is not null;
-- لكن الكود يُدرج بـ`on conflict (dedupe_key) do nothing`. في PostgreSQL لا يُطابِق
-- هدفُ التعارض فهرساً جزئياً إلا إذا ذُكر شرطُه نفسه، فكان كل إدراج في الصندوق يفشل بـ
--     42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification
-- أي أن **طلب استعادة كلمة المرور كان يفشل**، وكل إشعار بريدي كذلك.
--
-- الحل: فهرس فريد كامل. PostgreSQL يعتبر NULL قيماً متمايزة، فالصفوف بلا مفتاح منع تكرار
-- (تنبيهات متفرقة) تُدرَج بلا حد، والهدف `(dedupe_key)` يعمل كما هو في الكود بلا شرط.

drop index if exists notification_outbox_dedupe_key_idx;

create unique index if not exists notification_outbox_dedupe_key_idx
  on notification_outbox (dedupe_key);
