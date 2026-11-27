-- 0019_ops_heartbeats
-- الغرض: المرحلة الرابعة — الدفعة P4-ب. نبض العامل ومهام الخلفية، أساس جهوزية ومراقبة بلا سجلات نصية.
-- المرجع: §13 (مراقبة النظام)، Q17 (/healthz + /readyz + /admin/metrics)، Q18 (نبض مسجَّل لا لقطة ذاكرة)،
--          Q26 (عتبة «العامل متوقف»)، D07 (لا محتوى ولا أسرار في التشغيل).
--
-- لماذا جدول؟ بعد إعادة تشغيل العملية لا توجد ذاكرة تُسأل عنها، ولقطة النبض تسجّل «آخر حياة معروفة» بصدق
-- بدل ادّعاء حالة غير معروفة.

create table worker_heartbeats (
  -- اسم المهمة/العامل: 'publish_worker' | 'retention' ... (ثابت في الكود لا من مدخلات المستخدم)
  name text not null,
  -- تمييز النسخة/العملية داخل نفس الاسم (مثال: worker-<pid>).
  instance text not null,
  last_seen_at timestamptz not null default now(),
  -- بيانات سياقية صغيرة فقط: أعداد ومهل، ولا نصوص رسائل ولا أسرار.
  meta jsonb not null default '{}'::jsonb,
  constraint worker_heartbeats_name_shape check (name ~ '^[a-z][a-z0-9_]{2,40}$'),
  constraint worker_heartbeats_instance_length check (char_length(instance) between 1 and 120),
  constraint worker_heartbeats_meta_object check (jsonb_typeof(meta) = 'object'),
  primary key (name, instance)
);

create index worker_heartbeats_seen_idx on worker_heartbeats (last_seen_at desc);

comment on table worker_heartbeats is
  'نبض العوامل ومهام الخلفية: صف واحد لكل (اسم، نسخة) يُحدَّث كل دورة؛ لا محتوى ولا أسرار.';
