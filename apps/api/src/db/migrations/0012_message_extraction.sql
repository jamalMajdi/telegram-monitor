-- 0012_message_extraction
-- الغرض: الخطوة 5-ج — الاستخراج المقيَّد بالقرائن واكتشاف فئات التواصل (F05، §7.1–§7.5، O03).
--
-- قرارات ومبادئ منفَّذة:
-- - كل قيمة مستخرجة مرتبطة بموضعها في النص الأصلي (`span_start`/`span_end`) ⇒ تدقيق بشري ممكن (§7.5).
-- - لا اختراع: `value_text` دائماً مقتطعة حرفياً من النص المصدر، وقيد `span_end > span_start` يمنع القيم الفارغة.
-- - الحقول اختيارية: الحقل الغائب يُحذف ولا يُملأ بقيمة افتراضية (§7.4) — لا صف ⇒ لا حقل.
-- - فئات التواصل تُخزَّن مع صيغة عرض محجوبة (`value_masked`) إضافة إلى الخام (O03): الحجب افتراضي في أي عرض لاحق.
-- - الاستخراج «نتيجة» لا «محتوى مصدر»: تُحذف مع انتهاء احتفاظ المحتوى (Q12)، وتبقى الهوية وبصمتها.

create type extraction_source as enum ('text', 'caption');

create type contact_kind as enum ('phone', 'username', 'telegram_id', 'email', 'url', 'invite_link');

-- 1) الحقول المستخرجة: صف لكل (هوية، حقل، موضع).
create table message_extraction (
  identity_id uuid not null references message_identity (id) on delete cascade,
  field_key text not null,
  -- القيمة كما وردت في النص المصدر (بعد قصّ المسافات الطرفية فقط).
  value_text text not null,
  span_start integer not null,
  span_end integer not null,
  source extraction_source not null,
  -- القرينة التي أثبتت الحقل (للتدقيق: لماذا استُخرجت هذه القيمة؟).
  cue text not null,
  confidence numeric(3, 2) not null,
  ambiguous boolean not null default false,
  extraction_version integer not null,
  created_at timestamptz not null default now(),
  primary key (identity_id, field_key, span_start, span_end),
  constraint message_extraction_field_key_allowed check (
    field_key in (
      'request_type', 'role', 'subject', 'details', 'organization', 'location', 'budget',
      'deadline', 'qualifications', 'experience', 'apply_method', 'area_size', 'specs',
      'question_count', 'technologies'
    )
  ),
  constraint message_extraction_span_valid check (span_start >= 0 and span_end > span_start),
  constraint message_extraction_value_length check (char_length(value_text) between 1 and 200),
  constraint message_extraction_confidence_range check (confidence >= 0 and confidence <= 1)
);

create index message_extraction_field_idx on message_extraction (field_key, created_at desc);
create index message_extraction_identity_idx on message_extraction (identity_id);

comment on table message_extraction is
  'حقول مستخرجة بالقرائن من الرسائل المطابقة فقط، كل قيمة بموضعها (span) وثقتها. تُحذف مع احتفاظ المحتوى.';

-- 2) فئات التواصل المرصودة (O03): الخام + المطبَّع + المحجوب.
create table message_contacts (
  identity_id uuid not null references message_identity (id) on delete cascade,
  contact_kind contact_kind not null,
  value_raw text not null,
  -- صيغة مطبَّعة للمقارنة (أرقام لاتينية بلا رموز، أو اسم مستخدم بحروف صغيرة).
  value_normalized text not null,
  -- صيغة العرض الآمنة افتراضياً (O03) — لا تُعرض القيمة الخام في الواجهات.
  value_masked text not null,
  span_start integer not null,
  span_end integer not null,
  source extraction_source not null,
  confidence numeric(3, 2) not null,
  ambiguous boolean not null default false,
  extraction_version integer not null,
  created_at timestamptz not null default now(),
  primary key (identity_id, contact_kind, span_start, span_end),
  constraint message_contacts_span_valid check (span_start >= 0 and span_end > span_start),
  constraint message_contacts_value_length check (char_length(value_raw) between 1 and 200),
  constraint message_contacts_confidence_range check (confidence >= 0 and confidence <= 1)
);

create index message_contacts_identity_idx on message_contacts (identity_id);
create index message_contacts_kind_idx on message_contacts (contact_kind, created_at desc);

comment on table message_contacts is
  'أرقام/معرّفات/روابط تواصل مستخرجة مع صيغة محجوبة جاهزة للعرض؛ تُحذف مع احتفاظ المحتوى.';

-- 3) حالة الاستخراج على الهوية + عدّاد المصدر.
alter table message_identity
  add column extraction_version integer,
  add column extraction_count integer not null default 0,
  add column contact_count integer not null default 0,
  add column extracted_at timestamptz;

alter table message_identity
  add constraint message_identity_extraction_count_non_negative check (extraction_count >= 0),
  add constraint message_identity_contact_count_non_negative check (contact_count >= 0);

alter table telegram_sources
  add column extracted_count bigint not null default 0;

alter table telegram_sources
  add constraint telegram_sources_extracted_count_non_negative check (extracted_count >= 0);
