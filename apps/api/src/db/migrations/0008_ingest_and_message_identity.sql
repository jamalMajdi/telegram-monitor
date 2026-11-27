-- 0008_ingest_and_message_identity
-- الغرض: الخطوة الرابعة — محرّك الالتقاط. مؤشرات صحة الالتقاط على المصدر، وجدول هوية الرسائل لمنع التكرار (§9).
-- لا يُخزَّن أي نص رسالة ولا وسيط ولا تاريخ محادثة (D06/D07، قرارات الخطوة الرابعة 1 و5 و6).

-- 1) مؤشرات الالتقاط على المصدر (بدل جدول update_checkpoints المؤجَّل بقرار المستخدم 2).
alter table telegram_sources
  add column last_message_at timestamptz,
  add column ingested_count bigint not null default 0,
  add column duplicate_count bigint not null default 0,
  add column excluded_count bigint not null default 0,
  add column gap_count integer not null default 0,
  add column last_gap_at timestamptz,
  add column last_ingest_error_code text;

alter table telegram_sources
  add constraint telegram_sources_ingested_count_non_negative check (ingested_count >= 0),
  add constraint telegram_sources_duplicate_count_non_negative check (duplicate_count >= 0),
  add constraint telegram_sources_excluded_count_non_negative check (excluded_count >= 0),
  add constraint telegram_sources_gap_count_non_negative check (gap_count >= 0),
  add constraint telegram_sources_ingest_error_code_length
    check (last_ingest_error_code is null or char_length(last_ingest_error_code) <= 64);

-- 2) هدف صالح لمفتاح أجنبي مركّب يحمل الملكية (نفس نمط 0007).
alter table telegram_sources
  add constraint telegram_sources_id_user_key unique (id, user_id);

-- 3) هوية الرسالة: (المستخدم، المصدر، معرّف رسالة تيليجرام) — بلا نص ولا وسائط.
create table message_identity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  source_id uuid not null,
  account_id uuid not null,
  -- نسخة من هوية المصدر لتسريع الفحص وللاحتفاظ بالتاريخ بعد انتهاء المدة؛ مقيّدة بالمصدر نفسه.
  peer_type telegram_source_type not null,
  peer_id bigint not null,
  telegram_message_id bigint not null,
  first_seen_at timestamptz not null default now(),
  constraint message_identity_message_id_positive check (telegram_message_id > 0),
  constraint message_identity_peer_id_positive check (peer_id > 0),
  -- الملكية مفروضة في قاعدة البيانات: المصدر والحساب يجب أن يملكهما المستخدم نفسه.
  constraint message_identity_source_owner_fkey
    foreign key (source_id, user_id) references telegram_sources (id, user_id) on delete cascade,
  constraint message_identity_account_owner_fkey
    foreign key (account_id, user_id) references telegram_accounts (id, user_id) on delete cascade,
  -- §9: منع إدخال الرسالة نفسها مرتين من المصدر نفسه داخل مساحة المستخدم.
  constraint message_identity_user_source_message_key unique (user_id, source_id, telegram_message_id)
);

create index message_identity_source_idx on message_identity (source_id, first_seen_at desc);
create index message_identity_user_idx on message_identity (user_id, first_seen_at desc);
-- فهرس سياسة الاحتفاظ (تنظيف ما تجاوز المدة).
create index message_identity_first_seen_idx on message_identity (first_seen_at);

comment on table message_identity is
  'هوية رسالة تيليجرام تم التقاطها (بلا نص أو وسائط): تُستخدم لمنع التكرار وتُحذف وفق سياسة احتفاظ مستقلة؛
   بعد الحذف لا يُضمن منع تكرار الرسالة نفسها.';
