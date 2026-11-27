-- 0020 — سجل أخطاء موحّد (P4-ج، Q19).
--
-- المبدأ الحاكم: لا محتوى رسائل، ولا نصوص استثناءات خام، ولا رموز، ولا قيم تواصل.
-- لذلك `detail` **ليست جملة حرة**: مقطع آلي قصير (أحرف لاتينية صغيرة وأرقام وفواصل تقنية فقط)،
-- وقاعدة البيانات نفسها ترفض أي صف يخرج عن ذلك. أي محاولة لتسريب نص عربي أو رمز بوت أو رقم هاتف
-- تفشل على مستوى المخطط، لا على مستوى المراجعة البشرية.

create type error_scope as enum (
  'telegram',   -- الاتصال والحسابات والالتقاط
  'processing', -- الاستخراج والتصنيف والفلترة والقوالب
  'publishing', -- التخطيط والإرسال والتسليم
  'auth',       -- الجلسات والدخول
  'system'      -- التشغيل والاحتفاظ والمهام الدورية
);

create type error_severity as enum ('warn', 'error', 'critical');

create table error_events (
  id bigserial primary key,
  -- قد تكون بلا مالك (أخطاء تشغيلية عامة)؛ وحذف المستخدم يحذف أحداثه بالكامل.
  user_id uuid references users (id) on delete cascade,
  scope error_scope not null,
  -- تصنيف ثابت آلي: connection_failed / auth_failed / send_failed / retention_failed ...
  kind text not null,
  -- رمز خطأ قصير: FLOOD_WAIT / server_unknown / bot_unauthorized ...
  code text not null,
  severity error_severity not null default 'error',
  -- مقطع آلي قصير فقط (لا جمل): يُنقّى ويُرفض إن خرج عن النمط.
  detail text,
  -- مُعرّف الترابط مع سجلات pino؛ ليس محتوى ولا هوية شخص.
  correlation_id text,
  occurred_at timestamptz not null default now(),
  constraint error_events_kind_shape check (kind ~ '^[a-z][a-z0-9_]{2,40}$'),
  constraint error_events_code_shape check (code ~ '^[A-Za-z][A-Za-z0-9_]{1,40}$'),
  constraint error_events_detail_shape
    check (detail is null or (detail ~ '^[a-z0-9_.:/-]{1,120}$' and detail !~ '[0-9]{6,}')),
  constraint error_events_correlation_shape
    check (correlation_id is null or correlation_id ~ '^[A-Za-z0-9-]{1,64}$')
);

-- قراءة المالك: أحداثه الأحدث أولاً.
create index error_events_user_time_idx on error_events (user_id, occurred_at desc, id desc);
-- تصفية المدير بالتجميع (نطاق + نوع + زمن) دون الوصول إلى المستخدم.
create index error_events_scope_kind_time_idx on error_events (scope, kind, occurred_at desc);
-- تنظيف الاحتفاظ (30 يوماً).
create index error_events_occurred_idx on error_events (occurred_at);
-- الخطورة أولاً في لوحة المدير.
create index error_events_severity_time_idx on error_events (severity, occurred_at desc);

comment on table error_events is
  'أخطاء تشغيلية موحّدة (Q19) بلا أي محتوى رسائل أو أسرار: النطاق والنوع والرمز فقط،
   مع `detail` آلي مقنَّع. احتفاظ 30 يوماً يُنفَّذ بمهمة التنظيف الموحّدة (Q23).';
comment on column error_events.detail is
  'مقطع آلي قصير بعد التقنيع (≤120 حرفاً، لاتيني صغير وأرقام وفواصل تقنية)؛ ممنوع فيه أي نص حر.';
