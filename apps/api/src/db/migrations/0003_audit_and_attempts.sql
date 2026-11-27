-- 0003_audit_and_attempts
-- الغرض: سجل تدقيق تشغيلي ومحاولات دخول.
-- المرجع: D07 (الرفض الافتراضي وكل وصول فعلي يُدقّق)، §16 (حماية الواجهات ومنع التخمين).
-- لا تُسجَّل كلمة مرور أو رمز جلسة أو محتوى رسالة في هذا الجدول.

create table audit_events (
  id bigserial primary key,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references users (id) on delete set null,
  actor_role app_role,
  action text not null,
  target_type text,
  target_id text,
  outcome text not null default 'success',
  ip inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  constraint audit_events_action_shape check (action ~ '^[a-z][a-z0-9_.]{2,79}$'),
  constraint audit_events_outcome_values check (outcome in ('success', 'failure', 'denied')),
  constraint audit_events_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint audit_events_target_type_length check (target_type is null or char_length(target_type) <= 40),
  constraint audit_events_target_id_length check (target_id is null or char_length(target_id) <= 120)
);

create index audit_events_occurred_at_idx on audit_events (occurred_at desc);
create index audit_events_actor_idx on audit_events (actor_user_id, occurred_at desc);
create index audit_events_action_idx on audit_events (action, occurred_at desc);
create index audit_events_target_idx on audit_events (target_type, target_id);

-- محاولات الدخول: تُستخدم للقفل المؤقت ومنع التخمين، وتُقيَّد بمدة متغيّرة قابلة للتنظيف.
create table login_attempts (
  id bigserial primary key,
  email_normalized text,
  ip inet,
  outcome text not null,
  created_at timestamptz not null default now(),
  constraint login_attempts_outcome_values
    check (outcome in ('success', 'bad_credentials', 'unknown_user', 'locked', 'suspended'))
);

create index login_attempts_email_idx on login_attempts (email_normalized, created_at desc);
create index login_attempts_ip_idx on login_attempts (ip, created_at desc);
