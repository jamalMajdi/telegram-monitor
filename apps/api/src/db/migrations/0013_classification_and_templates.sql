-- 0013_classification_and_templates
-- الغرض: الخطوة السادسة (أ+ب) — التصنيف الحتمي، القوالب، ومُحدِّد القالب (O02)، ونتائجها على الرسالة.
--
-- مبادئ منفَّذة:
-- - التصنيف يستخدم نفس جدول `rule_sets` بنوع `classification` (Q8): قواعد صريحة، بلا ذكاء اصطناعي مدفوع.
-- - التعديل اليدوي **يغلب في العرض** (O02): صف تلقائي وصف يدوي منفصلان، والعرض يفضّل اليدوي.
-- - أولوية القالب: تخصيص المصدر ← الفلتر ← التصنيف ← الافتراضي. مسار النشر (route) يبقى فارغاً للمرحلة الثالثة.
-- - الحقول الغائبة تُحذف من العرض ولا تُملأ (§7.4)؛ ولا يُخزَّن نص مُعاد تركيبه (يُبنى عند العرض فقط).
-- - كل ما هنا «نتائج» تُحذف مع احتفاظ المحتوى (Q12)، وتبقى الهوية.

create type classification_origin as enum ('automatic', 'manual');

create type template_scope as enum ('source', 'filter', 'classification');

-- 1) القوالب: قالب لكل مستخدم بقائمة حقول مرتَّبة وقابلة للتسمية والتعديل (§7.3).
create table templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  name text not null,
  description text,
  is_builtin boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint templates_name_length check (char_length(name) between 1 and 80),
  constraint templates_user_name_key unique (user_id, name),
  constraint templates_id_user_key unique (id, user_id)
);

create trigger templates_set_updated_at before update on templates
  for each row execute function set_updated_at();

create table template_fields (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  template_id uuid not null,
  position integer not null,
  -- مفتاح الحقل: أحد مفاتيح الاستخراج، أو 'contact' لوسائل التواصل المحجوبة.
  field_key text not null,
  -- الاسم المعروض في المنشور (قابل للتعديل والترتيب دون تغيير المفتاح).
  label text not null,
  enabled boolean not null default true,
  constraint template_fields_owner_fkey
    foreign key (template_id, user_id) references templates (id, user_id) on delete cascade,
  constraint template_fields_field_key_allowed check (
    field_key in (
      'request_type', 'role', 'subject', 'details', 'organization', 'location', 'budget',
      'deadline', 'qualifications', 'experience', 'apply_method', 'area_size', 'specs',
      'question_count', 'technologies', 'contact'
    )
  ),
  constraint template_fields_label_length check (char_length(label) between 1 and 40),
  constraint template_fields_position_non_negative check (position >= 0),
  constraint template_fields_template_position_key unique (template_id, position)
);

create index template_fields_template_idx on template_fields (template_id, position);

-- 2) ربط القوالب: مصدر / فلتر / تصنيف (لكل هدف ربط واحد ⇒ لا تعادل).
create table template_bindings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  template_id uuid not null,
  scope template_scope not null,
  source_id uuid,
  rule_set_id uuid,
  created_at timestamptz not null default now(),
  constraint template_bindings_owner_fkey
    foreign key (template_id, user_id) references templates (id, user_id) on delete cascade,
  constraint template_bindings_source_fkey
    foreign key (source_id, user_id) references telegram_sources (id, user_id) on delete cascade,
  constraint template_bindings_rule_fkey
    foreign key (rule_set_id, user_id) references rule_sets (id, user_id) on delete cascade,
  -- شكل الصف يطابق نطاقه: مصدر ⇒ source_id فقط، فلتر/تصنيف ⇒ rule_set_id فقط.
  constraint template_bindings_target_shape check (
    (scope = 'source' and source_id is not null and rule_set_id is null)
    or (scope <> 'source' and source_id is null and rule_set_id is not null)
  )
);

create unique index template_bindings_source_key on template_bindings (user_id, source_id)
  where scope = 'source';
create unique index template_bindings_rule_key on template_bindings (user_id, rule_set_id)
  where scope <> 'source';

-- 3) القالب الافتراضي للمستخدم (آخر درجة في الأولوية).
alter table user_config_state
  add column default_template_id uuid,
  add constraint user_config_state_default_template_fkey
    foreign key (default_template_id, user_id) references templates (id, user_id) on delete set null (default_template_id);

-- 4) نتيجة التصنيف: صف تلقائي + صف يدوي (العرض يفضّل اليدوي — O02).
create table message_classification (
  identity_id uuid not null references message_identity (id) on delete cascade,
  origin classification_origin not null,
  classification_id uuid not null,
  classification_name text not null,
  confidence numeric(3, 2) not null,
  ambiguous boolean not null default false,
  evidence jsonb not null default '[]'::jsonb,
  classification_version bigint not null,
  classified_at timestamptz not null default now(),
  primary key (identity_id, origin),
  constraint message_classification_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint message_classification_name_length check (char_length(classification_name) between 1 and 80),
  constraint message_classification_evidence_array check (jsonb_typeof(evidence) = 'array')
);

create index message_classification_id_idx on message_classification (classification_id, classified_at desc);

-- 5) القالب المختار لكل رسالة مع سبب الاختيار (قابل للتدقيق).
create table message_template_resolution (
  identity_id uuid primary key references message_identity (id) on delete cascade,
  template_id uuid,
  template_name text,
  resolved_by text not null,
  details jsonb not null default '{}'::jsonb,
  resolved_at timestamptz not null default now(),
  constraint message_template_resolution_template_fkey
    foreign key (template_id) references templates (id) on delete set null,
  constraint message_template_resolution_resolved_by_allowed check (
    resolved_by in ('source', 'filter', 'classification', 'default', 'none')
  )
);

-- 6) عدّاد التصنيف على المصدر (Q14).
alter table telegram_sources
  add column classified_count bigint not null default 0,
  add constraint telegram_sources_classified_count_non_negative check (classified_count >= 0);
