-- 0017_publish_parts_attempts_evidence
-- الغرض: الدفعتان 7-ج و7-د — خطة الأجزاء النصية، محاولات الإرسال، وأدلة التحقق من الحالة المجهولة.
-- المرجع: §10.5 (التنسيق والتحقق بعد تحويل تيليجرام)، D10/O04 (تجاوُز الحد وتصنيف الأخطاء)،
--          O04 (المجهول لا يُعاد تلقائياً ويحتاج دليلاً)، §10.6 (سجل المحاولات والنتيجة)،
--          Q11 (التحقق اليدوي للحالة المجهولة)، Q12 (احتفاظ مستقل: النص يُمسح مع المحتوى).
--
-- لا يُخزَّن في السجلات أي رمز بوت ولا أي قيمة تواصل خامة: أجزاء النص **محجوبة ومنسَّقة** فقط،
-- و`delivery_attempts` لا يحمل نصاً إطلاقاً.

create type delivery_part_status as enum ('pending', 'sending', 'sent', 'failed', 'uncertain');
create type delivery_attempt_outcome as enum ('started', 'ok', 'retryable', 'permanent', 'uncertain');

create table delivery_parts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references deliveries (id) on delete cascade,
  -- ترتيب الجزء داخل التسليم (1..n) — فريد: لا إرسال مكرر للجزء نفسه.
  part_index smallint not null,
  -- نص الجزء بصيغة HTML الآمنة بعد الحجب والتحقق النهائي.
  text text not null,
  -- بصمة sha-256 للكشف عن أي تغيير غير مقصود بين التخطيط والإرسال.
  text_hash text not null,
  -- الطول كما تحسبه تيليجرام: بعد تحليل الكيانات (بلا وسوم HTML).
  char_count integer not null,
  status delivery_part_status not null default 'pending',
  telegram_message_id bigint,
  sent_at timestamptz,
  attempts smallint not null default 0,
  last_error_code text,
  -- استحواذ العامل: قفل زمني يمنع إرسال الجزء من عاملين.
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_parts_index_positive check (part_index >= 1),
  constraint delivery_parts_char_count_range check (char_count between 1 and 4096),
  constraint delivery_parts_text_not_empty check (char_length(text) > 0),
  constraint delivery_parts_hash_format check (text_hash ~ '^[0-9a-f]{64}$'),
  constraint delivery_parts_error_code_length
    check (last_error_code is null or char_length(last_error_code) <= 64),
  constraint delivery_parts_index_key unique (delivery_id, part_index)
);

create index delivery_parts_delivery_idx on delivery_parts (delivery_id, part_index);
create index delivery_parts_lease_idx on delivery_parts (lease_expires_at)
  where status = 'sending';

create trigger delivery_parts_set_updated_at
before update on delivery_parts
for each row execute function set_updated_at();

comment on table delivery_parts is
  'أجزاء المنشور الواحد: نص محجوب ومنسَّق بطول ≤4096 بعد تحليل الكيانات. يُمسح النص مع انتهاء احتفاظ المحتوى.';

create table delivery_attempts (
  id bigserial primary key,
  delivery_id uuid not null references deliveries (id) on delete cascade,
  part_id uuid references delivery_parts (id) on delete cascade,
  attempt_no smallint not null,
  -- يُكتب الصف **قبل** طلب HTTP (حفظ المحاولة قبل الطلب) ثم يُغلق بعد الاستجابة.
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome delivery_attempt_outcome not null default 'started',
  http_status integer,
  telegram_error_code integer,
  error_code text,
  -- وصف قصير منقّح: بلا رمز بوت وبلا نص رسالة.
  error_detail text,
  retry_after_seconds integer,
  duration_ms integer,
  constraint delivery_attempts_attempt_positive check (attempt_no >= 1),
  constraint delivery_attempts_code_length check (error_code is null or char_length(error_code) <= 64),
  constraint delivery_attempts_detail_length check (error_detail is null or char_length(error_detail) <= 200),
  constraint delivery_attempts_key unique (delivery_id, part_id, attempt_no)
);

create index delivery_attempts_delivery_idx on delivery_attempts (delivery_id, started_at desc);

comment on table delivery_attempts is
  'محاولات الإرسال: صف يُفتح قبل الطلب ويُغلق بعده؛ لا نص ولا أسرار.';

create table delivery_evidence (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references deliveries (id) on delete cascade,
  part_id uuid references delivery_parts (id) on delete set null,
  -- من قدّم الدليل (مسؤول عن القرار — O04) ووقته.
  user_id uuid not null references users (id) on delete cascade,
  method text not null,
  decision text not null,
  telegram_message_id bigint,
  note text,
  decided_at timestamptz not null default now(),
  constraint delivery_evidence_method_allowed check (method in ('message_id', 'manual_check')),
  constraint delivery_evidence_decision_allowed check (decision in ('published', 'not_published')),
  constraint delivery_evidence_note_length check (note is null or char_length(note) <= 200)
);

create index delivery_evidence_delivery_idx on delivery_evidence (delivery_id, decided_at desc);

comment on table delivery_evidence is
  'أدلة بشرية على نتيجة إرسال مجهولة (O04): معرّف رسالة مُشاهد أو تأكيد صريح بعدم النشر.';

-- استحواذ العامل على التسليم نفسه (بالإضافة إلى استحواذ الجزء).
alter table deliveries
  add column lease_owner text,
  add column lease_expires_at timestamptz;

create index deliveries_lease_idx on deliveries (lease_expires_at) where status = 'sending';
