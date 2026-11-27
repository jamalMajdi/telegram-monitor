-- 0016_publish_deliveries
-- الغرض: الدفعة 7-ب — التسليم المنطقي (رسالة × وجهة) الذي يُنشأ عند التوجيه، وحالة النشر على الهوية.
-- المرجع: D05 (تسليم منطقي واحد لكل رسالة ووجهة)، §10.4/D01 (نشر تلقائي أو بمراجعة بشرية)،
--          Q4 (الغموض في المعالجة يُلزم المراجعة)، O02 (قالب المسار أعلى أولوية)،
--          Q12 (احتفاظ مستقل لسجلات النشر)، §17 (فصل حالة المعالجة عن حالة النشر).
--
-- الأجزاء النصية (delivery_parts) والمحاولات والدلائل تأتي في الدفعة 7-ج/7-د بترحيل لاحق،
-- فلا يُخزَّن هنا أي نص منشور بعد.

create type delivery_status as enum (
  'awaiting_review', -- بانتظار موافقة بشرية (D01)
  'queued',          -- جاهز للإرسال (العامل ينفّذ في 7-د)
  'sending',
  'published',
  'partial',
  'failed',
  'uncertain',       -- نتيجة مجهولة: لا إعادة تلقائية (O04)
  'blocked',         -- سبب مانع بلا إرسال (انتهاء محتوى/وجهة معطّلة/دورة)
  'cancelled'
);

create type delivery_review as enum ('not_required', 'pending', 'approved', 'rejected');

create table deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  identity_id uuid not null references message_identity (id) on delete cascade,
  destination_id uuid not null,
  -- المسار صاحب القرار؛ حذف المسار لا يحذف سجل النشر.
  route_id uuid,
  template_id uuid,
  -- نسخة الخطة: تُثبَّت الموافقة عليها؛ أي تغيير في الخطة يُبطل الموافقة.
  plan_version integer not null default 1,
  review delivery_review not null default 'not_required',
  -- سبب طلب المراجعة: 'route' (سياسة المسار) أو 'message' (غموض المعالجة — Q4).
  review_reason text,
  approved_by uuid references users (id) on delete set null,
  approved_at timestamptz,
  approved_version integer,
  rejected_reason text,
  status delivery_status not null,
  chunk_count smallint not null default 0,
  chars_total integer not null default 0,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  masking_version integer not null default 1,
  formatting_version integer not null default 1,
  last_error_code text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deliveries_destination_owner_fkey
    foreign key (destination_id, user_id) references destinations (id, user_id) on delete cascade,
  constraint deliveries_route_fkey
    foreign key (route_id, user_id) references publish_routes (id, user_id) on delete set null (route_id),
  constraint deliveries_template_fkey
    foreign key (template_id, user_id) references templates (id, user_id) on delete set null (template_id),
  constraint deliveries_review_reason_allowed
    check (review_reason is null or review_reason in ('route', 'message')),
  constraint deliveries_counts_non_negative
    check (chunk_count >= 0 and chars_total >= 0 and attempts >= 0 and plan_version >= 1),
  constraint deliveries_error_code_length
    check (last_error_code is null or char_length(last_error_code) <= 64),
  -- ⚑ منع النشر المزدوج مهما تعددت المسارات أو الفلاتر المؤهلة (D05).
  constraint deliveries_identity_destination_key unique (identity_id, destination_id),
  constraint deliveries_id_user_key unique (id, user_id)
);

create index deliveries_user_idx on deliveries (user_id, created_at desc);
create index deliveries_destination_idx on deliveries (destination_id, created_at desc);
-- فهرس الطابور للعامل (7-د): التسليمات الجاهزة فقط.
create index deliveries_queue_idx on deliveries (status, next_attempt_at)
  where status in ('queued', 'sending');
create index deliveries_review_idx on deliveries (user_id, status)
  where status = 'awaiting_review';

create trigger deliveries_set_updated_at
before update on deliveries
for each row execute function set_updated_at();

comment on table deliveries is
  'تسليم منطقي واحد لكل (رسالة، وجهة): سجل حالة النشر، بلا نص منشور (الأجزاء في 7-ج).';

-- حالة النشر على الهوية (§17: فصل المعالجة عن النشر) — للعرض السريع فقط، التسليمات هي المصدر.
alter table message_identity
  add column publish_state text not null default 'not_routed',
  add constraint message_identity_publish_state_allowed
    check (publish_state in ('not_routed', 'routed', 'awaiting_review'));

create index message_identity_publish_state_idx
  on message_identity (user_id, publish_state)
  where publish_state <> 'not_routed';

-- احتفاظ مستقل لسجلات النشر (Q13) — منفصل عن احتفاظ المحتوى (48 ساعة) وعن احتفاظ الهوية (30 يوماً).
alter table user_settings
  add column delivery_retention_days integer not null default 90,
  add constraint user_settings_delivery_retention_range
    check (delivery_retention_days between 1 and 3650);

comment on column user_settings.delivery_retention_days is
  'مدة الاحتفاظ بسجلات النشر (Q13) — مستقلة عن احتفاظ المحتوى والهوية.';
