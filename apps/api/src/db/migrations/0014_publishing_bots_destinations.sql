-- 0014_publishing_bots_destinations
-- الغرض: الدفعة 7-أ — بوت النشر الخاص بكل مستخدم، ووجهات النشر (قنوات/مجموعات) مع نتيجة تحقق الصلاحيات.
-- المرجع: §10.1 (النشر عبر Bot API مع صلاحيات في القناة)، §12.6 (إضافة قناة، ربطها بالبوت، اختبار الصلاحيات)،
--          D01 (لا نشر بلا تحقق)، D08 (بوت خاص لكل مستخدم)، Q1 (تشفير رمز البوت بمغلّف AES-256-GCM)،
--          Q9 (بوت واحد فعّال لكل مستخدم)، Q15 (حذف الوجهة = تعطيل مع إبقاء السجل).
--
-- لا يُخزَّن هنا أي رمز بوت بنص صريح: العمود `token_ciphertext` يحمل مغلّف AES-256-GCM فقط،
-- ومفتاحه في البيئة (TG_BOT_ENC_KEY) خارج قاعدة البيانات والكود والسجلات.

create type publish_bot_status as enum ('active', 'invalid', 'disabled');

create table publish_bots (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  -- اسم تعريفي يختاره المستخدم للعرض فقط.
  label text not null,
  -- هوية البوت كما يعيدها getMe بعد تحقق ناجح (بلا رمز).
  telegram_id bigint,
  username text,
  -- مغلّف AES-256-GCM (نسخة + معرّف مفتاح + IV + نص مشفّر + وسم). AAD يربط المغلّف بمعرّف الصف.
  token_ciphertext bytea not null,
  token_key_version integer not null,
  -- بصمة sha-256 للرمز: لكشف تغيير الرمز وتدقيق تحديثه دون كشفه.
  token_fingerprint text not null,
  status publish_bot_status not null default 'active',
  verified_at timestamptz,
  last_error_code text,
  token_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint publish_bots_label_length check (char_length(label) between 1 and 60),
  constraint publish_bots_username_length check (username is null or char_length(username) <= 64),
  constraint publish_bots_telegram_id_positive check (telegram_id is null or telegram_id > 0),
  constraint publish_bots_key_version_positive check (token_key_version >= 1),
  constraint publish_bots_fingerprint_format check (token_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint publish_bots_error_code_length check (last_error_code is null or char_length(last_error_code) <= 64),
  -- Q9: بوت نشر واحد لكل مستخدم.
  constraint publish_bots_user_key unique (user_id),
  constraint publish_bots_id_user_key unique (id, user_id)
);

create trigger publish_bots_set_updated_at
before update on publish_bots
for each row execute function set_updated_at();

comment on table publish_bots is
  'بوت نشر واحد لكل مستخدم؛ الرمز مشفّر دائماً ولا يُعاد إظهاره بعد الحفظ.';

create type destination_chat_kind as enum ('channel', 'supergroup', 'group');
create type destination_status as enum ('pending', 'active', 'paused', 'revoked', 'error', 'deleted');

create table destinations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  bot_id uuid not null,
  -- الهوية الفنية للوجهة (chat_id الرقمي كما يعيده getChat)؛ سالب للقنوات والمجموعات العظمى.
  chat_id bigint not null,
  chat_kind destination_chat_kind not null,
  title text not null,
  -- اسم مستخدم عام اختياري للعرض والتوضيح فقط.
  username text,
  -- لقطة صلاحيات البوت في الوجهة عند آخر تحقق ناجح (§12.6: اختبار صلاحيات البوت).
  can_post_messages boolean not null default false,
  can_edit_messages boolean not null default false,
  member_status text,
  status destination_status not null default 'pending',
  verified_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint destinations_bot_owner_fkey
    foreign key (bot_id, user_id) references publish_bots (id, user_id) on delete cascade,
  constraint destinations_title_length check (char_length(title) between 1 and 200),
  constraint destinations_username_length check (username is null or char_length(username) <= 64),
  constraint destinations_member_status_length
    check (member_status is null or char_length(member_status) <= 32),
  constraint destinations_error_code_length
    check (last_error_code is null or char_length(last_error_code) <= 64),
  -- وجهة واحدة لكل محادثة داخل مساحة المستخدم (حتى لو تغيّر الاسم).
  constraint destinations_user_chat_key unique (user_id, chat_id),
  constraint destinations_id_user_key unique (id, user_id)
);

create index destinations_user_idx on destinations (user_id, created_at desc);
create index destinations_status_idx on destinations (user_id, status);

create trigger destinations_set_updated_at
before update on destinations
for each row execute function set_updated_at();

comment on table destinations is
  'وجهة نشر (قناة/مجموعة) يعرفها بوت المستخدم بعد تحقق صلاحية النشر؛ الحذف تعطيل (Q15) لا مسح.';
