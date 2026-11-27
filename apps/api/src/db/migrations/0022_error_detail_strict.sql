-- 0022 — تشديد `error_events.detail` (P4-ج، مراجعة الصرامة).
--
-- السبب الصريح: النمط في 0020 كان يسمح بمقاطع لاتينية حرة بعد التقنيع، أي أن نصاً إنجليزياً
-- واحداً يمكن أن يتسرّب في السجل بوصفه «تفصيلاً». القاعدة الآن: التفصيل **قاموس آلي مغلق** —
-- بادئة من قائمة محددة + مقاطع من [a-z0-9_] فقط. أي شيء آخر يُرفض على مستوى المخطط.

alter table error_events drop constraint error_events_detail_shape;

alter table error_events
  add constraint error_events_detail_shape
  check (
    detail is null
    or detail ~ '^(http|policy|attempt|stage|status|wait|reason|field|step)\.[a-z0-9_]{1,32}(\.[a-z0-9_]{1,32}){0,2}$'
  );

comment on column error_events.detail is
  'قاموس آلي مغلق: بادئة معتمدة (http/policy/attempt/stage/status/wait/reason/field/step) + مقاطع [a-z0-9_]. لا نص حر ولا أرقام هواتف ولا رموز — بأي حال.';
