# قاعدة البيانات — المرحلة الأولى

المحرك: **PostgreSQL** (D12). الوصول عبر `pg` مع استعلامات SQL صريحة ومعاملات معلّمة (لا ORM).
الترحيلات في `apps/api/src/db/migrations` وتُطبَّق مرة واحدة عبر `npm run migrate`، مع تسجيل اسم الملف وبصمة SHA-256 في `schema_migrations`.

**سياسة الترحيل:** إلى الأمام فقط. تعديل ترحيل مُطبَّق يوقف المشغّل بخطأ بصمة؛ أي تغيير لاحق = ملف جديد `0004_...sql`.

## الجداول

### `users` — مالك المساحة
| العمود | النوع | ملاحظات |
|---|---|---|
| `id` | uuid | مفتاح أساسي `gen_random_uuid()` |
| `email`, `email_normalized` | text | العمود الثاني مولّد (`lower(btrim(email))`) |
| `display_name` | text | 2–120 حرفاً |
| `password_hash`, `password_algo` | text | scrypt مع ملح فريد؛ `scrypt-n32768-r8-p1` |
| `password_changed_at` | timestamptz | |
| `role` | enum `app_role` | `user` \| `admin` |
| `status` | enum `account_status` | `active` \| `suspended` \| `deleted` |
| `email_verified_at` | timestamptz | محجوز للتحقق من البريد (غير منفّذ) |
| `last_login_at`, `failed_login_count`, `locked_until` | | دعم القفل المؤقت |
| `created_at`, `updated_at`, `deleted_at` | | `updated_at` عبر مُشغّل |

**القيود:** صيغة البريد وطوله، طول الاسم، `(status='deleted') = (deleted_at is not null)`، فرادة `email_normalized` مقيّدة بـ `where status <> 'deleted'` (لا يمنع بقاء سجل الحساب المحذوف للتدقيق).
**الفهارس:** `users_email_normalized_active_key` (فريد جزئي)، `(role,status)`، `(created_at desc)`.

### `user_settings` — إعدادات شخصية
`user_id` (PK، FK → users، حذف متتالٍ)، `content_retention_hours` (افتراضي 48، بين 1 و2160)، `notifications jsonb`، `processing jsonb`، طوابع زمنية.
الحد الأعلى 2160 ساعة حاجز تشغيلي موثّق (D09/O06) وليس تغييراً للسياسة.

### `system_settings` — إعدادات عامة يديرها المدير
`key` (PK، صيغة `a.b.c`)، `value jsonb` (كائن)، `description`، `updated_by`، `updated_at`.
القيم المبدئية: `system.registration_enabled = {enabled:true}` و`system.default_content_retention_hours = {hours:48}`.

### `user_sessions` — جلسات الويب (منفصلة عن MTProto)
`token_hash` (SHA-256، فريد)، `csrf_hash`، `user_agent`، `ip inet`، `created_at`، `last_seen_at`، `expires_at` (خامل)، `absolute_expires_at` (مطلق)، `revoked_at`، `revoked_reason`.
**القيود:** `absolute_expires_at >= expires_at`، `expires_at > created_at`، سبب الإبطال إلزامي عند الإبطال.
**الفهارس:** جزئي `(user_id, expires_at desc) where revoked_at is null`، و`(expires_at)` للتنظيف.

### `password_reset_tokens`
`token_hash` فريد، `expires_at`، `used_at`، `invalidated_at`، `requested_ip`. لا يُخزَّن الرمز الخام.

### `notification_outbox`
صندوق إشعارات داخلي (بريد حالياً): `recipient`، `template`، `payload jsonb`، `status` (`pending/sent/failed/discarded`)، `attempts`، `last_error`.
**لا يحتوي رمز الاستعادة**؛ التسليم الفعلي يحتاج مزوّد بريد (بند معلّق).

### `audit_events` — تدقيق تشغيلي (D07)
`occurred_at`، `actor_user_id` (FK `set null`)، `actor_role`، `action` (`a.b.c`)، `target_type`، `target_id`، `outcome` (`success/failure/denied`)، `ip`، `user_agent`، `metadata jsonb`.
فهارس: `(occurred_at desc)`، `(actor_user_id, occurred_at desc)`، `(action, occurred_at desc)`، `(target_type, target_id)`.

### `login_attempts`
`email_normalized`، `ip`، `outcome` (`success/bad_credentials/unknown_user/locked/suspended`)، `created_at`، مع فهرسي بريد وIP للحد الزمني.

## العلاقات

```
users 1 ──< user_sessions            (on delete cascade)
users 1 ──< password_reset_tokens    (on delete cascade)
users 1 ──1 user_settings            (on delete cascade)
users 1 ──< notification_outbox      (on delete set null)
users 1 ──< audit_events             (on delete set null، حفاظاً على السجل)
users 1 ──< system_settings.updated_by (on delete set null)
```

## ما لم يُنشَأ في هذه المرحلة (بقصد)

`telegram_accounts`, `sources`, `source_activation_periods`, `update_checkpoints`, `filters`, `templates`, `destinations`, `routes`, `message_identity`, `message_views`, `content`, `deliveries`, `delivery_parts`, `attempts`, `disclosure_grants`, `outbox` التشغيلي للطوابير.
تُنشأ في مراحلها المعتمدة (انظر `docs/decisions-traceability.md`) لمنع جداول ناقصة بلا منطق يحمي قيودها.

## 0005 — جلسات الربط المؤقتة (الخطوة 2)

- `telegram_accounts.phone_hash`: بصمة `HMAC-SHA256` للرقم المطبَّع (بمفتاح مشتق من مفتاح تشفير الجلسات).
  لا يمكن استرجاع الرقم منها؛ تُستخدم لمنع ربط الرقم نفسه مرتين. فهرس فريد جزئي
  `(user_id, phone_hash) where phone_hash is not null and status <> 'revoked'`.
- `telegram_login_challenges`: محاولة ربط واحدة نشطة لكل حساب (فهرس فريد جزئي على `account_id where consumed_at is null`).
  الأعمدة: `stage` (`code`/`password`)، `ciphertext` (مغلّف AES-256-GCM يحتوي الرقم وphone_code_hash والجلسة المؤقتة)،
  `code_attempts`, `password_attempts`, `resend_count`, `last_sent_at`, `expires_at`, `consumed_at`.
  قيود: طول المغلّف الأدنى، نسخة مفتاح ≥ 1، عدّادات غير سالبة، و`expires_at > created_at`.
- حذف الحساب يحذف جلسته ومحاولاته (`on delete cascade`)، ولا تُخزَّن أي بيانات مصادقة نصية.

## 0006 — مصادر تيليجرام (الخطوة 3)

- `telegram_sources`:
  - `user_id` (مالك المصدر) و`account_id` (الحساب القارئ) — كلاهما `on delete cascade`.
  - `peer_type` (`channel`/`group`) و`peer_id` (`bigint`): الهوية الثابتة القادمة من تيليجرام.
  - `title`, `username`: بيانات عرض تُحدَّث عند التحقق فقط.
  - `status` (`active`/`paused`), `include_own_messages` (افتراضي `false`),
    `monitoring_started_at`, `last_verified_at`, `last_error_code`.
  - فهرس فريد `(user_id, peer_type, peer_id)` = مصدر واحد لكل هوية داخل المساحة (O01).
  - فهارس على `user_id` و`account_id`، ومُشغّل `set_updated_at`.
- `telegram_source_periods`: فترات التفعيل `(source_id, started_at, ended_at, reason)` مع فهرس فريد جزئي
  يضمن **فترة مفتوحة واحدة** لكل مصدر (نفس نمط `telegram_account_periods`).
- لا تُخزَّن أي رسائل أو وسائط أو محتوى مصادر في هذه المرحلة.

## 0007 — ضمان ملكية القارئ في قاعدة البيانات (تنفيذ قرار المراجعة)

- `telegram_accounts`: قيد فريد جديد `telegram_accounts_id_user_key (id, user_id)` ليكون هدفاً صالحاً للمفتاح المركّب.
- `telegram_sources`: المفتاح الأحادي `telegram_sources_account_id_fkey` **حُذف** واستُبدل بـ
  `telegram_sources_account_owner_fkey foreign key (account_id, user_id) references telegram_accounts (id, user_id)
  on delete cascade`.
  الأثر: لا يمكن لمصدر أن يشير إلى حساب يملكه مستخدم آخر، ولو كُتب الصف مباشرة خارج الخدمة (D02/O01).
  سلوك الحذف المتسلسل محفوظ كما هو (S9).
- الترحيل يبدأ بفحص: إن وُجد صف متقاطع الملكية يتوقف بخطأ واضح **دون** تعديل أي بيانات.
- تصحيح تعليق `telegram_source_periods`: الفترات تُحذف مع المصدر (cascade) وتبقى آثارها في `audit_events`.

## 0008 — محرّك الالتقاط وهوية الرسائل (الخطوة 4)

- `telegram_sources` (أعمدة جديدة): `last_message_at`, `ingested_count`, `duplicate_count`, `excluded_count`,
  `last_ingest_error_code` (يعبّر عن **آخر محاولة حفظ**: يُضبط عند الفشل ويُمحى عند أول نجاح لاحق) — مؤشرات صحة الالتقاط بدل جدول `update_checkpoints` (مؤجَّل بقرار معتمد).
  نقطة الاستئناف نفسها محفوظة داخل مغلّف الجلسة المشفّر (حالة تحديثات Telegram).
- `message_identity`: `user_id`, `source_id`, `account_id`, `peer_type`, `peer_id`, `telegram_message_id`,
  `first_seen_at`، مع:
  - `unique (user_id, source_id, telegram_message_id)` = منع التكرار (§9).
  - مفتاحان أجنبيان مركّبان يحملان الملكية: `(source_id, user_id) → telegram_sources(id, user_id)` و
    `(account_id, user_id) → telegram_accounts(id, user_id)`، وكلاهما `on delete cascade`.
  - فهارس: `(source_id, first_seen_at desc)`، `(user_id, first_seen_at desc)`، `(first_seen_at)` للتنظيف.
  - **لا أعمدة نص أو وسائط** — الهوية فقط (قرار معتمد).
- `telegram_sources_id_user_key` (فريد على `(id, user_id)`) ليكون هدفاً صالحاً للمفتاح المركّب.
- سياسة الاحتفاظ بالهويات مستقلة عن احتفاظ المحتوى (`TG_INGEST_IDENTITY_RETENTION_DAYS`، 30 يوماً افتراضياً).

## 0009 — إزالة أعمدة الفجوات غير المستخدمة

- `drop column gap_count`, `drop column last_gap_at` من `telegram_sources`.
- السبب: لا يوفّر `teleproto` إشارة موثّقة لفجوة تحديثات قابلة للاستهلاك، وتسجيل فجوة بلا إشارة = ادّعاء تغطية.
- الأثر على العقود: لا شيء (لا تُعرض هذه الحقول في أي استجابة).

## 0010 — إعدادات المعالجة: قواميس وفلاتر (الخطوة 5‑أ)

- أنواع جديدة: `dictionary_kind`, `rule_kind`, `rule_scope`, `rule_applies_to`, `condition_mode`, `term_match_mode`.
- `dictionaries` / `dictionary_terms`: قواميس لكل مستخدم (`unique (user_id, name)`، `unique (dictionary_id, term_normalized)`)،
  وكل مصطلح يُخزَّن مع `term_normalized` (نسخة المطابقة) و`match_mode` و`loose` (طي ة/ه اختياري للمصطلح).
- `rule_sets`: جدول موحّد للفلاتر والتصنيفات (Q8) بـ`kind`, `priority`, `scope` (`all_sources` افتراضياً), `applies_to`,
  `enabled`, `is_builtin` (Q10), `version`؛ `unique (user_id, kind, name)`.
- `rule_conditions`: شروط مرتبة بـ`position`، `mode` (all/any), `negate`, `min_matches`, ومرجع قاموس اختياري
  (`on delete set null (dictionary_id)`).
- `condition_terms`: إما مرجع مصطلح قاموس أو نص حرفي (`check num_nonnulls(...) = 1`).
- `filter_source_bindings`: ربط فلتر بمصادر (`unique (filter_id, source_id)`, `enabled`).
- `user_config_state`: `processing_version` (يبدأ من 0 ويُرقّى داخل معاملة كل كتابة إعدادات) و`seeded_at`
  (بوابة البذر مرة واحدة لكل مستخدم).
- مفاتيح أجنبية مركّبة تحمل الملكية `(id, user_id)` على `dictionaries`/`rule_sets`/`rule_conditions` لمنع الربط بين مستخدمين.

## 0011 — معالجة الرسائل: محتوى المطابق فقط ونتائج المطابقة (الخطوة 5‑ب)

- أنواع جديدة: `message_state` (`matched`/`ignored`/`processed`/`failed`)، `message_ignore_reason`، `message_review_state`.
- `message_identity` (أعمدة جديدة): `state` (افتراضياً `ignored` للصفوف القديمة)، `ignore_reason`, `matched_count`,
  `content_hash`, `is_repeat`, `review_state`, `processing_version`, `normalization_version`, `attempts`,
  `processing_error_code`, `processed_at`, `content_purged_at` — مع قيود اتساق (سبب التجاهل للحالة `ignored` فقط،
  صيغة البصمة `^[0-9a-f]{64}$`).
- `message_content`: مفتاح أساسي `identity_id` (علاقة 1:1 بالهوية، `on delete cascade`)، `message_text`, `caption`,
  `text_length`, `caption_length`, `content_hash`, `retention_expires_at`؛ قيود: 4096/1024، تطابق الأطوال مع النص،
  ومنع الصف الفارغ (Q3).
- `message_matches`: `(identity_id, filter_id)` مفتاح أساسي، `filter_name`, `priority`, `evidence` (jsonb: معرّفات الشروط
  والمصطلحات المطابقة — لا نص الرسالة)، `processing_version`, `matched_at`.
- `telegram_sources` (أعمدة جديدة): `matched_count`, `ignored_count`, `repeat_count`, `failed_count`.
- الحذف: `message_identity` ← `message_content`/`message_matches` بالتسلسل؛ وتنظيف الاحتفاظ يحذف المحتوى والنتائج
  ويبقي الهوية والبصمة (Q12).

## 0012 — الاستخراج وفئات التواصل (الخطوة 5‑ج)

- أنواع جديدة: `extraction_source` (`text`/`caption`)، `contact_kind` (`phone`/`username`/`telegram_id`/`email`/`url`/`invite_link`).
- `message_extraction`: صف لكل (هوية، حقل، موضع) — `field_key` (15 مفتاحاً مفروضاً بقيد)، `value_text` مقتطع حرفي،
  `span_start`/`span_end`، `source`، `cue` (القرينة للتدقيق)، `confidence numeric(3,2)`، `ambiguous`، `extraction_version`.
- `message_contacts`: `contact_kind`، `value_raw` + `value_normalized` + `value_masked` (O03: العرض الافتراضي محجوب)،
  المواضع، `confidence`، `ambiguous`، `extraction_version`.
- `message_identity` (جديدة): `extraction_version`, `extraction_count`, `contact_count`, `extracted_at`.
- `telegram_sources` (جديدة): `extracted_count`.
- الحذف: الجدولان `on delete cascade` من الهوية، ويحذفهما تنظيف الاحتفاظ مع المحتوى (نتائج لا مصدر).

## 0013 — التصنيف والقوالب (الخطوة 6)

- `templates` + `template_fields`: قالب لكل مستخدم بحقول مرتَّبة (`position`), تسميات قابلة للتعديل (`label`),
  وتعطيل لكل حقل؛ `field_key` مسموح = مفاتيح الاستخراج + `contact`.
- `template_bindings`: ربط القالب بمصدر/فلتر/تصنيف مع قيد شكل لكل نطاق وفهارس فريدة تمنع التعادل داخل المستوى.
- `message_classification`: صف تلقائي وصف يدوي (`origin`), الثقة، الغموض، الأدلة، وإصدار الإعدادات.
- `message_template_resolution`: القالب المختار + `resolved_by` (source/filter/classification/default/none) + `details` للتدقيق.
- `user_config_state.default_template_id` (مفتاح مركّب `on delete set null (…)`).
- `telegram_sources.classified_count`.
- التصنيفات نفسها في `rule_sets` بنوع `classification` (Q8)؛ بذورها 10 وتشمل «غير مصنف» بلا شروط.

## 0014 — بوت النشر والوجهات (الدفعة 7‑أ)

- أنواع جديدة: `publish_bot_status` (`active`/`invalid`/`disabled`)، `destination_chat_kind` (`channel`/`supergroup`/`group`)،
  `destination_status` (`pending`/`active`/`paused`/`revoked`/`error`/`deleted`).
- `publish_bots`: صف واحد لكل مستخدم (`unique (user_id)` — Q9). `token_ciphertext` (bytea: مغلّف AES‑256‑GCM)،
  `token_key_version`، `token_fingerprint` (sha‑256 للكشف عن التغيير بلا كشف الرمز)، `telegram_id`/`username` من `getMe`،
  `status`، `verified_at`، `last_error_code`، `token_updated_at`. **لا عمود للرمز الصريح.**
- `destinations`: `bot_id` بمفتاح مركّب `(id, user_id)` من `publish_bots`، `chat_id` (الهوية الفنية)، `chat_kind`، `title`،
  `username`، لقطة صلاحيات (`can_post_messages`, `can_edit_messages`, `member_status`)، `status`، `verified_at`,
  `last_error_code`؛ `unique (user_id, chat_id)`؛ الحذف تعطيل (`deleted`) لا مسح (Q15).
- الحذف: حذف المستخدم يحذف البوت ووجهاته بالتسلسل؛ حذف البوت يحذف وجهاته بالتسلسل.

## 0015 — مسارات التوجيه وحواف الحلقات (الدفعة 7‑ب)

- أنواع جديدة: `route_publish_mode` (`auto`/`review`)، `route_length_policy` (`split`/`reject`)،
  `route_scope_kind` (`source`/`filter`/`classification`)، `route_status` (`draft`/`active`/`paused`).
- `publish_routes`: `destination_id` (مركّب مع الملكية)، `template_id` (قالب المسار — O02، `set null`)،
  `publish_mode` (D01/Q4)، `length_policy` + `max_parts` (Q5)، `status`، `last_error_code`، `activated_at`؛
  `unique (user_id, name)` و`unique (id, user_id)`.
- `route_scopes`: `kind` + `source_id` أو `rule_set_id` بقيد شكل صريح، وقيد تكرار على (route, kind, target).
- `routing_edges`: حافة `(from_chat_id, to_chat_id, route_id)` بمعرّفات فنية للفحص الذري (O05)،
  `check (from_chat_id <> to_chat_id)`، وفهارس على طرفي الحافة وعلى `route_id`.
  تُبنى في معاملة التفعيل وتُحذف عند التعطيل/حذف المسار (`on delete cascade`).

## 0016 — تسليمات النشر (الدفعة 7‑ب)

- أنواع جديدة: `delivery_status` (9 حالات تشمل `uncertain` لـO04)، `delivery_review` (`not_required`/`pending`/`approved`/`rejected`).
- `deliveries`: `(identity_id, destination_id)` **فريد** (D05: تسليم منطقي واحد)، `route_id`، `template_id`، `plan_version`،
  `review` + `review_reason` (`route`/`message`)، `approved_*`، `status`، `chunk_count`، `chars_total`، `attempts`،
  `next_attempt_at`، `masking_version`، `formatting_version`، `last_error_code`، `published_at`.
  فهرس طابور جزئي على (`status`, `next_attempt_at`) حيث `queued`/`sending` للعامل في 7‑د.
- `message_identity.publish_state` (`not_routed`/`routed`/`awaiting_review`) — فصل حالة النشر عن المعالجة (§17).
- `user_settings.delivery_retention_days` (افتراضي 90) — احتفاظ مستقل لسجلات النشر (Q13).
- الحذف: التسليمات تُحذف مع الهوية أو الوجهة؛ حذف المسار يترك التسليم بلا مرجع (`set null`).

## 0017 — أجزاء النشر والمحاولات والأدلة (الدفعتان 7‑ج و7‑د)

- أنواع جديدة: `delivery_part_status` (`pending`/`sending`/`sent`/`failed`/`uncertain`)،
  `delivery_attempt_outcome` (`started`/`ok`/`retryable`/`permanent`/`uncertain`).
- `delivery_parts`: جزء واحد = رسالة واحدة في تيليجرام. `part_index` (1..n) **فريد لكل تسليم**،
  `text` نص HTML آمن **محجوب ومنسَّق**، `text_hash` (sha‑256) لكشف أي تغيير بين التخطيط والإرسال،
  `char_count` = الطول **بعد تحليل الكيانات** بقيد `1..4096`، `telegram_message_id`، `sent_at`، `attempts`،
  `last_error_code`، و`lease_owner`/`lease_expires_at` (استحواذ الجزء).
  الحذف: `on delete cascade` مع التسليم؛ فهرس على (`delivery_id`,`part_index`) وجزئي على اللُقية حيث `sending`.
- `delivery_attempts`: صف يُفتح **قبل** طلب HTTP (`outcome='started'`) ويُغلق بعده؛
  `attempt_no` فريد لكل (`delivery_id`,`part_id`)، `http_status`، `telegram_error_code`، `error_code` (≤64)،
  `error_detail` منقّح (≤200، بلا رمز بوت وبلا نص رسالة)، `retry_after_seconds`، `duration_ms`. **لا نص ولا أسرار.**
- `delivery_evidence`: دليل بشري لأي نتيجة مجهولة (O04): `method` ∈ (`message_id`,`manual_check`)،
  `decision` ∈ (`published`,`not_published`)، `telegram_message_id`، `note` (≤200)، `decided_at`، ومن قدّمه (`user_id`).
- `deliveries.lease_owner` + `lease_expires_at` (استحواذ مستوى التسليم) وفهرس جزئي حيث `sending`.
- سياسة النص: أجزاء النص تُمسح مع انتهاء احتفاظ المحتوى؛ ولا يُخزَّن أي قيمة تواصل خامة في أي من الجداول الثلاثة.

## 0018 — فهارس القراءة للوحة (P4‑أ)

فهارس فقط، بلا تغيير بنيوي. الغرض: أن تكون استعلامات العدّادات السبعة والعشرين قراءة فهرسية
لا مسحاً كاملاً، مع الحفاظ على حدود المستخدم (`user_id` أو عبر `message_identity`).

- `message_matches_identity_time_idx` (`message_identity_id`, `matched_at` desc) — «آخر تطابق» و«مطابقات 24 ساعة».
  (`message_matches` **لا يحمل `user_id`**؛ الملكية تُستمد من `message_identity`، وكل عدّ يمرّ بالربط.)
- `delivery_parts_pending_idx` جزئي على `delivery_parts (created_at)` حيث `status = 'pending'` — عمق الطابور وعمر أقدم جزء.
- `delivery_attempts_started_idx` (`started_at` desc) — نوافذ المحاولات (ساعة).
- `deliveries_user_status_time_idx` (`user_id`, `status`, `created_at` desc) — عدّادات التسليم لكل مالك ونوافذه الزمنية.

## 0019 — نبض العمال (P4‑ب)

- `worker_heartbeats`: `name` + `instance` مفتاح أساسي مركّب، `last_seen_at`، `meta jsonb`،
  و`check (name ~ '^[a-z][a-z0-9_]{2,40}$')` لمنع أي قيم حرة تُستخدم في استعلامات لاحقة.
- `meta` بيانات تشغيلية فقط (مثل `owner`, `concurrency`)؛ **ممنوع** أي محتوى أو رمز أو معرّف تواصل.
- النبض يُكتب في كل دورة عامل (upsert). الغياب يعني «لا ادّعاء حياة»: الجهوزية تعلن `missing`،
  والتقادم بعد `TG_OPS_WORKER_STALE_SECONDS` (افتراضي 120) يعلن `stale` دون إسقاط الجهوزية.
- الاحتفاظ: صف واحد لكل (name, instance) — لا تاريخ نبضات، فالحجم ثابت مهما طال التشغيل.

## 0020 — سجل الأخطاء (الدفعة P4‑ج، Q19)

- أنواع جديدة: `error_scope` (`telegram`/`processing`/`publishing`/`auth`/`system`)،
  `error_severity` (`warn`/`error`/`critical`).
- `error_events`: `user_id` (اختياري — بعض الأخطاء تشغيلية عامة)، `scope`، `kind`، `code`، `severity`،
  `detail`، `correlation_id`، `occurred_at`. **لا نص رسالة، لا قيمة تواصل، لا رمز، لا استثناء خام.**
- `detail` ليست جملة: مقطع آلي من قاموس مغلق (انظر `0022`)، وقيود المخطط ترفض أي شكل آخر.
- فهارس: `(user_id, occurred_at desc, id desc)` لقراءة المالك، `(scope, kind, occurred_at desc)` لتجميع المدير،
  `(occurred_at)` للتنظيف، `(severity, occurred_at desc)` للخطورة أولاً.
- الحذف: `on delete cascade` مع المستخدم — حذف الحساب يزيل أحداثه.

## 0021 — الاحتفاظ الموحّد (الدفعة P4‑د، Q23)

- `retention_runs`: صف لكل سياسة في كل تشغيل — `policy` ∈ (`content`,`identities`,`deliveries`,`error_events`,`audit_events`)،
  `triggered_by` ∈ (`scheduler`,`admin`,`user`)، `started_at`/`finished_at`، `deleted`، `error_code` (رمز آلي قصير).
- فهارس `(started_at desc)` و`(policy, started_at desc)`، وفهرس `deliveries (created_at)` لتنظيف التسليمات.
- بذر `system_settings`: `system.error_events_retention_days = {"days":30}` و`system.audit_retention_days = {"days":180}`
  (القيمة كائن لأن المخطط يفرض `jsonb` كائناً).
- **قاعدة الحذف**: لا يُحذف تسليم حيّ (`awaiting_review`/`queued`/`sending`) مهما طال عمره؛
  واحتفاظ التسليمات لكل مستخدم بحسب `user_settings.delivery_retention_days` (افتراضي 90).

## 0022 — تشديد `error_events.detail` (مراجعة الصرامة في P4‑ج)

- سبب الترحيل صريح: نمط `0020` كان يسمح بمقاطع لاتينية حرة بعد التقنيع، أي أن نصاً إنجليزياً
  واحداً قد يتسرّب بوصفه «تفصيلاً». البديل: **قاموس مغلق** —
  `^(http|policy|attempt|stage|status|wait|reason|field|step)\.[a-z0-9_]{1,32}(\.[a-z0-9_]{1,32}){0,2}$`.
- النتيجة: النص الحر والعربي وأرقام الهواتف ورموز البوت تُرفض على مستوى المخطط، والكود يرفضها قبل ذلك
  (`cleanDetail` ⇒ `null` عند أي شك). مثال مقبول: `http.500` أو `policy.content`.

## 0023 — إعادة النشر والترقيم المؤشِّر (الدفعة P4‑هـ، Q20)

- **`deliveries.republish_count`**: عدّاد `integer not null default 0` مع قيد
  `deliveries_republish_count_range check (republish_count between 0 and 3)`.
  السقف في المخطط لا في الخدمة وحدها: أي مسار مستقبلي يحاول `4` يفشل على مستوى القاعدة.
  ⚠️ `republish_count = 4` مرفوض بالقيد (`23514`)، وهذا مُثبَت في `republish.test.ts`.
- **`deliveries.last_republished_at`**: `timestamptz` قابل للعدم — وقت آخر إعادة تخطيط فقط.
- **`deliveries.last_error_code`**: موجود من `0016`؛ إعادة النشر **تُفرغه** لأن الخطة جديدة.
- **لا عمود `uncertain` ولا راية «إعادة بانتظار قرار»**: النتيجة المجهولة تبقى `uncertain` بلا عدّاد،
  والقرار (نشر/عدم نشر) يأتي من `delivery_evidence` فقط. لا يُخزَّن «سبب منع الإعادة» في القاعدة —
  يُحسب من الحالة (`republishCapability`) كي لا يتعارض مع الدليل لاحقاً.
- **فهرسة الترقيم المؤشِّر**: `message_identity (user_id, received_at desc, id desc)` موجود من `0018`؛
  المؤشِّر يستخدمه كما هو، فلا فهرس جديد. لا `created_at` في المؤشِّر: العمود المرجعي هو `received_at`
  و`id` للفصل الحتمي عند التعادل.
- **لا جدول جديد لهذه الدفعة**: الخط الزمني (P4‑هـ/٣) **يُجمَّع للقراءة فقط** من الجداول القائمة
  (`message_identity`, `message_matches`, `message_extraction`, `deliveries`, `delivery_parts`,
  `delivery_attempts`, `delivery_evidence`). لا جدول `journey_events` — لأن نسخ الحالة إلى جدول ثانٍ
  يخلق مصدر حقيقة منافساً ويتعارض مع مبدأ «حالة واحدة في مكان واحد».

## 0024 — مركز التنبيهات (الدفعة P4‑و)

- `alert_severity` enum من ثلاث قيم (`info`,`warning`,`critical`) بدل نص حر + قيد.
- `alert_notifications`: صف لكل (مستخدم، مفتاح تنبيه) **نشط**، مع `observed_count` و`payload` (كائن صغير)
  و`first_seen_at`/`last_seen_at` و`acknowledged_at`/`resolved_at`.
- **لا رسالة نصية في القاعدة**: `alert_key` آلي بقيد `^[a-z][a-z0-9_]{2,39}$`، والجملة العربية في الواجهة.
  قيود إضافية: `payload` كائن، حجمه ≤ 400 حرف (حماية من تحويل الصف إلى ناقل نص)، والعدّادات غير سالبة،
  و`acknowledged_at`/`resolved_at` لا تسبق `first_seen_at`.
- **فهرس فريد جزئي** `(user_id, alert_key) where resolved_at is null` ⇒ تنبيه نشط واحد لكل مفتاح؛
  التكرار يُحدِّث الصف، والحل ثم العودة يُنشئ صفاً جديداً (سجل تاريخي لا يُطمس).
- بذر `system_settings`: `system.uncertain_alert_threshold = {"count": 3}` (عتبة التصعيد من تحذير إلى حرج، Q26).

## 0025 — تصحيح أساس ترقيم صندوق التنبيهات (P4‑و)

- **خلل مكتشف بعد `0024`**: فهرس الفرز كان على `last_seen_at`، وهو عمود **متغيّر** (المزامنة تُحدِّثه في كل
  مسح). فأي صفحة تالية بمؤشِّر على هذا العمود قد تُسقط صفوفاً لأن الصفوف «تقفز» بعد المؤشِّر.
- **الإصلاح**: ترحيل أمامي يعيد بناء فهرسين على `first_seen_at desc, id desc` (عمود ثابت بالتعريف)،
  والكود يبني المؤشِّر على `first_seen_at`. لا تغيير أعمدة ولا حذف بيانات — فهارس فقط.
- **درس موثَّق**: أي ترقيم مؤشِّر يجب أن يُبنى على عمود **لا يتغيّر بعد الإنشاء**؛ و«آخر تحديث» يصلح للعرض
  لا للترقيم. أُبقيت `last_seen_at` للعرض والفرز البشري فقط.
- **درس ثانٍ**: مقارنة صف `(a, b) < ($1, $2)` بلا `::timestamptz::uuid` صريحة قد تُستنتج بأنواع خاطئة
  فتُسقط صفوفاً بصمت. كل مؤشِّرات الصفوف في المشروع تستخدم تحويلاً صريحاً للأنواع.
