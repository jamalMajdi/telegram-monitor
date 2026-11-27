-- 0006_telegram_sources
-- الغرض: قائمة المصادر (قنوات/مجموعات) التي اختار المستخدم مراقبتها، مرتبطة بحساب تيليجرام يملكه.
-- المرجع: §4.1–§4.5 (أنواع المصادر والتحكم والنطاق)، §12.3، D02 (عزل الملكية)، D11/O01 (ملف الإطلاق وقارئ نشط واحد)،
--          و§9/نموذج البيانات: "معرّف Telegram ثابت ومميّز بالنوع لا اسم القناة، وتُسجَّل فترات التفعيل والإيقاف صراحةً".

create type telegram_source_type as enum ('channel', 'group');
create type telegram_source_status as enum ('active', 'paused');

create table telegram_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  -- القارئ المسؤول عن هذا المصدر: يجب أن يكون حساباً يملكه المستخدم نفسه (يُتحقق في الخدمة).
  account_id uuid not null references telegram_accounts (id) on delete cascade,
  -- الهوية الثابتة من Telegram: نوع + معرّف، لا اسم القناة القابل للتغيير (§9).
  peer_type telegram_source_type not null,
  peer_id bigint not null,
  title text not null,
  -- اسم مستخدم عام اختياري للعرض فقط؛ لا يُستخدم كهوية.
  username text,
  status telegram_source_status not null default 'active',
  -- §4.3: هل تدخل رسائل المستخدم نفسه (الصادرة) في المعالجة؟ افتراضياً لا.
  include_own_messages boolean not null default false,
  -- أول لحظة بدء المراقبة (لا استيراد تاريخ، §4.4).
  monitoring_started_at timestamptz,
  last_verified_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_sources_peer_id_positive check (peer_id > 0),
  constraint telegram_sources_title_length check (char_length(title) between 1 and 200),
  constraint telegram_sources_username_length check (username is null or char_length(username) <= 64),
  -- O01: مصدر واحد لكل مستخدم لكل هوية، حتى لو أضافه من حساب آخر (قارئ نشط واحد داخل المساحة).
  constraint telegram_sources_user_peer_key unique (user_id, peer_type, peer_id)
);

create index telegram_sources_user_idx on telegram_sources (user_id, created_at desc);
create index telegram_sources_account_idx on telegram_sources (account_id, status);

create trigger telegram_sources_set_updated_at
before update on telegram_sources
for each row execute function set_updated_at();

comment on table telegram_sources is
  'مصدر مراقبة يختاره المستخدم صراحةً؛ الهوية (نوع+معرّف) ثابتة، والملكية مرتبطة بمستخدم واحد وحساب واحد.';

-- فترات التفعيل/الإيقاف مسجّلة صراحةً (نموذج البيانات §9): فترة مفتوحة واحدة لكل مصدر.
create table telegram_source_periods (
  id bigserial primary key,
  source_id uuid not null references telegram_sources (id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  reason text,
  constraint telegram_source_periods_order check (ended_at is null or ended_at > started_at),
  constraint telegram_source_periods_reason_length check (reason is null or char_length(reason) <= 200)
);

create unique index telegram_source_periods_one_open_uidx
  on telegram_source_periods (source_id)
  where ended_at is null;

create index telegram_source_periods_source_idx on telegram_source_periods (source_id, started_at desc);

comment on table telegram_source_periods is
  'فترات تفعيل المصدر: تُفتح عند الإضافة/الاستئناف وتُغلق عند الإيقاف أو الفصل؛ لا تُحذف عند حذف المصدر لأغراض التدقيق فقط عبر audit_events.';
