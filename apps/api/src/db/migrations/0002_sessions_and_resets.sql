-- 0002_sessions_and_resets
-- الغرض: جلسات الويب (جلسات النظام، منفصلة عن جلسات MTProto في المراحل التالية)،
-- ووسائل إعادة تعيين كلمة المرور، وصندوق إشعارات داخلي لتسليمها لاحقاً.
-- المرجع: §2.3 (استعادة كلمة المرور)، §16 (حماية كلمات المرور والواجهات)، D07.

create table user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  -- تُخزَّن بصمة SHA-256 للرمز فقط؛ الرمز الخام لا يُحفظ ولا يُسجَّل.
  token_hash text not null,
  csrf_hash text not null,
  user_agent text,
  ip inet,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  constraint user_sessions_token_hash_key unique (token_hash),
  constraint user_sessions_absolute_after_idle check (absolute_expires_at >= expires_at),
  constraint user_sessions_expiry_future check (expires_at > created_at),
  constraint user_sessions_revocation_consistency check (revoked_at is null or revoked_reason is not null),
  constraint user_sessions_user_agent_length check (user_agent is null or char_length(user_agent) <= 400)
);

create index user_sessions_user_active_idx
  on user_sessions (user_id, expires_at desc)
  where revoked_at is null;

create index user_sessions_expiry_idx on user_sessions (expires_at);

comment on table user_sessions is 'جلسات ويب لجلسة المتصفح فقط؛ لا تحمل أي أسرار تيليجرام.';

create table password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  requested_ip inet,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  invalidated_at timestamptz,
  constraint password_reset_tokens_expiry_future check (expires_at > created_at)
);

create index password_reset_tokens_user_idx on password_reset_tokens (user_id, created_at desc);

-- صندوق إشعارات داخلي (بريد إعادة التعيين حالياً). لا يحتوي رمز الاستعادة نفسه:
-- التسليم الفعلي عبر مزوّد بريد قرار تشغيلي معلّق (O08) ولم يُنفّذ في هذه المرحلة.
create type outbox_channel as enum ('email');
create type outbox_status as enum ('pending', 'sent', 'failed', 'discarded');

create table notification_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users (id) on delete set null,
  channel outbox_channel not null default 'email',
  recipient text not null,
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  status outbox_status not null default 'pending',
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  last_error text,
  constraint notification_outbox_recipient_length check (char_length(recipient) <= 254),
  constraint notification_outbox_template_shape check (template ~ '^[a-z][a-z0-9_.]{2,60}$'),
  constraint notification_outbox_payload_object check (jsonb_typeof(payload) = 'object')
);

create index notification_outbox_pending_idx
  on notification_outbox (created_at)
  where status = 'pending';
