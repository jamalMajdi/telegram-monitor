-- 0004_telegram_accounts_sessions
-- الغرض: أساس ملكية حسابات تيليجرام وتخزين جلسات MTProto **مشفّرة** لكل مستخدم.
-- المرجع: §3 (ربط الحسابات وأمانها)، §2.1 (عزل المساحات)، D02 (عزل الهوية)، D08 (بوت/حساب خاص بكل مستخدم).
-- لا يُخزَّن أي نص رسالة أو وسيط في هذه المرحلة؛ ولا يُسجَّل أي سر في السجلات.

-- حالة الحساب كما تعرضها الواجهة (§3.4): متصل، غير متصل، يعيد المحاولة، يحتاج دخولاً، خطأ.
-- الحالات التشغيلية التفصيلية (connecting/reconnecting) تعيش في ذاكرة مدير الاتصالات،
-- بينما تُحفظ هنا الحالة الدائمة التي تهم المستخدم والتقارير.
create type telegram_account_status as enum (
  'pending_login',   -- أُنشئ السجل ولم يكتمل تسجيل الدخول بعد
  'active',          -- يوجد جلسة صالحة (الاتصال قد يكون قائماً أو لا)
  'needs_reauth',    -- الجلسة أُبطلت أو بيانات الدخول لم تعد صالحة
  'revoked',         -- فُصل الحساب وأُزيلت جلسته
  'suspended'        -- أوقفه مدير النظام
);

create table telegram_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  label text not null,
  -- هوية تيليجرام الفعلية تُملأ بعد نجاح المصادقة فقط.
  telegram_user_id bigint,
  telegram_username text,
  -- يُخزَّن آخر رقمين فقط؛ الرقم الكامل لا يدخل قاعدة البيانات.
  phone_last_digits text,
  status telegram_account_status not null default 'pending_login',
  -- O01: قارئ نشط واحد لكل مصدر داخل المساحة عند تعدد الحسابات؛ الأساس متاح من الآن.
  is_active_reader boolean not null default false,
  last_connected_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_accounts_label_length check (char_length(label) between 2 and 120),
  constraint telegram_accounts_phone_last_digits check (phone_last_digits is null or phone_last_digits ~ '^[0-9]{2}$'),
  constraint telegram_accounts_username_length check (telegram_username is null or char_length(telegram_username) <= 64),
  constraint telegram_accounts_user_id_telegram_id_key unique (user_id, telegram_user_id),
  constraint telegram_accounts_active_reader_requires_identity check (is_active_reader = false or telegram_user_id is not null)
);

create index telegram_accounts_user_idx on telegram_accounts (user_id, created_at desc);
create index telegram_accounts_status_idx on telegram_accounts (status);

create trigger telegram_accounts_set_updated_at
before update on telegram_accounts
for each row execute function set_updated_at();

comment on table telegram_accounts is
  'حساب قراءة عادي مملوك لمستخدم واحد؛ الهوية تُثبت بالمصادقة ولا تُقبل من العميل (§3.1، §3.2).';

create table telegram_sessions (
  account_id uuid primary key references telegram_accounts (id) on delete cascade,
  -- مغلّف AES-256-GCM: [نسخة المغلّف][نسخة المفتاح][IV 12][نص مشفّر][وسم 16].
  -- تشمل AAD معرّف الحساب لمنع نقل الجلسة بين الحسابات.
  ciphertext bytea not null,
  key_version smallint not null default 1,
  -- حالة تحديثات Telegram (pts/qts/date/seq) تُخزَّن **داخل** المغلّف المشفّر
  -- إلى جانب سلسلة الجلسة، فلا تظهر نقطة التقدم كنص صريح في القاعدة.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_sessions_ciphertext_min check (octet_length(ciphertext) > 28),
  constraint telegram_sessions_key_version_positive check (key_version >= 1)
);

create trigger telegram_sessions_set_updated_at
before update on telegram_sessions
for each row execute function set_updated_at();

comment on table telegram_sessions is
  'جلسات MTProto مشفّرة عند الراحة؛ لا تُقرأ إلا لمالك الحساب عبر طبقة الخدمة، ولا تُسجَّل ولا تُعرض في الواجهة.';
