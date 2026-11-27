-- 0024 — مركز التنبيهات الداخلي (الدفعة P4-و)
--
-- الغرض: تنبيهات حرجة/تحذيرية **داخلية** (تعطّل عامل النشر، تراكم نتائج مجهولة، حسابات
-- تحتاج إعادة دخول، تسليمات بانتظار مراجعة) مع اعتراف المستخدم بها (acknowledge) ودورة حياة
-- نشطة/محلولة واضحة.
--
-- قرارات مقصودة:
-- - **لا نص حر في القاعدة**: لا رسالة تنبيه ولا نص مستخدم. الصف يحمل `alert_key` آلياً فقط
--   (قاموس مغلق بقيد regex)، والواجهة تُترجمه إلى جملة عربية من قوالب ثابتة (D07).
-- - **تنبيه نشط واحد لكل (user_id, alert_key)**: فهرس فريد جزئي على الصفوف غير المحلولة.
--   التكرار يُحدِّث الصف نفسه بدل إغراق المستخدم بمئات الصفوف المتشابهة.
-- - **الحل ثم العودة = صف جديد**: عند اختفاء الحالة يُختم `resolved_at`، وعند عودتها يُنشأ صف
--   جديد — فيبقى السجل تاريخاً قابلاً للقراءة لا يُطمس.
-- - **التصعيد يُعيد فتح التنبيه**: إذا ارتفعت الخطورة (info → warning → critical) يُفرَّغ
--   `acknowledged_at`، لأن الاعتراف بحالة تحذيرية لا يُعدّ اعترافاً بحالة حرجة.
-- - **العدّادات رقمية فقط**: `observed_count` و`payload` (كائن صغير) — لا أرقام تواصل ولا نصوص.

create type alert_severity as enum ('info', 'warning', 'critical');

create table alert_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  alert_key text not null,
  severity alert_severity not null,
  /** قيمة العدّاد التي بُني عليها التنبيه (مثلاً: عدد التسليمات المجهولة). */
  observed_count integer not null default 0,
  /** كم مرة صُعِّد التنبيه أو أُعيد فتحه بعد حلّه — لا يزيد مع كل مسح. */
  occurrences integer not null default 1,
  /** تفصيل رقمي مغلق (أسماء حالات ورموز أخطاء فقط). */
  payload jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  constraint alert_notifications_key_shape check (alert_key ~ '^[a-z][a-z0-9_]{2,39}$'),
  constraint alert_notifications_payload_object check (jsonb_typeof(payload) = 'object'),
  -- حماية من تحويل الصف إلى ناقل نص: الحمولة يجب أن تبقى صغيرة (أرقام ورموز فقط).
  constraint alert_notifications_payload_slim check (char_length(payload::text) <= 400),
  constraint alert_notifications_count_nonnegative check (observed_count >= 0),
  constraint alert_notifications_occurrences_positive check (occurrences >= 1),
  constraint alert_notifications_ack_order check (acknowledged_at is null or acknowledged_at >= first_seen_at),
  constraint alert_notifications_resolved_order check (resolved_at is null or resolved_at >= first_seen_at)
);

-- تنبيه نشط واحد فقط لكل مستخدم ومفتاح.
create unique index alert_notifications_active_key_idx
  on alert_notifications (user_id, alert_key)
  where resolved_at is null;

-- قراءة صندوق الوارد: النشط أولاً ثم الأحدث.
create index alert_notifications_open_idx
  on alert_notifications (user_id, last_seen_at desc, id desc)
  where resolved_at is null;

-- الترقيم المؤشِّر على كل الحالات (سجل تاريخي).
create index alert_notifications_user_time_idx
  on alert_notifications (user_id, last_seen_at desc, id desc);

-- عتبة «تراكم النتائج المجهولة» قبل التصعيد إلى حرج (Q26: عتبات قابلة للضبط لا مضمّنة).
insert into system_settings (key, value, description) values
  ('system.uncertain_alert_threshold', '{"count": 3}'::jsonb,
   'عدد التسليمات المجهولة الذي يرفع التنبيه من تحذير إلى حرج (P4-و)')
on conflict (key) do nothing;
