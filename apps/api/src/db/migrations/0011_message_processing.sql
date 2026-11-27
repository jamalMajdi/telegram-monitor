-- 0011_message_processing
-- الغرض: الخطوة 5-ب — تخزين محتوى الرسائل **المطابقة فقط** + نتائج المطابقة على مستوى الفلتر (§6، §9، §14).
--
-- قرارات معتمدة تُنفَّذ هنا:
-- - Q1/S20: يُخزَّن نص الرسائل المطابقة وحدها، وبمدة احتفاظ المحتوى (افتراضياً 48 ساعة).
-- - Q2: محتوى الرسالة منفصل تماماً عن هويتها: الهوية تبقى 30 يوماً، والمحتوى/النتائج 48 ساعة.
--   لا نسخة «مطبَّعة» ولا «معروضة» تُخزَّن — النص الأصلي فقط كما ورد (D04: لا يُحرَّف الأصل).
-- - Q3: الرسالة بلا نص ولا تعليق (وسائط فقط) تُحتسب `ignored` ولا يُخزَّن لها محتوى.
-- - Q11: تجاوز الحد (4096 نص / 1024 تعليق، وسقف دفاعي 8192) ⇒ `ignored/too_long` بلا اقتطاع.
-- - Q6: `is_repeat` يُسجَّل الآن (بصمة المحتوى)، ومنع النشر النهائي مؤجَّل إلى المرحلة الثالثة.
-- - Q7: النتائج غير المؤكدة تبقى `matched/processed` مع `review_state` للمراجعة.
-- - Q12: سياسة احتفاظ مستقلة للمحتوى والنتائج، وبصمة المحتوى تبقى مع الهوية لمدة الهوية (30 يوماً).

-- 1) حالة معالجة الرسالة على صف الهوية (الهوية تبقى بعد حذف المحتوى، Q12).
create type message_state as enum ('matched', 'ignored', 'processed', 'failed');

create type message_ignore_reason as enum (
  'too_long',       -- تجاوز حد الطول المعتمد (Q11) — بلا اقتطاع
  'no_text',        -- رسالة وسائط/خدمة بلا نص ولا تعليق (Q3)
  'no_filter',      -- لا فلتر مطابق (سبب F04 المعتاد)
  'no_source_filter', -- لا يوجد أي فلتر ينطبق على هذا المصدر (Q9: تحذير في الواجهة)
  'self_message',   -- رسالة الحساب نفسه والمصدر لا يسمح بها
  'paused_source',  -- مصدر موقوف
  'processing_disabled' -- المعالجة معطّلة بالبيئة
);

create type message_review_state as enum ('none', 'needs_review', 'reviewed');

alter table message_identity
  add column state message_state not null default 'ignored',
  add column ignore_reason message_ignore_reason,
  add column matched_count integer not null default 0,
  -- بصمة المحتوى (sha-256 hex) تبقى بعد حذف المحتوى لكشف التكرار (§9) لمدة الهوية.
  add column content_hash text,
  add column is_repeat boolean not null default false,
  add column review_state message_review_state not null default 'none',
  -- إصدارات القرار: إعدادات المعالجة + التطبيع ⇒ إعادة إنتاج النتيجة نفسها (F04، §6.6).
  add column processing_version bigint,
  add column normalization_version integer,
  add column attempts integer not null default 0,
  add column processing_error_code text,
  add column processed_at timestamptz,
  add column content_purged_at timestamptz;

alter table message_identity
  add constraint message_identity_matched_count_non_negative check (matched_count >= 0),
  add constraint message_identity_attempts_non_negative check (attempts >= 0),
  add constraint message_identity_content_hash_format
    check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  add constraint message_identity_processing_error_code_length
    check (processing_error_code is null or char_length(processing_error_code) <= 64),
  -- الاتساق: سبب التجاهل موجود فقط عندما تكون الحالة `ignored`.
  add constraint message_identity_ignore_reason_consistency
    check ((state = 'ignored') or ignore_reason is null),
  add constraint message_identity_matched_count_consistency
    check (state <> 'matched' or matched_count >= 1);

create index message_identity_state_idx on message_identity (user_id, state, first_seen_at desc);
create index message_identity_content_hash_idx on message_identity (user_id, content_hash)
  where content_hash is not null;

comment on column message_identity.content_hash is
  'بصمة sha-256 للمحتوى الأصلي: تُستخدم لكشف التكرار (is_repeat) وتبقى بعد حذف المحتوى؛ لا تكشف النص.';

-- 2) محتوى الرسائل المطابقة فقط (Q1) — نص وتعليق منفصلين مع أطوال صريحة، بلا نسخة مطبَّعة (Q2).
create table message_content (
  identity_id uuid primary key references message_identity (id) on delete cascade,
  -- النص الأصلي كما ورد تماماً؛ لا اقتطاع ولا تطبيع ولا تنسيق (D04).
  message_text text,
  caption text,
  text_length integer not null default 0,
  caption_length integer not null default 0,
  content_hash text not null,
  -- وقت انتهاء الاحتفاظ بالمحتوى (لا يُمدَّد بإعادة المحاولة أو التعديل — O06/D09).
  retention_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint message_content_text_length_cap check (text_length <= 4096),
  constraint message_content_caption_length_cap check (caption_length <= 1024),
  constraint message_content_lengths_match
    check (text_length = coalesce(char_length(message_text), 0)
       and caption_length = coalesce(char_length(caption), 0)),
  -- لا صف محتوى فارغ: الرسائل بلا نص ولا تعليق تُحتسب `ignored/no_text` (Q3).
  constraint message_content_not_empty check (text_length + caption_length > 0),
  constraint message_content_hash_format check (content_hash ~ '^[0-9a-f]{64}$')
);

create index message_content_retention_idx on message_content (retention_expires_at);

comment on table message_content is
  'نص الرسائل المطابقة فقط (Q1). يُحذف عند انتهاء retention_expires_at ويبقى صف الهوية وبصمة المحتوى.';

-- 3) نتائج المطابقة: أي فلتر طابق الرسالة وبأي أدلة (F04: تتبّع قابل للتدقيق بلا اختراع).
create table message_matches (
  identity_id uuid not null references message_identity (id) on delete cascade,
  filter_id uuid not null references rule_sets (id) on delete cascade,
  filter_name text not null,
  priority integer not null,
  -- الأدلة: معرّفات الشروط + المصطلحات المطابقة كما كتبها المستخدم (لا نص الرسالة).
  evidence jsonb not null default '[]'::jsonb,
  processing_version bigint not null,
  matched_at timestamptz not null default now(),
  primary key (identity_id, filter_id),
  constraint message_matches_evidence_array check (jsonb_typeof(evidence) = 'array'),
  constraint message_matches_filter_name_length check (char_length(filter_name) between 1 and 80)
);

create index message_matches_filter_idx on message_matches (filter_id, matched_at desc);

comment on table message_matches is
  'مطابقات الفلاتر لكل رسالة (ترتيب priority محفوظ). تُحذف بحذف الهوية أو المحتوى المنتهي.';

-- 4) عدّادات المعالجة على المصدر (Q14: توسيع مؤشرات المصدر بدل جدول منفصل).
alter table telegram_sources
  add column matched_count bigint not null default 0,
  add column ignored_count bigint not null default 0,
  add column failed_count bigint not null default 0,
  add column repeat_count bigint not null default 0;

alter table telegram_sources
  add constraint telegram_sources_matched_count_non_negative check (matched_count >= 0),
  add constraint telegram_sources_ignored_count_non_negative check (ignored_count >= 0),
  add constraint telegram_sources_failed_count_non_negative check (failed_count >= 0),
  add constraint telegram_sources_repeat_count_non_negative check (repeat_count >= 0);
