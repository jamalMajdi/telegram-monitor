-- 0010_rule_config
-- الغرض: الخطوة الخامسة (5-أ) — إعدادات الفلترة: قواميس الكلمات والمرادفات، ومجموعات القواعد
--        (فلاتر اليوم وتُعاد للتصنيف في الخطوة السادسة بقرار Q8)، وشروطها، وربطها بالمصادر، وإصدار الإعدادات.
-- المرجع: §6.2–§6.5 (أنواع الشروط والمجموعات)، §12.4 (إدارة الفلاتر والقاموس)، §6.6 (تطبيع عربي محافظ)،
--          القرارات المعتمدة: Q8 (نموذج قواعد موحّد)، Q9 (فلتر مرتبط صراحةً)، D02 (عزل الملكية)، S21 (مؤشرات على المصدر).
-- لا يُخزَّن هنا أي نص رسالة؛ الجداول إعدادات يملكها المستخدم فقط.

create type dictionary_kind as enum ('keywords', 'synonyms', 'request_patterns', 'exclusions', 'vocabulary');
create type rule_kind as enum ('filter', 'classification');
create type rule_scope as enum ('all_sources', 'bound_sources');
create type rule_applies_to as enum ('any', 'text', 'caption');
create type condition_mode as enum ('all', 'any');
create type term_match_mode as enum ('word', 'phrase', 'contains');

-- ─────────────────────────────────────────────────────────────────────────────
-- القواميس: كل مستخدم يملك قواميسه؛ النصوص تُحفظ مطبَّعة أيضاً لتسريع المطابقة وكشف التكرار.
-- ─────────────────────────────────────────────────────────────────────────────
create table dictionaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  name text not null,
  kind dictionary_kind not null default 'keywords',
  enabled boolean not null default true,
  -- إصدار يتغيّر مع أي تعديل على مصطلحات القاموس (يُستخدم في بصمة الإعدادات).
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dictionaries_name_length check (char_length(name) between 1 and 80),
  constraint dictionaries_user_name_key unique (user_id, name),
  -- هدف صالح لمفتاح أجنبي مركّب يحمل الملكية.
  constraint dictionaries_id_user_key unique (id, user_id)
);

create index dictionaries_user_idx on dictionaries (user_id, created_at desc);

create trigger dictionaries_set_updated_at
before update on dictionaries
for each row execute function set_updated_at();

create table dictionary_terms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  dictionary_id uuid not null,
  -- المصطلح كما كتبه المستخدم (يُعرض في اللوحة).
  term text not null,
  -- نسخة مطبَّعة تُستخدم للمطابقة فقط (لا تُعرض).
  term_normalized text not null,
  match_mode term_match_mode not null default 'word',
  -- مجموعة مرادفات اختيارية: مصطلحات المجموعة نفسها تُعدّ بدائل لبعضها.
  synonym_group text,
  -- تطبيع أوسع (طي ة/ه) لهذا المصطلح فقط، لتجنّب تطابقات خاطئة عامة (§6.6).
  loose boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  constraint dictionary_terms_term_length check (char_length(term) between 1 and 200),
  constraint dictionary_terms_normalized_length check (char_length(term_normalized) between 1 and 200),
  constraint dictionary_terms_synonym_length check (synonym_group is null or char_length(synonym_group) <= 60),
  constraint dictionary_terms_dictionary_owner_fkey
    foreign key (dictionary_id, user_id) references dictionaries (id, user_id) on delete cascade,
  -- لا تكرار لنفس المصطلح المطبَّع داخل القاموس نفسه.
  constraint dictionary_terms_unique unique (dictionary_id, term_normalized),
  constraint dictionary_terms_id_user_key unique (id, user_id)
);

create index dictionary_terms_dictionary_idx on dictionary_terms (dictionary_id, enabled);
create index dictionary_terms_user_idx on dictionary_terms (user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- مجموعات القواعد: فلتر (§6.5) أو تصنيف (§8). النموذج موحّد بقرار Q8.
-- ─────────────────────────────────────────────────────────────────────────────
create table rule_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  kind rule_kind not null,
  name text not null,
  description text,
  enabled boolean not null default true,
  -- ترتيب التقييم/التصنيف؛ الأصغر أولاً، مع كسر تعادل معلَن (created_at ثم id).
  priority integer not null default 100,
  -- all_sources: يطبَّق على كل مصادر المستخدم؛ bound_sources: بالمصادر المربوطة فقط (Q9).
  -- الافتراضي: ينطبق على كل مصادر المستخدم. التقييد بمصادر محددة اختيار صريح (scope='bound_sources').
  scope rule_scope not null default 'all_sources',
  -- نوع المحتوى الذي يُقيَّم عليه الشرط (§6.2 «تخصيص القواعد حسب نوع الرسالة»).
  applies_to rule_applies_to not null default 'any',
  -- قاموس افتراضي يُوسَّع في كل شروط المجموعة (اختياري).
  dictionary_id uuid,
  version bigint not null default 1,
  is_builtin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rule_sets_name_length check (char_length(name) between 1 and 80),
  constraint rule_sets_description_length check (description is null or char_length(description) <= 300),
  constraint rule_sets_priority_range check (priority between 0 and 10000),
  constraint rule_sets_dictionary_owner_fkey
    foreign key (dictionary_id, user_id) references dictionaries (id, user_id) on delete set null (dictionary_id),
  constraint rule_sets_user_kind_name_key unique (user_id, kind, name),
  constraint rule_sets_id_user_key unique (id, user_id)
);

create index rule_sets_user_kind_idx on rule_sets (user_id, kind, enabled, priority);

create trigger rule_sets_set_updated_at
before update on rule_sets
for each row execute function set_updated_at();

-- الشروط: تُقيَّم بـAND بينها. negate = مجموعة استبعاد (§6.4).
create table rule_conditions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  rule_set_id uuid not null,
  position smallint not null,
  mode condition_mode not null default 'any',
  negate boolean not null default false,
  -- للوضع any: أقل عدد مصطلحات يجب وجوده (1 = واحدة على الأقل).
  min_matches smallint not null default 1,
  -- قاموس يُضاف إلى مصطلحات الشرط (اختياري).
  dictionary_id uuid,
  constraint rule_conditions_position_range check (position between 1 and 50),
  constraint rule_conditions_min_range check (min_matches between 1 and 50),
  constraint rule_conditions_rule_owner_fkey
    foreign key (rule_set_id, user_id) references rule_sets (id, user_id) on delete cascade,
  constraint rule_conditions_dictionary_owner_fkey
    foreign key (dictionary_id, user_id) references dictionaries (id, user_id) on delete set null (dictionary_id),
  constraint rule_conditions_position_key unique (rule_set_id, position),
  constraint rule_conditions_id_user_key unique (id, user_id)
);

create index rule_conditions_rule_idx on rule_conditions (rule_set_id, position);

-- مصطلحات الشرط: إمّا مرجع لمصطلح في قاموس، أو نص حرفي — واحد فقط (تحقق صريح).
create table condition_terms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  condition_id uuid not null,
  dictionary_term_id uuid,
  literal text,
  literal_normalized text,
  -- تجاوز نمط المطابقة لهذا الموضع فقط (اختياري).
  match_mode term_match_mode,
  constraint condition_terms_rule_owner_fkey
    foreign key (condition_id, user_id) references rule_conditions (id, user_id) on delete cascade,
  constraint condition_terms_dictionary_term_owner_fkey
    foreign key (dictionary_term_id, user_id) references dictionary_terms (id, user_id) on delete cascade,
  constraint condition_terms_one_source check (num_nonnulls(dictionary_term_id, literal) = 1),
  constraint condition_terms_literal_length check (literal is null or char_length(literal) between 1 and 200),
  constraint condition_terms_literal_normalized_length
    check (literal_normalized is null or char_length(literal_normalized) between 1 and 200),
  constraint condition_terms_literal_needs_normalized
    check (literal is null or literal_normalized is not null),
  constraint condition_terms_dictionary_unique unique (condition_id, dictionary_term_id),
  constraint condition_terms_literal_unique unique (condition_id, literal_normalized)
);

create index condition_terms_condition_idx on condition_terms (condition_id);

-- ربط الفلاتر بالمصادر (§6.5). يكفي وجود صف فعّال واحد لاعتبار الفلتر مرتبطاً بالمصدر.
create table filter_source_bindings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  filter_id uuid not null,
  source_id uuid not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  constraint filter_source_bindings_filter_owner_fkey
    foreign key (filter_id, user_id) references rule_sets (id, user_id) on delete cascade,
  constraint filter_source_bindings_source_owner_fkey
    foreign key (source_id, user_id) references telegram_sources (id, user_id) on delete cascade,
  constraint filter_source_bindings_key unique (filter_id, source_id)
);

create index filter_source_bindings_source_idx on filter_source_bindings (source_id, enabled);

-- إصدار إعدادات المعالجة لكل مستخدم: يُرقّى في نفس معاملة أي تعديل على القواميس/القواعد/الروابط،
-- ويُسجَّل مع كل قرار معالجة (بصمة الإعدادات بدل نسخة نصية من القواعد — قرار D09).
create table user_config_state (
  user_id uuid primary key references users (id) on delete cascade,
  processing_version bigint not null default 0,
  seeded_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint user_config_state_version_non_negative check (processing_version >= 0)
);

comment on table dictionaries is 'قاموس كلمات/مرادفات/صيغ طلب يملكه مستخدم واحد؛ لا نص رسائل.';
comment on table rule_sets is 'مجموعة قواعد (فلتر أو تصنيف) بنموذج موحّد؛ الشرط يسري بترتيب priority مع كسر تعادل معلَن.';
comment on table condition_terms is 'مصطلح شرط: مرجع قاموس أو نص حرفي مع نسخته المطبَّعة.';
comment on table user_config_state is 'إصدار إعدادات المعالجة: يُبصم به كل قرار ولا يُخزَّن نص القاعدة مع الرسالة.';
