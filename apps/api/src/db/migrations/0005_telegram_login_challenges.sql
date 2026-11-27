-- 0005_telegram_login_challenges
-- الغرض: حالة مصادقة مؤقتة لربط حساب تيليجرام، محفوظة في الخادم بصلاحية زمنية ومشفّرة.
-- المرجع: §3.1–§3.4 (ربط الحساب عبر MTProto وإدارة حالته)، D02 (عزل الهوية)، D08 (حساب خاص بكل مستخدم).
-- لا يُخزَّن رمز التحقق ولا كلمة مرور التحقق بخطوتين في أي مكان؛ يُخزَّن فقط ما يلزم لإكمال الطلب
-- (رقم الهاتف وphone_code_hash وجلسة MTProto المؤقتة) داخل مغلّف مشفّر AES-256-GCM.

-- بصمة رقم الهاتف (SHA-256 مع مفتاح النظام) لمنع تكرار ربط الرقم نفسه لنفس المستخدم
-- دون تخزين الرقم الكامل (D06/§3.3: لا يُحفظ الرقم الكامل).
alter table telegram_accounts add column phone_hash text;

alter table telegram_accounts
  add constraint telegram_accounts_phone_hash_format
  check (phone_hash is null or phone_hash ~ '^[0-9a-f]{64}$');

comment on column telegram_accounts.phone_hash is
  'بصمة SHA-256 (بمفتاح النظام) للرقم المطبَّع؛ لمنع التكرار فقط، ولا يمكن استرجاع الرقم منها.';

-- حساب واحد لكل (مستخدم، رقم) ما دام غير مفصول؛ الحسابات المفصولة تبقى كسجل تاريخي بلا هوية.
create unique index telegram_accounts_user_phone_active_uidx
  on telegram_accounts (user_id, phone_hash)
  where phone_hash is not null and status <> 'revoked';

create type telegram_login_stage as enum (
  'code',      -- بانتظار رمز الدخول
  'password'   -- بانتظار كلمة مرور التحقق بخطوتين
);

create table telegram_login_challenges (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references telegram_accounts (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  stage telegram_login_stage not null default 'code',
  -- مغلّف AES-256-GCM يحتوي: { phoneNumber, phoneCodeHash, tempSession }.
  -- AAD مربوط بمعرّف الحساب وبنوع السجل، فلا يُعاد استخدام مغلّف جلسة عادية هنا.
  ciphertext bytea not null,
  key_version smallint not null default 1,
  code_attempts smallint not null default 0,
  password_attempts smallint not null default 0,
  resend_count smallint not null default 0,
  last_sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_login_ciphertext_min check (octet_length(ciphertext) > 28),
  constraint telegram_login_key_version_positive check (key_version >= 1),
  constraint telegram_login_attempts_nonnegative check (code_attempts >= 0 and password_attempts >= 0),
  constraint telegram_login_resend_range check (resend_count between 0 and 20),
  constraint telegram_login_expiry_after_creation check (expires_at > created_at)
);

-- محاولة نشطة واحدة كحد أقصى لكل حساب: يمنع المحاولات المتوازية والجلسات المكررة.
create unique index telegram_login_challenges_one_active_uidx
  on telegram_login_challenges (account_id)
  where consumed_at is null;

create index telegram_login_challenges_user_idx
  on telegram_login_challenges (user_id, created_at desc);

create index telegram_login_challenges_expiry_idx
  on telegram_login_challenges (expires_at)
  where consumed_at is null;

create trigger telegram_login_challenges_set_updated_at
before update on telegram_login_challenges
for each row execute function set_updated_at();

comment on table telegram_login_challenges is
  'حالة ربط مؤقتة لكل حساب: مشفّرة، بصلاحية زمنية، وبعدد محاولات محدود؛ تُستهلك عند النجاح أو الإلغاء.';
