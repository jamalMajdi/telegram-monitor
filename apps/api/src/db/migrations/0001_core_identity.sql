-- 0001_core_identity
-- الغرض: الأنواع الأساسية وجدول المستخدمين (مالك المساحة) وإعداداته الشخصية.
-- المرجع: §2 (تعدد المستخدمين والأدوار)، D02 (عزل الملكية)، D09 (الاحتفاظ القابل للتخصيص).

create extension if not exists pgcrypto;

-- أدوار المنتج: مستخدم عادي ومدير نظام فقط (§2.2: لا حاجة لنظام أدوار معقّد).
create type app_role as enum ('user', 'admin');

-- حالة الحساب: نشط، موقوف إدارياً، محذوف منطقياً (§14: حذف الحساب وبياناته وجلساته).
create type account_status as enum ('active', 'suspended', 'deleted');

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  -- تطبيع البريد لضمان فرادة غير حساسة لحالة الأحرف
  email_normalized text generated always as (lower(btrim(email))) stored,
  display_name text not null,
  password_hash text not null,
  password_algo text not null default 'scrypt-n32768-r8-p1',
  password_changed_at timestamptz not null default now(),
  role app_role not null default 'user',
  status account_status not null default 'active',
  email_verified_at timestamptz,
  last_login_at timestamptz,
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint users_email_length check (char_length(email) between 3 and 254),
  constraint users_email_shape check (email ~ '^[^@%[:space:]]+@[^@%[:space:]]+\.[^@%[:space:]]+$'),
  constraint users_display_name_length check (char_length(display_name) between 2 and 120),
  constraint users_failed_login_count_nonnegative check (failed_login_count >= 0),
  constraint users_deleted_consistency check ((status = 'deleted') = (deleted_at is not null)),
  constraint users_password_hash_present check (char_length(password_hash) >= 32)
);

-- الفرادة تُطبّق على الحسابات غير المحذوفة فقط، ولا يُسمح بإعادة تسجيل بريد حساب محذوف
-- إلا عبر مسار إداري موثق (يبقى السجل للتدقيق).
create unique index users_email_normalized_active_key
  on users (email_normalized)
  where status <> 'deleted';

create index users_role_status_idx on users (role, status);
create index users_created_at_idx on users (created_at desc);

comment on table users is 'مالك المساحة؛ لا يُشارك أي مستخدم بياناته مع غيره (§2.1).';
comment on column users.password_hash is 'تجزئة scrypt مع ملح فريد؛ لا تُخزّن كلمة المرور أبداً.';

-- تحديث updated_at تلقائياً دون الاعتماد على التطبيق.
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger users_set_updated_at
before update on users
for each row execute function set_updated_at();

-- إعدادات المستخدم الشخصية: مدة الاحتفاظ بالمحتوى (D09: 48 ساعة افتراضياً وقابلة للتخصيص)
-- وإعدادات التنبيهات والمعالجة المستقبلية. الحدود حاجز تشغيلي موثّق وليست سياسة جديدة.
create table user_settings (
  user_id uuid primary key references users (id) on delete cascade,
  content_retention_hours integer not null default 48,
  notifications jsonb not null default '{}'::jsonb,
  processing jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_settings_retention_range check (content_retention_hours between 1 and 2160),
  constraint user_settings_notifications_object check (jsonb_typeof(notifications) = 'object'),
  constraint user_settings_processing_object check (jsonb_typeof(processing) = 'object')
);

create trigger user_settings_set_updated_at
before update on user_settings
for each row execute function set_updated_at();

-- إعدادات النظام العامة التي يديرها المدير (§13). لا تحتوي أسراراً ولا محتوى مستخدمين.
create table system_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_by uuid references users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint system_settings_key_shape check (key ~ '^[a-z][a-z0-9_.]{2,80}$'),
  constraint system_settings_value_object check (jsonb_typeof(value) = 'object')
);

insert into system_settings (key, value, description) values
  ('system.registration_enabled', '{"enabled": true}'::jsonb, 'السماح بالتسجيل الذاتي بحساب جديد'),
  ('system.default_content_retention_hours', '{"hours": 48}'::jsonb, 'القيمة الافتراضية لمدة الاحتفاظ بالمحتوى (D09)');
