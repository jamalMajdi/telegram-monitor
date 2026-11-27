# المرحلة الثالثة — التوجيه والنشر: تصوّر تقني وتصميمي شامل

> **حالة الوثيقة:** تصميم مقترح للمراجعة والاعتماد. **لم يُكتب أي كود** في هذه المرحلة بعد.
> المرجع: `uploads/main.md` (§9، §10، §11، §12.6، §14، §17، §18) + قرارات المراجعة المعتمدة
> **D01، D05، D08، D09، D10، O02، O03، O04، O05، O06، O07** + ما نُفِّذ فعلياً في المرحلتين الأولى والثانية.

---

## 1) ملخص تنفيذي

المرحلة الثالثة تُغلق الحلقة: من «نتيجة معالجة قابلة للمراجعة» إلى «منشور فعلي في قناة الوجهة،
بسجل قابل للتدقيق، وبلا تكرار ولا حلقات ولا إرسال أعمى». تتكوّن من خمس قدرات مترابطة:

| # | القدرة | جوهر التصميم |
|---|---|---|
| 1 | **البوتات والوجهات** | بوت نشر لكل مستخدم، رمزه مشفّر بمغلّف AES‑256‑GCM، وتحقق فعلي من صلاحية النشر قبل أي إرسال |
| 2 | **محرك التوجيه** | مسارات (Routes) تربط مصادر/فلاتر/تصنيفات بوجهة، مع قالب خاص بالمسار (O02) وسياسة مراجعة وسياسة طول |
| 3 | **منع الحلقات (O05)** | رسم فعّال للمسارات + فحص دورات **ذري** داخل معاملة التفعيل بقفل استشاري، مع حماية وقت التشغيل |
| 4 | **التنسيق والتقسيم** | تحويل النتيجة إلى منشور HTML آمن، حجب فئات التواصل نهائياً، وخطة أجزاء ≤ 4096 محرفاً بعد تحليل الكيانات |
| 5 | **الطابور والأخطاء** | تسليم منطقي واحد لكل (هوية، وجهة) (D05)، استحواذ ذري لكل جزء، تصنيف أخطاء صريح، احترام `retry_after`، وحالة «مجهولة» لا تُعاد تلقائياً (O04) |

**ما لا تدخله المرحلة:** تعديل/حذف الرسائل (Q5 المؤجَّل)، الوسائط والمنشورات المصوّرة، النشر عبر حساب مستخدم
(MTProto)، التحليلات المتقدمة، الحذف التلقائي للمنشور عند تعذر الأصل.

---

## 2) حصر الموجود والفجوات

**يُعاد استخدامه كما هو (بلا ازدواج معماري):**

| المكوّن القائم | الاستخدام في المرحلة III |
|---|---|
| `sessionCipher.ts` (AES‑256‑GCM + keyring + تدوير مفاتيح) | تشفير رموز بوتات النشر بمغلّف جديد `purpose='bot-token'` |
| `withTransaction` / `query` + نمط القيود المركّبة `(id, user_id)` | ملكية صفوف الوجهات والمسارات والتسليمات |
| `templateRenderer.ts` + `templateResolver.ts` | مصدر نص المنشور وأولوية القالب (يُضاف مستوى `route` الموجود عقده أصلاً) |
| `contactDetector.maskContact` + `resultsService.maskContactSpans` | فرض الحجب في النص المُرسل |
| `rateLimit`, `recordAudit`, `asyncHandler`, `parseBody` | واجهات الإدارة والتدقيق |
| نمط عامل الخلفية في `ingestService.startBackgroundTasks` | عامل النشر (interval + leases) |
| `notification_outbox` (email) + `user_settings.notifications` | تنبيهات فشل النشر |
| `message_identity` + `message_content` + `message_matches` | مصدر الحقيقة لما يُنشر وعمر المحتوى |

**الفجوات (كلها جديدة في المرحلة III):** لا وجود لجدول بوتات أو وجهات أو مسارات أو تسليمات أو محاولات أو دلائل،
ولا لعامل نشر، ولا لعميل Bot API، ولا لسياسة حجب/تنسيق/تقسيم على مستوى الإرسال.

---

## 3) تدفق البيانات

```
[المرحلة الثانية — قائم]
  تيليجرام ──MTProto──▶ الالتقاط ─▶ الفلترة ─▶ الاستخراج ─▶ التصنيف ─▶ اختيار القالب
                                                              │
                                            message_identity(state=processed)
                                                              │
[المرحلة الثالثة — جديد]                                      ▼
                          ┌───────────────────────────────────────────────┐
                          │ (A) محرك التوجيه  routingService.route()      │
                          │  مسارات مؤهلة ⇒ وجهات متمايزة                  │
                          │  قالب: مسار ← مصدر ← فلتر ← تصنيف ← افتراضي    │
                          │  قرار المراجعة: مطلوب؟ (D01)                   │
                          └───────────────┬───────────────────────────────┘
                                          │  (معاملة واحدة: تسليم + خطة أجزاء + حالة)
                                          ▼
                    deliveries (unique: identity × destination)
                    delivery_parts (نص مُنسَّق محجوب + فهرس + hash)
                                          │
             ┌────────────────────────────┴───────────────────────────┐
             │ review_required = true                                 │ false
             ▼                                                        ▼
   awaiting_review ──(موافقة API، مثبتة على plan_version)──▶     queued
                                                                     │
                          ┌──────────────────────────────────────────┘
                          ▼
            (B) عامل النشر dispatcherWorker (كل 2–5 ثوانٍ)
                 lease: select … for update skip locked
                 تحقق صلاحية البوت/الوجهة (كاش 5 دقائق + إعادة عند 403)
                 استحواذ ذري على الجزء + تسجيل بدء المحاولة (commit قبل HTTP)
                          │
                          ▼
                   Telegram Bot API (HTTPS، مهلة 10 ثوانٍ)
        ┌───────────────┬───────────────┬──────────────────┬───────────────┐
        ▼               ▼               ▼                  ▼               ▼
   200 OK         400/403 نهائي     429 مؤقت         5xx/شبكة        مهلة/سقوط بعد البدء
   part=sent      part=failed      إعادة بجدولة      إعادة بحد         part=uncertain
   message_id     delivery=failed  حسب retry_after  محاولات            delivery=uncertain
        │                                              │                     │
        └────────────── أجزاء تالية / إغلاق التسليم ────┘              (O04) تحقق بشري
                                                                        بدليل مدقَّق
```

**نقاط التزامن الحسّاسة:** لا يوجد أي «إرسال ثم حفظ» — بل حفظ المحاولة قبل الطلب، وحفظ النتيجة بعده،
ولا معاملة ذرية مشتركة مع تيليجرام، ولا ادعاء «مرة واحدة بالضبط» (نص المرجع صريح في ذلك).

---

## 4) المكوّنات الجديدة (وحدات مستقلة داخل خدمة API)

| الوحدة | المسؤولية | ملاحظات التصميم |
|---|---|---|
| `publishing/botRepository.ts` | CRUD لبيانات البوت المشفّرة | لا يفكّ الرمز إلا عند الإرسال |
| `publishing/botApiClient.ts` | عميل Bot API (`getMe`, `getChat`, `getChatMember`, `sendMessage`, `editMessageText`, اختياري `deleteMessage`) | `fetch` + مهلة + تصنيف أخطاء + لا تسجيل للـURL (يحتوي الرمز) |
| `publishing/destinationService.ts` | إضافة وجهة، تحقق الصلاحيات، إيقاف/استئناف/حذف، اختبار إرسال | تحقق مستقل عن حق المستخدم في القناة |
| `publishing/routingService.ts` | تقييم المسارات، إنشاء التسليمات، اختيار القالب (O02)، قرار المراجعة | نقي الحساب + كتابة ذرية |
| `publishing/loopGuard.ts` | بناء حواف الرسم وفحص الدورات ذرياً (O05) | قفل استشاري + رسالة رفض غير كاشفة |
| `publishing/publisher.ts` | بناء المنشور: تنسيق + حجب + تقسيم | دوال نقية قابلة للاختبار بلا شبكة |
| `publishing/deliveryRepository.ts` | التسليمات والأجزاء والمحاولات والدلائل + الاستحواذ بـ`SKIP LOCKED` | كل استعلام مقيّد بالمالك |
| `publishing/dispatcherWorker.ts` | حلقة الإرسال، المهلات، الإيقاف/الاستئناف، مقاييس | عامل واحد داخل العملية، آمن مع تعدد النسخ |
| `publishing/publishRoutes.ts` | واجهات الوجهات والمسارات والتسليمات والمراجعة | تدقيق لكل إجراء كتابي |

---

## 5) مخطط قاعدة البيانات

### 5.1 الترحيل `0014_publishing_destinations.sql`

> الكود أدناه **مخطط توضيحي** (pseudo-SQL): يوضح الأعمدة والقيود والدلالات، لا صياغته النهائية الحرفية.
> الأعمدة `created_at/updated_at` مختصرة عن عمودين كاملين بنفس نمط الترحيلات القائمة.

```sql
create type destination_status as enum ('pending','active','paused','revoked','error','deleted');
create type bot_status as enum ('unverified','active','invalid','disabled');
create type chat_kind as enum ('channel','supergroup','group');

-- 1) بوت النشر: بوت واحد فعّال لكل مستخدم (القرار Q9)، والرمز مشفّر دائماً.
create table publish_bots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  label text not null,
  bot_telegram_id bigint,                -- من getMe بعد التحقق
  username text,                          -- @name كما يعيده getMe
  token_ciphertext bytea not null,        -- مغلّف AES-256-GCM (AAD: bot id + version)
  token_key_version integer not null,
  token_fingerprint text not null,        -- sha-256 للرمز (لكشف تغيير الرمز بلا كشفه)
  status bot_status not null default 'unverified',
  verified_at timestamptz,
  last_error_code text,
  created_at/updated_at timestamptz not null default now(),
  unique (user_id, bot_telegram_id),
  unique (id, user_id),
  constraint publish_bots_label_length check (char_length(label) between 1 and 60)
);
create unique index publish_bots_one_active_per_user on publish_bots (user_id)
  where status in ('active','unverified');

-- 2) الوجهة: قناة/مجموعة يعرفها البوت. الهوية الفنية = chat_id الرقمي الثابت.
create table destinations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  bot_id uuid not null,
  chat_id bigint not null,                -- -100… للقنوات
  chat_kind chat_kind not null,
  title text not null,
  username text,
  permissions jsonb not null default '{}'::jsonb,   -- لقطة can_post_messages / can_edit_messages
  status destination_status not null default 'pending',
  verified_at timestamptz,
  last_error_code text,
  created_at/updated_at,
  constraint destinations_owner_fkey foreign key (bot_id, user_id)
    references publish_bots (id, user_id) on delete cascade,
  unique (user_id, chat_id),              -- قناة واحدة كوجهة واحدة لكل مستخدم
  unique (id, user_id)
);

-- 3) المسار: (مصادر/فلاتر/تصنيفات) ← وجهة، مع قالب وسياسات.
create type publish_mode as enum ('auto','review');        -- §10.4 + D01
create type length_policy as enum ('split','reject');      -- D10 (القرار Q5)

create table routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  destination_id uuid not null,
  name text not null,
  template_id uuid,                        -- قالب المسار (أعلى أولوية O02)
  publish_mode publish_mode not null default 'auto',
  length_policy length_policy not null default 'split',
  max_parts smallint not null default 10,
  enabled boolean not null default true,
  created_at/updated_at,
  constraint routes_owner_fkey foreign key (destination_id, user_id)
    references destinations (id, user_id) on delete cascade,
  constraint routes_template_fkey foreign key (template_id, user_id)
    references templates (id, user_id) on delete set null (template_id),
  unique (user_id, name)
);

-- 4) شروط المسار: مراجع صريحة (مصدر / فلتر / تصنيف) — «أيٌّ منها» يفعّل المسار.
create type route_scope_kind as enum ('source','filter','classification');
create table route_scopes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  route_id uuid not null,
  kind route_scope_kind not null,
  source_id uuid,
  rule_set_id uuid,
  constraint route_scopes_route_fkey foreign key (route_id, user_id)
    references routes (id, user_id) on delete cascade,
  constraint route_scopes_source_fkey foreign key (source_id, user_id)
    references telegram_sources (id, user_id) on delete cascade,
  constraint route_scopes_rule_fkey foreign key (rule_set_id, user_id)
    references rule_sets (id, user_id) on delete cascade,
  constraint route_scopes_shape check (
    (kind = 'source' and source_id is not null and rule_set_id is null) or
    (kind <> 'source' and source_id is null and rule_set_id is not null)
  ),
  unique (route_id, kind, source_id, rule_set_id)
);

-- 5) رسم التوجيه الفعّال (حواف O05): تُحدَّث في معاملة التفعيل نفسها.
create table routing_edges (
  user_id uuid not null references users (id) on delete cascade,
  from_chat_id bigint not null,     -- قناة/مجموعة يُقرأ منها (مصدر)
  to_chat_id bigint not null,       -- قناة/مجموعة يُنشر فيها (وجهة)
  route_id uuid not null references routes (id) on delete cascade,
  source_id uuid not null,
  destination_id uuid not null,
  primary key (from_chat_id, to_chat_id, route_id)
);
create index routing_edges_to_idx on routing_edges (to_chat_id);
```

**الملاحظة الجوهرية على O05:** الحواف مبنية على **معرّف القناة الفني** (`chat_id`) لا على أسماء،
فالفحص يعمل عبر المستخدمين دون كشف إعدادات أي مستخدم آخر — يُستخدم داخلياً فقط ولا يظهر في أي استجابة.

### 5.2 الترحيل `0015_publishing_deliveries.sql`

```sql
create type delivery_status as enum (
  'awaiting_review','queued','sending','published','partial','failed','uncertain','blocked','cancelled');
create type part_status as enum ('pending','sending','sent','failed','uncertain','skipped');
create type review_decision as enum ('not_required','pending','approved','rejected');
create type attempt_outcome as enum ('ok','retryable','permanent','uncertain');

-- 1) التسليم المنطقي: واحد فقط لكل (هوية، وجهة) — D05.
create table deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  identity_id uuid not null references message_identity (id) on delete cascade,
  destination_id uuid not null,
  route_id uuid,
  template_id uuid,
  plan_version integer not null default 1,   -- تُثبَّت الموافقة على هذا الرقم
  review review_decision not null default 'not_required',
  approved_by uuid references users (id) on delete set null,
  approved_at timestamptz,
  approved_version integer,
  rejected_reason text,
  status delivery_status not null,
  chunk_count smallint not null default 0,
  chars_total integer not null default 0,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  masking_version integer not null default 1,
  formatting_version integer not null default 1,
  last_error_code text,
  published_at timestamptz,
  created_at/updated_at,
  constraint deliveries_owner_dest_fkey foreign key (destination_id, user_id)
    references destinations (id, user_id) on delete cascade,
  constraint deliveries_identity_fkey foreign key (identity_id)
    references message_identity (id) on delete cascade,
  unique (identity_id, destination_id)        -- ⚑ منع النشر المزدوج مهما تعددت الفلاتر
);
create index deliveries_queue_idx on deliveries (status, next_attempt_at)
  where status in ('queued','sending');

-- 2) الأجزاء: نص منشور جاهز، مرتبط بعمر المحتوى (D09/O06).
create table delivery_parts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references deliveries (id) on delete cascade,
  part_index smallint not null,
  text text not null,
  text_hash text not null,           -- sha-256 لكشف أي تغيير غير مقصود
  char_count integer not null,
  status part_status not null default 'pending',
  telegram_message_id bigint,
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error_code text,
  lease_owner text,
  lease_expires_at timestamptz,
  unique (delivery_id, part_index)   -- ⚑ يمنع إرسال الجزء نفسه مرتين
);

-- 3) المحاولات: بلا نص وبلا رموز.
create table delivery_attempts (
  id bigserial primary key,
  delivery_id uuid not null references deliveries (id) on delete cascade,
  part_id uuid references delivery_parts (id) on delete cascade,
  attempt_no smallint not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome attempt_outcome,
  http_status integer,
  telegram_error_code integer,
  error_code text,
  error_detail text,          -- وصف مختصر منقّح، بلا أسرار ولا محتوى
  retry_after_seconds integer,
  duration_ms integer,
  unique (delivery_id, part_id, attempt_no)
);

-- 4) دليل التحقق من الحالة المجهولة (O04): من تحقق، وماذا قرر، ومتى.
create table delivery_evidence (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references deliveries (id) on delete cascade,
  part_id uuid references delivery_parts (id) on delete cascade,
  verifier_user_id uuid references users (id) on delete set null,
  method text not null,              -- 'message_id' | 'manual_check' | 'edit_probe'
  decision text not null,            -- 'published' | 'not_published'
  telegram_message_id bigint,
  note text,                         -- نص حر قصير بلا محتوى رسالة (≤200)
  decided_at timestamptz not null default now()
);

-- 5) حالة النشر على الهوية (مشتقّة ومخزَّنة للعرض السريع، §17 يفصل المعالجة عن النشر).
alter table message_identity
  add column publish_state text not null default 'not_routed',
  add column published_count integer not null default 0;

-- 6) إعدادات النشر للمستخدم (مستقلة عن احتفاظ المحتوى — D09).
alter table user_settings
  add column delivery_retention_days integer not null default 90,
  add constraint user_settings_delivery_retention_range
    check (delivery_retention_days between 1 and 3650);
```

### 5.3 قواعد الحذف والاحتفاظ

| الكائن | عند حذف الوجهة | عند حذف البوت | عند انتهاء احتفاظ المحتوى (48h) | احتفاظ مستقل |
|---|---|---|---|---|
| `routes` / `route_scopes` | حذف متسلسل | حذف متسلسل (عبر الوجهات) | — | — |
| `deliveries` | حذف متسلسل (سجل تاريخي يضيع مع الوجهة ⇒ القرار Q15) | حذف متسلسل | يبقى بلا نص | 90 يوماً (Q13) |
| `delivery_parts.text` | حذف متسلسل | حذف متسلسل | **يُمسح النص**، ويصبح الجزء غير المرسل `blocked/content_expired` | — |
| `delivery_attempts` / `delivery_evidence` | حذف متسلسل | حذف متسلسل | يبقى (بلا محتوى) | 90 يوماً |
| `message_identity` | لا يُمسّ | لا يُمسّ | يبقى (بصمة + حالة) | 30 يوماً كما هو |

**قاعدة صارمة:** لا يُرسل أي جزء بعد انقضاء عمر المحتوى؛ يُغلق العمل ويُسجَّل السبب `content_expired`
ولا يُعاد إحياء النص من أي مصدر (D09/O06).

---

## 6) آلات الحالة

**البوت:** `unverified → active → (invalid | disabled) `، والتحقق يعني `getMe` ناجح.

**الوجهة:** `pending → active → (paused | revoked | error) → deleted`
- `active` تتطلب `getChat` + `getChatMember` يُثبت أن البوت **مشرف** مع `can_post_messages`.
- `revoked` عند 403 من تيليجرام (طُرد البوت أو سُحبت الصلاحية) — تُوقف كل مساراتها وتُنبّه المستخدم.
- `paused` بإرادة المستخدم فقط (لا يمسح سجلاً).

**التسليم:** `awaiting_review → queued → sending → (published | partial | failed | uncertain | blocked)`
- `partial`: بعض الأجزاء نجحت وبعضها فشل نهائياً (يُعرض بوضوح، ولا يُعاد إرسال الناجح أبداً).
- `blocked`: سبب مانع بلا إرسال (انتهاء المحتوى، وجهة موقوفة، دورة مكتشفة، نص متجاوز بسياسة `reject`).
- `uncertain`: مهلة/سقوط بعد بدء الطلب — **لا إعادة تلقائية** (O04).
- إعادة الفتح (`queued`) مسموحة فقط من `failed` لأجزاء لم تنجح، أو من `uncertain` بعد دليل «لم يُنشر».

**الجزء:** `pending → sending → (sent | failed | uncertain)`، و`sent` نهائي لا يُعاد.

---

## 7) محرك التوجيه

### 7.1 دلالة المسار
- المسار ينطبق إذا تحقّق **أي** من شروطه: مصدر مطابق، أو فلتر من الفلاتر المطابقة، أو تصنيف يساوي التصنيف الفعّال
  (اليدوي يغلب — O02). مسار بلا شروط لا ينطبق أبداً (لا «تمرير الكل» بالخطأ — نفس فلسفة الفلترة).
- عدة مسارات قد تنطبق، لكن **الوجهة هي وحدة التنفيذ**: تُجمَّع كل المسارات المؤهلة لكل وجهة أولاً،
  ثم يُنشأ **تسليم واحد** لكل وجهة (D05) — فلا مهمتان ولا منشوران بسبب تعدد الفلاتر.

### 7.2 القرار لكل وجهة
| القرار | القاعدة |
|---|---|
| القالب | مسار (أعلى أولوية بين المسارات المؤهلة) ← مصدر ← فلتر ← تصنيف ← افتراضي (O02) |
| المراجعة | إن طلب **أي** مسار مؤهل لهذه الوجهة المراجعة ⇒ الوجهة كلها تنتظر (نص المرجع صريح) |
| المراجعة الإلزامية الإضافية | تُقترح عند `review_state=needs_review` (تصنيف غامض/استخراج غامض) — **قرار Q4** |
| سياسة الطول | من المسار (`split` أو `reject`) — قرار Q5 |
| الأولوية عند التزاحم | لا تزاحم: المسار لا «يفوز» على آخر داخل الوجهة؛ أثره يقتصر على القالب والمراجعة والطول |

### 7.3 الذرّية
إنشاء التسليم + خطة الأجزاء + تحديث `message_identity.publish_state` في **معاملة واحدة**،
مع `on conflict (identity_id, destination_id) do nothing` كخط دفاع أخير ضد أي سباق (تحديث إعادة المعالجة، عاملان، إلخ).

---

## 8) منع الحلقات (O05) — الفحص الذري

### 8.1 ما هي الحلقة في هذا النظام؟
نشرُ منشور في قناة **يُقرأ منها** كمصدر (للمستخدم نفسه أو لمستخدم آخر) ثم يُوجَّه مرة أخرى إلى وجهة،
فيعود إلى القناة الأولى (مباشرة، أو عبر سلسلة وجهات/مستخدمين).

### 8.2 آلية الفحص
1. عند أي تفعيل/تعديل مؤثر (إضافة وجهة، تفعيل مسار، إضافة مصدر لمسار، تعديل `chat_id`):
   داخل المعاملة نفسها:
   ```
   select pg_advisory_xact_lock(hashtext('routing-graph-v1'));   -- قفل عام قصير
   -- إعادة بناء حواف هذا المستخدم فقط (upsert/delete) في routing_edges
   -- فحص دورة بـWITH RECURSIVE على الرسم الفعّال (كل المستخدمين، معرّفات تقنية فقط)
   -- إن وُجدت دورة تشمل الوجهة/المصدر المتأثر ⇒ rollback + خطأ واحد محايد
   ```
2. **الرفض محايد:** `routing_cycle_detected` برسالة عامة («سيُنشئ هذا الربط حلقة نشر») بلا اسم مستخدم آخر
   ولا اسم مصدره — التزاماً بـ«لا تفاصيل لمسار الغير عند الرفض».
3. **قيد إضافي عند تعذّر الفحص الآمن لقناة مشتركة:** يُمنع الجمع بين كون القناة وجهةً للأنا ومصدراً لنا
   في نفس المسار (دورة مباشرة) حتى لو تعذّر التحقق من جهة أخرى.
4. **حماية وقت التشغيل (دفاع في العمق):** الالتقاط يتجاهل الرسائل الصادرة من بوت النشر نفسه
   (`sender_id = bot_telegram_id`) — تُحتسب في عدّاد تشخيصي ولا تدخل المعالجة، لأنها بالتأكيد منشوراتنا.
5. **نطاق الضمان:** حلقات داخل النظام فقط. أي دورة تحدث عبر بوت/نظام خارج لا يمكن ضمانها — تُوثّق كحدّ.

### 8.3 تعارض التزامن
فحصان متزامنان من مستخدمين مختلفين لا يمكن أن يمرّا كلاهما إلى حالة دورية، لأن كتلة
`advisory lock + بناء الحواف + الفحص + الالتزام` ذرّية. والقفل عام لكنه قصير (كتابة عشرات الصفوف) ويُؤخذ فقط
عند تغييرات التوجيه النادرة، لا في مسار الرسائل الساخن.

---

## 9) محرك النشر: التنسيق والحجب والتقسيم

### 9.1 التنسيق (§10.5)
- `parse_mode = HTML` (أبسط تأميناً من MarkdownV2: لا حاجة لهروب 18 محرفاً، تكفي `& < >`).
- بنية المنشور: عنوان اختياري (اسم التصنيف/قالب) + فاصل + سطور «**التسمية:** القيمة» + فاصل + وسيلة التواصل المحجوبة.
- **حدود تُفرَض بالحساب بعد تحليل الكيانات** (`entities`) لا بعدد المحارف الخام — المرجع يشترط ذلك.
- لا معاينة روابط تلقائية (`link_preview_options.is_disabled = true`) لمنع لصق روابط خارجية غير مقصودة من النص.

### 9.2 الحجب (O03) — «الحجب النهائي قبل الإرسال»
خطوتان مستقلّتان:
1. **بالبناء:** القالب لا يُغذّى إلا `value_masked` (قائم من المرحلة الثانية).
2. **بفحص أمان نهائي** على النص الجاهز: يُعاد تشغيل `detectContacts` عليه، وأي قيمة تواصل غير محجوبة
   تُستبدل بصيغتها المحجوبة، ويُسجَّل `masking_rewrite_count` في المحاولة (تشخيص لا محتوى).
   أي فشل في هذه الخطوة ⇒ `blocked/masking_failed` بدل إرسال محتوى غير محجوب (رفض آمن).

### 9.3 التقسيم (Chunking)
**الخوارزمية (حتمية):**
1. حساب الطول **بعد** الترميز والتحويل لـHTML، والميزانية لكل جزء 4096، مع هامش اسم الجزء إن فُعّل.
2. نقاط القطع بترتيب الأولوية: فقرة (`\n\n`) ← سطر (`\n`) ← جملة (`.`، `!`، `?`، `؟`) ← فاصلة/مسافة ← قطع اضطراري.
3. **لا قطع داخل:** كيان HTML (`&amp;`)، وسم، محرف Unicode مركّب (surrogate pair)، أو قيمة تواصل محجوبة (تبقى ذرّية).
4. لا يُنشأ جزء فارغ، ولا يُعاد أي جزء (فهرس فريد)، والحد الأقصى `max_parts` من المسار (افتراضي 10).
5. تجاوز الحد أو تعذّر القطع النظيف ⇒ حسب سياسة المسار: `reject` (فشل صريح بسبب `too_long`) أو `split` حتى السقف.
6. **لا اقتطاع صامت أبداً** (قرار سابق من المرحلة الثانية، مستمر هنا).
7. اسم الجزء `(1/3)` اختياري — قرار Q6.

### 9.4 لماذا «خطة أجزاء» مخزَّنة لا نشر مباشر؟
لأن التسليم قد يتوقف بين جزء وآخر (خطأ/انتهاء محتوى/تعديل خطة)، ولأن المراجعة تُثبَّت على `plan_version`،
ولأن منع التكرار يحتاج هوية ثابتة لكل جزء قبل الإرسال. الخطة تُخزَّن بنصوصها في `delivery_parts`
وتُمسح نصوصها مع انتهاء احتفاظ المحتوى.

---

## 10) الإرسال والتحقق

### 10.1 قبل كل إرسال
| فحص | مصدره | عند الفشل |
|---|---|---|
| البوت فعّال ورمزه صالح | `publish_bots.status='active'` | `blocked/bot_invalid` |
| الوجهة فعّالة | `destinations.status='active'` | `blocked/destination_inactive` |
| الصلاحية قائمة | `getChatMember` (كاش 5 دقائق، وإجبار عند 403) | `revoked` + تنبيه |
| النص غير منتهي | `message_content.retention_expires_at` | `blocked/content_expired` |
| المراجعة مكتملة ومثبتة | `approved_version = plan_version` | `awaiting_review` |

### 10.2 الاستحواذ الذري
```sql
-- اختيار دفعة قابلة للعمل
select id from deliveries
 where status = 'queued' and (next_attempt_at is null or next_attempt_at <= now())
   and (lease_expires_at is null or lease_expires_at < now())
 order by next_attempt_at nulls first, created_at
 limit $batch
 for update skip locked;
```
ثم: `update … set status='sending', lease_owner=$w, lease_expires_at=now()+interval '60 seconds'`
و**commit**، ثم إدراج صف محاولة `started` وcommit، ثم استدعاء HTTPS بمهلة 10 ثوانٍ، ثم حفظ النتيجة.

### 10.3 تصنيف الأخطاء (سياسة معلنة)
| الحالة | التصنيف | الإجراء |
|---|---|---|
| `200 OK` | نجاح | حفظ `message_id`، الجزء `sent`، الانتقال للجزء التالي |
| `429` + `retry_after` | مؤقت مفروض | `next_attempt_at = now() + retry_after`، الجزء يعود `pending`، لا استهلاك لمحاولة فاشلة |
| `5xx` / فشل شبكة قبل الاستجابة | مؤقت | إعادة بجدولة أسّية بحد أقصى (Q12) |
| `400` (نص/تنسيق/`chat not found`) | نهائي | جزء `failed` + رمز سبب معروض للمستخدم |
| `403` (طرد/سحب صلاحية) | نهائي | وجهة `revoked`، إيقاف مساراتها، تنبيه |
| مهلة/سقوط **بعد** بدء الطلب | **مجهول** | `uncertain` + لا إعادة تلقائية (O04) |
| رفض بسبب الطول (استجابة 400 نصية) | نهائي | إعادة تقييم سياسة الطول: `reject` أو تقسيم أدق |

**حدود تيليجرام المعلنة (مرجع رسمي):** ≤ 1 رسالة/ثانية في المحادثة، ≤ 20 رسالة/دقيقة للمجموعة،
~30 رسالة/ثانية إجمالاً للبوت، والنص ≤ 4096 محرفاً بعد تحليل الكيانات (والتعليق ≤ 1024).
تُترجم إلى: طابور بفاصل أدنى لكل وجهة (1.2 ثانية)، وسقف عام للبوت (30/ثانية)، واحترام `retry_after` حرفياً.

### 10.4 الحالة المجهولة (O04) والإعادة اليدوية
- `uncertain` لا تُعاد تلقائياً ولا بمجرد ضغط زر: تحتاج **دليلاً**:
  1. **دليل معرّف:** المستخدم (أو مشرف قناة موثّق) يُدخل `message_id` المرئي في القناة ⇒ يصبح الجزء `sent`.
  2. **دليل يدوي:** «تحققتُ أنه لم يُنشر» ⇒ يُسمح بإعادة الجزء نفسه (مرة واحدة لكل دليل، بقيود المحتوى والصلاحية).
  3. **فحص آمن اختياري (Q11):** `editMessageText` بنفس النص: نجاحه ⇒ المنشور موجود (يُربط)، وفشله بـ`message to edit not found` ⇒ غير موجود.
     لا يُستخدم إلا بإجراء صريح من المستخدم، لأن الإرسال عبر أي مسار آخر قد يكرر المنشور.
- **لا إعادة أبداً** لجزء `sent` أو تسليم `published` (نص المرجع صريح).
- كل قرار يُسجَّل في `delivery_evidence` مع هوية المتحقق ووقته وطريقته.

### 10.5 المراجعة البشرية (D01)
- عند `publish_mode='review'` (أو مراجعة إلزامية بحسب Q4): التسليم `awaiting_review` **قبل** أي إرسال.
- الموافقة تُثبَّت على `approved_version = plan_version`؛ أي تغيير في الخطة (قالب/تعديل نتيجة/إعادة تقسيم)
  يرفع `plan_version` ويُبطل الموافقة تلقائياً ويعيد التسليم للمراجعة.
- الرفض يسجّل السبب ويُغلق التسليم (`cancelled`) بلا إرسال، ويبقى السجل للتدقيق.
- **انتهاء المحتوى أثناء الانتظار** ⇒ `blocked/content_expired` ولا نشر (O06).

---

## 11) الطابور والعامل

| البند | القرار المقترح |
|---|---|
| الشكل | جدول `deliveries` هو الطابور نفسه (بلا بنية موازية)، والأجزاء `delivery_parts` |
| العامل | عامل داخل خدمة API (مثل الالتقاط)، interval 2–5 ثوانٍ + تشغيل عند البدء |
| التزامن | حتى 3 إرسالات متزامنة لكل عملية، وطلبات متسلسلة لكل وجهة (فاصل 1.2 ثانية) |
| الاستحواذ | `FOR UPDATE SKIP LOCKED` + `lease_expires_at` ⇒ آمن مع تعدد النسخ أو إعادة التشغيل |
| الاستعادة بعد الانهيار | lease منتهية ⇒ يُعاد الجزء **فقط** إذا كان `pending`؛ إن كان `sending` ⇒ يصبح `uncertain` (لأن الطلب قد يكون وصل) |
| الإيقاف | مفتاح `TG_PUBLISHING_ENABLED`، وإيقاف لكل وجهة/مسار، ومفتاح إيقاف طارئ عام |
| المهلات | مهلة HTTP 10 ثوانٍ، مهلة دورة العامل 30 ثانية، بلا حلقات طويلة حاجزة |

---

## 12) الأمان والعزل

1. **رمز البوت:** مشفّر بمغلّف `AES‑256‑GCM` مع AAD يحمل `bot id + key version`، ومفتاح مستقل
   `TG_BOT_ENC_KEY` (+ `_PREVIOUS` للتدوير) لئلا يختلط بجلسات MTProto (قرار Q1). يُفكّ في الذاكرة لحظة الإرسال فقط.
2. **لا رمز في السجلات:** عميل Bot API **لا يسجّل** الرابط (يحتوي الرمز في المسار)؛ يُسجَّل اسم العملية والمعرّفات فقط،
   والأخطاء تُنقَّح قبل التخزين (`error_detail` ≤ 200 محرف، بلا رمز ولا محتوى).
3. **العزل:** كل جدول جديد يحمل `user_id` مع مفاتيح مركّبة `(id, user_id)`، وكل استعلام مقيّد بالمالك.
   لوحة المدير ترى أعداداً وأخطاء واتصالات فقط — **لا محتوى** ولا رموز (D07).
4. **التدقيق:** كل إجراء كتابي (`destination.added/verified/paused`, `route.activated/deactivated`,
   `delivery.approved/rejected/resubmitted`, `delivery.evidence_recorded`) يُسجَّل في `audit_events` بلا محتوى.
5. **الحجب:** مزدوج (بناء + فحص نهائي) برفض آمن عند أي شك.
6. **حدود المعدل:** واجهات الإضافة/التحقق/الموافقة محمية بـ`rateLimit`، وإعادة التحقق قابلة للتخزين المؤقت لكن
   لا تُتجاوز عند 403.

---

## 13) الواجهات (API + UI)

**API (تحت `/api/v1/telegram`، كلها مقيّدة بالمالك):**

| المسار | الغرض |
|---|---|
| `GET/POST /publish/bot` | حالة بوت النشر وربطه (الرمز يُدخل مرة واحدة ولا يُعاد أبداً) |
| `POST /publish/bot/verify` | `getMe` + تسجيل الهوية والحالة |
| `GET/POST /destinations` | القائمة والإضافة (بـ`@username` أو `chat_id`) |
| `POST /destinations/:id/verify` | `getChat` + `getChatMember` وتحديث الصلاحيات |
| `PATCH /destinations/:id` | إيقاف/استئناف/تغيير الاسم الظاهر |
| `DELETE /destinations/:id` | حذف (سياسة Q15) |
| `GET/POST/PATCH/DELETE /routes` | إدارة المسارات وشروطها وقالبها وسياساتها |
| `POST /routes/:id/activate` · `POST /routes/:id/deactivate` | تفعيل ذري مع فحص الحلقات (O05) |
| `GET /deliveries?status=&destination=&review=` | سجل النشر وحالاته |
| `GET /deliveries/:id` | تفاصيل: الأجزاء، المحاولات، الدلائل، سبب الفشل |
| `POST /deliveries/:id/approve` · `/reject` | المراجعة البشرية (D01) |
| `POST /deliveries/:id/retry` | إعادة يدوية مؤمّنة (لأجزاء غير مؤكدة فقط) |
| `POST /deliveries/:id/evidence` | تسجيل دليل مجهول (O04) |
| `GET /publish/status` | صحة النشر: طابور، فشل، وجهات معطّلة، آخر أخطاء |

**الصفحات (Web):**
1. **قنوات النشر:** بوت + تحقق + إضافة وجهات بحالة صلاحية واضحة.
2. **المسارات:** إنشاء مسار (وجهة + فلاتر/مصادر/تصنيفات + قالب + مراجعة + سياسة طول)، وتفعيل يُظهر سبب الرفض إن وُجدت دورة.
3. **سجل النشر:** جدول تسليمات بحالة كل جزء، أزرار موافقة/رفض/إعادة/دليل، وعرض سبب الفشل بالعربية.
4. **المراجعة:** دمج قائمة المراجعة القائمة مع طلبات الموافقة على النشر (نفس تجربة المستخدم).
5. **حالة النشر:** بطاقات صحّة (طابور، معلّق بانتظار مراجعة، مجهول، فشل) — بلا محتوى.
6. **النتائج (توسيع):** عمود «النشر» لكل وجهة داخل صفحة تفاصيل الرسالة.

---

## 14) الاختبارات المقترحة (بلا شبكة حقيقية)

| المستوى | التغطية |
|---|---|
| وحدة — التقسيم | حدود 4096 بعد HTML، قطع على فقرة/سطر/جملة، عدم قطع كيان/وسم/محرف مركّب/قيمة محجوبة، سقف الأجزاء، سياسة `reject` |
| وحدة — التنسيق | هروب HTML، حذف الحقول الغائبة، تعطيل معاينة الروابط، طول بعد الترميز |
| وحدة — الحجب | إعادة الفحص النهائي تُبطل أي قيمة خامة، ورفض آمن عند التعذّر |
| وحدة — تصنيف الأخطاء | جدول الحالات (200/429/5xx/400/403/مهلة) → القرار الصحيح |
| وحدة — منع الحلقات | دورة مباشرة، غير مباشرة، عبر مستخدمين، وجهة مشتركة، تفعيلان متزامنان، ولا تسريب تفاصيل |
| تكامل — التوجيه | عدة فلاتر ⇒ تسليم واحد لكل وجهة (D05)، أولوية القالب، المراجعة تُلزم الوجهة كلها |
| تكامل — الإرسال | نجاح، 429 (احترام `retry_after`)، 403 (إيقاف الوجهة)، 400 نهائي، مهلة ⇒ `uncertain` بلا إعادة |
| تكامل — الاستحواذ | عاملان متزامنان لا يرسلان الجزء نفسه؛ إعادة تشغيل أثناء `sending` ⇒ `uncertain` |
| تكامل — الاحتفاظ | انتهاء المحتوى ⇒ `blocked/content_expired`، ومسح نصوص الأجزاء مع بقاء السجل |
| تكامل — العزل | مستخدم لا يرى وجهات/مسارات/تسليمات غيره (404)، ولا دليل على وجودها |
| أمان | لا رمز بوت في أي استجابة/سجل/تدقيق، `value_raw` غير قابل للتسرب |

**بيئة الاختبار:** عميل Bot API مزيّف (نفس نمط `FakeGateway` القائم) + PostgreSQL مدمج. لا اختبار حقيقي
بلا بوت ورمز حقيقيين، وأي اختبار حيّ يُعلَن حياً ولا يُخلط بالنتائج المحلية.

---

## 15) المخاطر وحدود الضمان

| الخطر | التخفيف |
|---|---|
| فقدان صلاحية البوت أثناء التشغيل | تحقق مسبق + كاش قصير + معالجة 403 بإيقاف الوجهة وتنبيه |
| تكرار منشور عند مهلة | `uncertain` بلا إعادة تلقائية + دليل مطلوب (O04) |
| حلقة عبر قناة مشتركة بين مستخدمين | فحص ذري على رسم فعّال بمعرّفات فنية + تجاهل منشورات بوتنا |
| ضغط تيليجرام (429) | فواصل لكل وجهة + سقف عام + احترام `retry_after` حرفياً |
| نصوص مقسّمة تُمسح قبل الإرسال | انتهاء المحتوى يغلق غير المرسل بسبب صريح (لا إحياء) |
| تسريب محتوى في السجلات | لا نص في `delivery_attempts`، تنقيح الأخطاء، ولا رمز في أي سجل |
| تضخم الجداول | فهارس على (status, next_attempt_at) و(identity) + تنظيف بالاحتفاظ |

**حدود معلنة:** لا ضمان لحلقات خارج النظام، ولا ضمان بحث عام في تاريخ الوجهة عبر Bot API،
ولا معالجة لتعديل/حذف الرسائل (Q5 مؤجَّل)، ولا نشر وسائط، ولا ادعاء «مرة واحدة بالضبط».

---

## 16) القرارات المطلوبة قبل الكود (Q1–Q15)

| # | القرار | التوصية |
|---|---|---|
| **Q1** | أين يُخزَّن رمز البوت؟ | جدول `publish_bots` بمغلّف AES‑256‑GCM ومفتاح مستقل `TG_BOT_ENC_KEY` (+ سابق للتدوير)، ولا يُعاد إظهاره أبداً |
| **Q2** | عميل Bot API | `fetch` مدمج بلا اعتماد جديد، مهلة 10s، عميل قابل للحقن للاختبار |
| **Q3** | دلالة شروط المسار | «أيٌّ من» (مصدر/فلتر/تصنيف) فقط في v1؛ شروط كلمات إضافية تُؤجَّل |
| **Q4** | هل تُلزم المراجعة عند غموض المعالجة؟ | نعم: `needs_review` ⇒ مراجعة نشر إلزامية، إضافةً إلى طلب المسار |
| **Q5** | سياسة الطول الافتراضية | `split` افتراضياً (كما طلبت) مع `reject` خياراً للمسار — **يلاحظ أنه يخالف افتراض D10 (رفض افتراضي)** فلزم اعتمادك |
| **Q6** | اسم الجزء `(1/3)` | مطفأ افتراضياً، خيار لكل مسار |
| **Q7** | صيغة التنسيق | HTML (`parse_mode=HTML`) + عنوان/فاصل/غامق، وتعطيل معاينة الروابط |
| **Q8** | إضافة وجهة | بـ`@username` أو `chat_id` رقمي فقط؛ لا «توجيه رسالة» كوسيلة ربط |
| **Q9** | عدد البوتات لكل مستخدم | بوت واحد فعّال (D08)، والجدول يسمح بالتوسعة لاحقاً بلا ترحيل مؤلم |
| **Q10** | نموذج العامل | داخل خدمة API مع leases، تزامن ≤3، بلا خدمة منفصلة الآن |
| **Q11** | فحص الحالة المجهولة | يدوي أساساً (دليل) + «فحص آمن» اختياري بـ`editMessageText` بنفس النص كإجراء صريح — **يحتاج موافقتك لأنه يلمس منشوراً قائماً** |
| **Q12** | أرقام إعادة المحاولة | 5 محاولات، أسّي 2/4/8/16/32s + jitter، احترام `retry_after`، مهلة عمر 6 ساعات ثم `failed` |
| **Q13** | احتفاظ سجلات النشر | 90 يوماً افتراضياً (قابل للتخصيص)، ونصوص الأجزاء 48 ساعة مع المحتوى |
| **Q14** | نطاق منع الحلقات | فحص ذري عالمي بمعرّفات فنية + رفض محايد + تجاهل منشورات بوتنا وقت الالتقاط |
| **Q15** | حذف الوجهة | «حذف» = `deleted` (تعطيل) مع إبقاء السجل؛ الحذف الفعلي فقط إن لم يكن لها تسليمات |

**أسئلة صغيرة (أُجيب عنها افتراضياً إن لم تعترض):**
- تنبيه فشل النشر: داخلي في اللوحة + بريد اختياري عبر `notification_outbox` القائم.
- إيقاف النشر كلياً: مفتاح بيئة `TG_PUBLISHING_ENABLED` + إيقاف لكل وجهة.
- تعديل/حذف الرسائل: يبقى مؤجَّلاً (Q5 من المرحلة الثانية) في هذه المرحلة.

---

## 17) خطة التنفيذ المقترحة بعد الاعتماد

| الدفعة | المحتوى | اختبارات الإغلاق |
|---|---|---|
| **7‑أ** | بوت + وجهات + تحقق الصلاحيات + واجهاتها | وحدة/تكامل مع عميل مزيّف: تحقق، 403، عزل |
| **7‑ب** | محرك التوجيه + المسارات + فحص الحلقات + إنشاء التسليمات | D05 (تسليم واحد)، دورات O05، أولوية O02 |
| **7‑ج** | التنسيق + الحجب + التقسيم + خطة الأجزاء | حدود 4096، عدم القطع الخاطئ، لا قيمة خامة |
| **7‑د** | العامل + الإرسال + الأخطاء + المراجعة + الدلائل + الصفحات | 429/403/400/مهلة، استحواذ متزامن، انتهاء محتوى، إعادة يدوية مؤمّنة |

> كل دفعة تُغلق باختباراتها ثم **تقرير مختصر وتوقف للمراجعة** — نفس منهج المرحلة الثانية.
