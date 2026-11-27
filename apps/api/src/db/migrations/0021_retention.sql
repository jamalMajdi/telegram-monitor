-- 0021 — الاحتفاظ الموحّد (P4-د، Q23) وإعدادات المستخدم الجديدة.
--
-- كل سياسة احتفاظ تُنفَّذ بمشغّل دوري واحد داخل العملية، وكل تشغيل يُسجَّل صفاً في `retention_runs`
-- (ماذا، متى، كم حُذف، وهل فشل). الغرض: إثبات التنظيف لا الادّعاء به.

create table retention_runs (
  id bigserial primary key,
  policy text not null,
  -- من طلب التشغيل: المهمة الدورية، أو المدير، أو صاحب الحساب (حذف بياناته).
  triggered_by text not null default 'scheduler',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  deleted integer not null default 0,
  -- رمز فشل آلي قصير؛ لا نص استثناء خام.
  error_code text,
  constraint retention_runs_policy_allowed
    check (policy in ('content', 'identities', 'deliveries', 'error_events', 'audit_events')),
  constraint retention_runs_trigger_allowed
    check (triggered_by in ('scheduler', 'admin', 'user')),
  constraint retention_runs_deleted_non_negative check (deleted >= 0),
  constraint retention_runs_error_code_shape
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{2,40}$'),
  constraint retention_runs_finished_after_start
    check (finished_at is null or finished_at >= started_at)
);

create index retention_runs_started_idx on retention_runs (started_at desc);
create index retention_runs_policy_idx on retention_runs (policy, started_at desc);

comment on table retention_runs is
  'سجل تشغيل سياسات الاحتفاظ (Q23): صف لكل سياسة في كل تشغيل، بماذا ومتى وكم حُذف — إثبات لا ادّعاء.';

-- فهرس تنظيف التسليمات المنتهية: (created_at) وحده يكفي لأن الشرط الأساسي زمني.
create index deliveries_created_at_idx on deliveries (created_at);

-- سياسات النظام العامة: يقرأها المشغّل، ويستطيع المدير تعديلها من /admin/settings.
insert into system_settings (key, value, description)
values
  ('system.error_events_retention_days', '{"days": 30}'::jsonb, 'مدة احتفاظ سجل الأخطاء بالأيام (Q19)'),
  ('system.audit_retention_days', '{"days": 180}'::jsonb, 'مدة احتفاظ سجل التدقيق بالأيام (§14)')
on conflict (key) do nothing;
