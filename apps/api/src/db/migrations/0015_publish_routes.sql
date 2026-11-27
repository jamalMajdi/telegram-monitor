-- 0015_publish_routes
-- الغرض: الدفعة 7-ب — محرك التوجيه: مسارات (مصادر/فلاتر/تصنيفات ← وجهة)، ورسوم الحواف الفعّالة لفحص الحلقات.
-- المرجع: §10.3 (علاقة متعدد-إلى-متعدد بين المصادر والوجهات مع فلترة لكل وجهة)، §10.4 (نشر تلقائي افتراضياً
--          ومراجعة اختيارية لكل مسار)، §10.5 (قالب لكل مسار)، Q3 (شروط «أيٌّ من»)، Q5 (سياسة الطول لكل مسار)،
--          Q14/O05 (فحص حلقات ذري بمعرّفات فنية على الرسم الفعّال).
--
-- الحواف (`routing_edges`) مشتقة من المسارات الفعّالة، وتُبنى في نفس معاملة التفعيل قبل الفحص،
-- وتُستخدم للمقارنة الفنية فقط (chat_id) — لا تُعرض لأي مستخدم ولا تكشف إعدادات غيره.

create type route_publish_mode as enum ('auto', 'review');
create type route_length_policy as enum ('split', 'reject');
create type route_scope_kind as enum ('source', 'filter', 'classification');
create type route_status as enum ('draft', 'active', 'paused');

create table publish_routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  destination_id uuid not null,
  name text not null,
  -- قالب المسار: أعلى أولوية في تحديد القالب (O02). فارغ ⇒ يُستخدم القالب المحدَّد في المعالجة.
  template_id uuid,
  publish_mode route_publish_mode not null default 'auto',
  -- D10 مع تعديل Q5 المعتمد: التقسيم افتراضياً، والرفض خيار لكل مسار.
  length_policy route_length_policy not null default 'split',
  -- سقف أجزاء المنشور الواحد (يمنع انفجار الأجزاء عند نص شاذ).
  max_parts smallint not null default 10,
  status route_status not null default 'draft',
  -- سبب آخر رفض/تعطيل (رمز فني قصير فقط، بلا محتوى).
  last_error_code text,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint publish_routes_destination_owner_fkey
    foreign key (destination_id, user_id) references destinations (id, user_id) on delete cascade,
  constraint publish_routes_template_owner_fkey
    foreign key (template_id, user_id) references templates (id, user_id) on delete set null (template_id),
  constraint publish_routes_name_length check (char_length(name) between 1 and 80),
  constraint publish_routes_max_parts_range check (max_parts between 1 and 50),
  constraint publish_routes_error_code_length
    check (last_error_code is null or char_length(last_error_code) <= 64),
  constraint publish_routes_user_name_key unique (user_id, name),
  constraint publish_routes_id_user_key unique (id, user_id)
);

create index publish_routes_user_idx on publish_routes (user_id, created_at desc);
create index publish_routes_destination_idx on publish_routes (destination_id, status);

create trigger publish_routes_set_updated_at
before update on publish_routes
for each row execute function set_updated_at();

comment on table publish_routes is
  'مسار نشر: شروط (مصادر/فلاتر/تصنيفات) ← وجهة واحدة، بقالب وسياسة مراجعة وسياسة طول.';

-- شروط المسار: أيٌّ منها يحقّق الانطباق (Q3). مستخدم صراحةً: مصدر أو فلتر أو تصنيف.
create table route_scopes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  route_id uuid not null,
  kind route_scope_kind not null,
  source_id uuid,
  rule_set_id uuid,
  created_at timestamptz not null default now(),
  constraint route_scopes_route_owner_fkey
    foreign key (route_id, user_id) references publish_routes (id, user_id) on delete cascade,
  constraint route_scopes_source_owner_fkey
    foreign key (source_id, user_id) references telegram_sources (id, user_id) on delete cascade,
  constraint route_scopes_rule_owner_fkey
    foreign key (rule_set_id, user_id) references rule_sets (id, user_id) on delete cascade,
  -- الشكل يطابق النوع: مصدر ⇒ source_id فقط، فلتر/تصنيف ⇒ rule_set_id فقط.
  constraint route_scopes_shape check (
    (kind = 'source' and source_id is not null and rule_set_id is null)
    or (kind <> 'source' and source_id is null and rule_set_id is not null)
  ),
  constraint route_scopes_target_key unique (route_id, kind, source_id, rule_set_id)
);

create index route_scopes_route_idx on route_scopes (route_id, kind);
create index route_scopes_source_idx on route_scopes (source_id) where source_id is not null;
create index route_scopes_rule_idx on route_scopes (rule_set_id) where rule_set_id is not null;

comment on table route_scopes is
  'شرط انطباق مسار: مصدر مراقب، أو فلتر مطابق، أو تصنيف فعّال. الانطباق بـ«أيٍّ من» (Q3).';

-- رسم التوجيه الفعّال (O05): حافة لكل (قناة مصدر ← قناة وجهة) لمسار فعّال.
-- البناء يشمل المسارات التي بلا شروط مصادر عبر كل مصادر المستخدم (تقريب محافظ: حواف أكثر ⇒ رفض أكثر لا أقل).
create table routing_edges (
  from_chat_id bigint not null,
  to_chat_id bigint not null,
  route_id uuid not null references publish_routes (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  source_id uuid,
  destination_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (from_chat_id, to_chat_id, route_id),
  constraint routing_edges_not_self check (from_chat_id <> to_chat_id)
);

create index routing_edges_from_idx on routing_edges (from_chat_id);
create index routing_edges_to_idx on routing_edges (to_chat_id);
create index routing_edges_route_idx on routing_edges (route_id);

comment on table routing_edges is
  'حواف التوجيه الفعّالة بمعرّفات فنية للفحص الذري للحلقات فقط؛ تُبنى في معاملة التفعيل وتُحذف عند التعطيل.';
