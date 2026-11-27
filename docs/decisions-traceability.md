# تتبّع القرارات والمتطلبات إلى المرحلة الأولى

المرجع: `uploads/main.md` (21 قسماً، 25 معيار قبول) و`telegram-architecture-review.html` 1.2 (D01–D12، O01–O10).

| المرجع | الحالة في المرحلة 1 | الموضع |
|---|---|---|
| §2.1 عزل مساحات المستخدمين | **منفّذ** في طبقة الهوية: كل بيانات المرحلة مرتبطة بـ `user_id` من الجلسة | `middleware/auth.ts`, `modules/users` |
| §2.2 نوعان: مستخدم ومدير | **منفّذ** (`app_role`) مع حماية آخر مدير | `0001_core_identity.sql`, `modules/admin` |
| §2.3 تسجيل بالبريد وكلمة مرور، دخول/خروج، استعادة، إدارة حساب | **منفّذ** بالكامل عدا تسليم البريد الفعلي (بند معلّق) | `modules/auth` |
| §2.3 طرق تسجيل أخرى مستقبلاً | لم تُنفّذ (خارج النطاق) | — |
| §3.1/3.2 حساب عادي وتعدد الحسابات | **أساس منفّذ**: جدول حسابات مملوكة لكل مستخدم + عميل مستقل لكل حساب (لا واجهة ربط بعد) | `telegram_accounts`, `connectionManager` |
| §3.2 ربط/فصل/إعادة ربط | **منفّذ**: مسارات ربط كاملة مع رمز وتحقق بخطوتين وفصل نهائي | `telegram/routes.ts`, `loginService.ts` |
| §3.3 أمان الجلسات | **منفّذ**: تشفير AES‑256‑GCM، بصمة ملكية، لا عرض ولا تسجيل | `sessionCipher`, `sessionStore` |
| §3.4 حالة الاتصال | **منفّذ في الطبقة والواجهة**: الحالة تُعرض في صفحة حسابات تيليجرام مع أزرار توصيل/فصل | `connectionManager`, `TelegramAccountsPage` |
| §11 الأخطاء وإعادة الاتصال | **منفّذ للمصادقة والاتصال**: حدود محاولات، تأخير أسّي، FloodWait بلا حلقات | `errors.ts` |
| §4 المصادر والتحديثات | لم تُنفّذ | — |
| §5–§10 الفلترة/الاستخراج/القوالب/النشر | لم تُنفّذ | — |
| §12 لوحات المستخدم | **أساس منفّذ**: لوحة، إعدادات الحساب (ملف/احتفاظ/كلمة مرور)، الجلسات | `apps/web/src/pages` |
| §13 لوحة المدير | **جزئي منفّذ**: إحصاءات هوية/جلسات، إدارة مستخدمين، إعدادات عامة، سجل تدقيق. **بلا محتوى** (D07) | `pages/Admin*` |
| §14 الاحتفاظ | **جزئي**: مدة قابلة للتخصيص لكل مستخدم + افتراضي عام. التطبيق الفعلي يبدأ مرحلة المحتوى | `user_settings`, `system_settings` |
| §16 حماية كلمات المرور، الصلاحيات، عزل، حماية API | **منفّذ** | `docs/security.md` |
| §21 كود منظّم، اختبارات، توثيق، لا أسرار في Git، معاملات آمنة، تقرير مرحلة | **منفّذ** | هذا التوثيق + `npm test` |
| ق20 (مدير يدير المستخدمين ويراقب النظام) | **جزئي** بمستوى الهوية والتشغيل | `AdminOverviewPage` |
| ق21 (جلسات مشفرة ومعزولة) | **الجلسات الويب** منفّذة بالبصمات؛ تشفير جلسات **تيليجرام** يخص المرحلة الثانية | — |
| ق22 (خادم مستمر + تشغيل محلي) | **منفّذ** | `index.ts`, README |
| ق23 (عزل المستخدمين والصلاحيات) | **منفّذ ومختبر** | `phase1.test.ts` |
| ق2، ق5، ق17، ق18 | تخص تيليجرام/المعالجة — مراحل لاحقة | — |
| D02 عزل الهوية وعدم الدمج بين المستخدمين | **منفّذ** | `users`, `user_sessions` |
| D07 لا محتوى افتراضياً + تدقيق | **منفّذ على مستوى الهوية**؛ جداول الاطلاع على المحتوى لم تُنشأ بعد | `audit_events`, `modules/admin` |
| D09 48 ساعة افتراضية قابلة للتخصيص | **منفّذ كإعداد** (حد 1–2160) | `user_settings` |
| D11 ملف السعة 100×1×25 | **دعم التعدد** في المخطط؛ القياس في مرحلة لاحقة | — |
| D12 Node.js + React + PostgreSQL + بوابة مقارنة المكتبات | **منفّذ**، والمكتبة المختارة `teleproto 1.234.0` (MIT) بعقد مستقل يسمح ببديل TDLib | `modules/telegram`, `docs/telegram-integration.md` |
| D03 استعادة ما توفّر من تحديثات | **أساس منفّذ**: حفظ حالة التحديثات مشفّرة ووسم `missed`؛ الاستقبال الفعلي غير مختبر (لا اعتماد) | `sessionStore`, `messageMapper` |
| D06 النص المصاحب دون وسائط | **منفّذ في التحويل**: الوسائط لا تُنزَّل، وتُقرأ التسمية فقط | `messageMapper.ts` |
| D01, D04, D05, D08, D10 | **لم تُنفّذ** (تخص النشر والفلترة) | مراحل لاحقة |
| O01–O10 | قرارات مغلقة في 1.2؛ لم يُنفّذ منها في هذه المرحلة إلا ما يخص الهوية (O07 حدود الاطلاع، O08 التهيئة) | — |

## قرارات معتمدة — مراجعة الخطوة الثانية (2026‑11‑24)

| # | القرار | الحالة | المرجع في الكود |
|---|---|---|---|
| R1 | تسجيل الدخول عبر البريد (FIRE) غير مدعوم ويُرفض صراحةً | معتمد | `loginService.assertSupportedDelivery` |
| R2 | PHONE_MIGRATE مؤجل إلى ما بعد الاختبار الحي | معتمد | `errors.ts` + `loginService.fromClassified` |
| R3 | لا يُخزَّن الرقم الكامل؛ يُعاد إدخاله عند إعادة المصادقة | معتمد | `phone.ts`, `telegram_accounts.phone_hash` |
| R4 | لا سقف لعدد الحسابات لكل مستخدم حالياً (§3.2) | معتمد | `startLink` |
| R5 | الفصل يحفظ سجلاً `revoked` بعد مسح الهوية والبصمة والجلسة | معتمد | `markRevoked` |
| R6 | حد المعدل في الذاكرة مؤقتاً، ويجب نقله لمخزن مشترك قبل الإنتاج | معتمد | `middleware/rateLimit.ts` |
| R7 | انتهاء محاولة الربط يُستهلك تلقائياً، والمحاولة الجديدة تُستأنف على السجل المعلّق | معتمد (مراجعة) | `loginService.startLink` |
| R8 | حذف المحاولات المستهلكة الأقدم من 24 ساعة عند بدء محاولة جديدة | معتمد (مراجعة) | `loginChallengeStore.start` |

## قرارات معتمدة — الخطوة الثالثة (مصادر تيليجرام، 2026‑11‑24)

| # | القرار | السبب | المرجع في الكود |
|---|---|---|---|
| S1 | الهوية `(peer_type, peer_id)` هي الأساس، و`username` للعرض فقط | اسم المستخدم قابل للتغيير، والمعرّف الرقمي ثابت (O01) | `telegram_sources_peer_key` |
| S2 | مصدر واحد لكل مستخدم لكل هوية، ولو أُضيف من حسابات مختلفة | O01: مصدر واحد يُقرأ مرة واحدة؛ منع التكرار عبر قيد قاعدة بيانات | فهرس فريد + معالجة `23505` |
| S3 | المحادثات القديمة (basic groups) والبوتات والمستخدمون غير مدعومة صراحةً | `getDialogs` يعيد أنواعاً عدة؛ التحويل الصامت يخلق مصادر لا يمكن مراقبتها لاحقاً | `unsupported_source_type` |
| S4 | `include_own_messages` عدّاد افتراضي `false` لكل مصدر | §4.3: رسائل المستخدم نفسه لا تُعالج بلا تفعيل صريح | `telegram_sources.include_own_messages` |
| S5 | فترات التفعيل تُسجَّل في `telegram_source_periods` بنفس نمط فترات الحساب | يلزم لاحقاً حساب نافذة القراءة بدقة (O09) بلا إعادة بناء | جدول الفترات + فهرس الفترة المفتوحة |
| S6 | فصل الحساب يُوقف مصادره (`account_unlinked`) بدل حذفها | لا فقد بيانات المستخدم بلا طلب، ولا مراقبة على حساب مفصول | `loginService` → `pauseForAccount` |
| S7 | حذف المصدر يحذف صفّه وفتراته ويُبقي سجل التدقيق | D07: التدقيق سجل غير قابل للربط بمحتوى محذوف، وضيق الصفوف يمنع بيانات يتيمة | `sourceRepository.delete` |
| S8 | حد عدد المصادر لكل حساب من البيئة (25 افتراضياً) | D11/O08: ملف الإطلاق 25 مصدراً لكل حساب، قابل للرفع بعد القياس | `TG_MAX_SOURCES_PER_ACCOUNT` |

## قرارات مراجعة الخطوة الثالثة (اعتماد المستخدم، 2026‑11‑24)

| # | القرار | الحالة | المرجع في الكود |
|---|---|---|---|
| S8 | الحد الأقصى **25 مصدراً لكل حساب** (`TG_MAX_SOURCES_PER_ACCOUNT`) | **معتمد نهائياً** | `sourceService.createSource`, `env.ts` |
| S2 | **هوية المصدر فريدة لكل مستخدم** حتى لو امتلك أكثر من حساب | **معتمد نهائياً** | `telegram_sources_user_peer_key` |
| S11 | **فقدان العضوية يُوقف المصدر** (لا يبقى «نشطاً» بلا وصول) | **معتمد نهائياً** | `sourceService.refresh` + `setStatus('paused','access_lost')` |
| S4 | `include_own_messages` **إعداد مستقل لكل مصدر** (افتراضي `false`) | **معتمد نهائياً** | `PATCH /sources/:id`, `telegram_sources.include_own_messages` |
| S6 | **الفصل العادي** (`DELETE /accounts/:id` → `revoked`) يحفظ المصادر **متوقفة** | **معتمد نهائياً** | `loginService.unlinkAccount` → `pauseForAccount` |
| S9 | **الحذف الفعلي** لسجل الحساب يحذف مصادره التابعة عبر `CASCADE` | **معتمد نهائياً** | `telegram_sources.account_id … on delete cascade` |
| S10 | معرّف المصدر يبقى **نصاً** في كل الطبقات (DB `bigint` ↔ `::text` ↔ JSON string)، ويُرفض ما يخرج عن نطاق BIGINT أو السالب بـ`400` | **معتمد (إصلاح مراجعة)** | `sourceRoutes.peerIdSchema`, `createSource`, `parseSourceIdentifier` |

## قرارات تنفيذ المراجعة النهائية (2026‑11‑24)

| # | القرار | الحالة | المرجع في الكود |
|---|---|---|---|
| S12 | **ملكية القارئ مفروضة في قاعدة البيانات**: `telegram_sources(account_id, user_id) → telegram_accounts(id, user_id)` مع `unique (id, user_id)` و`on delete cascade` | **معتمد ومنفَّذ** (0007) | `0007_source_owner_integrity.sql` |
| S13 | **فصل الحساب ذرّي**: المحاولات + الجلسة + حالة الحساب + إيقاف المصادر وفتراتها + التدقيق في معاملة واحدة؛ فشل أي جزء يُلغي الكل | **معتمد ومنفَّذ** | `loginService.unlinkAccount`, `pauseForAccount(client)` |
| S14 | **استئناف المصدر لا يشترط اتصالاً فعلياً**، يكفي ألا يكون الحساب `revoked`/`suspended` | معتمد (بلا تغيير) | `sourceService.resume` |
| S15 | **حد 25 مصدراً لكل حساب يشمل النشط والموقوف** | معتمد (بلا تغيير) | `countByAccount` |
| S16 | **هوية المصدر فريدة لكل مستخدم** مهما تعددت حساباته | معتمد (بلا تغيير) | `telegram_sources_user_peer_key` |
| S17 | **فقدان العضوية يُوقف المصدر** | معتمد (بلا تغيير) | `sourceService.refresh` |
| S18 | **`include_own_messages` إعداد مستقل لكل مصدر** | معتمد (بلا تغيير) | `PATCH /sources/:id` |
| S19 | **الفصل العادي يُبقي سجل الحساب `revoked` والمصادر `paused`**، والحذف الفعلي للسجل يُسقط المصادر بـ`cascade` | معتمد (بلا تغيير) | `markRevoked`, `pauseForAccount`, قيد المفتاح |

## قرارات الخطوة الرابعة (محرّك الالتقاط، 2026‑11‑24)

| # | القرار | الحالة | المرجع في الكود |
|---|---|---|---|
| S20 | لا حفظ لنص الرسائل ولا للوسائط: هوية الرسالة فقط | معتمد | `message_identity`, `ingestRepository` |
| S21 | مؤشرات الالتقاط على `telegram_sources`، وتأجيل `update_checkpoints` | معتمد | `0008_ingest_and_message_identity.sql` |
| S22 | احتفاظ 30 يوماً (قابل للضبط) لهويات منع التكرار، مع توثيق أن الضمان بعدها غير مضمون | معتمد | `TG_INGEST_IDENTITY_RETENTION_DAYS` |
| S23 | واجهة حالة الالتقاط للقراءة فقط | معتمد | `TelegramIngestPage.tsx`, `ingestRoutes.ts` |
| S24 | لا استيراد تاريخ ولا `getHistory` | معتمد | `TelegramAccountClient` (لا واجهة تاريخ) |
| S25 | محرّك الالتقاط داخل خدمة API بلا عامل مستقل | معتمد | `runtime.ts` |
| S26 | **Durable Checkpoint Guard**: لا تتقدّم النقطة المحفوظة على رسالة لم تُحسم معاملتها، وفشل الحفظ يثبّتها | معتمد | `checkpointGuard.ts`, `teleprotoGateway.ts` |
| S27 | الرسائل المُعادة بعد التعطّل تُحصى «مكررة» فقط إن وُجدت هويتها، وإلا فهي التقاط جديد | معتمد | `ingestRepository.recordMessage` |
| S28 | عدّاد عام واحد للتحديثات غير المرتبطة بمصادر مراقبة، بلا تفاصيل | معتمد | `ingestService.handle` |
| S29 | التكرار يُحسم بـ`INSERT … ON CONFLICT DO NOTHING RETURNING` داخل معاملة واحدة مع العدّاد | معتمد | `ingestRepository.recordMessage` |
| S30 | لا كشف فجوات: لا إشارة موثّقة من المكتبة، ولا تُدّعى التغطية؛ أُزيلت أعمدتها في 0009 | معتمد | `0009_drop_unused_gap_columns.sql` |

## تصحيحات تنفيذ المراجعة التقنية (الخطوة 4) — لا تغيّر أي قرار معتمد

| # | التصحيح | السبب | الاختبار |
|---|---|---|---|
| S31 | تمرير `updateState` المحفوظ إلى عميل الحساب قبل `connect()` وإنشاء الحارس بعد تهيئة الجلسة | (أ) كان الحقل يُنشأ قبل تعيين `session` فكان إنشاء أي عميل حقيقي يفشل؛ (ب) كانت نقطة الاستئناف لا تُستعاد فيتخطّى تيليجرام ما فات | `telegram-gateway-guard.test.ts`, `telegram-restart.test.ts`, `telegram-connection-manager.test.ts` |
| S32 | منع ترقية النقطة المحفوظة أثناء انشغال موزّع المكتبة (نافذة بين تقدّم `pts` وبدء المعالج) | إغلاق نافذة فقدان صامت ضيقة كانت تسمح بحفظ نقطة تسبق رسالة غير معالجة | `checkpoint-guard.test.ts`, `telegram-gateway-guard.test.ts` |
| S33 | عدم مسح نقطة محفوظة عند لقطة حيّة غير مقروءة، ومنع النزول تحت النقطة المستعادة | لقطة `undefined` ليست دليلاً على التقدّم، ومسحها يعني البدء من الصفر بلا داعٍ | `checkpoint-guard.test.ts` |
| S34 | محو `last_ingest_error_code` عند نجاح لاحق داخل معاملة الإدراج | مؤشر يقول «فشل» بعد نجاح فعلي = عدّاد يكذب | `telegram-ingest.test.ts` |

## قرارات الخطوة الخامسة (أ+ب) — معتمدة ومطبَّقة

| # | القرار | الحالة | المرجع في الكود/المخطط | الاختبار |
|---|---|---|---|---|
| Q1/S20 | حفظ نص **الرسائل المطابقة فقط** بمدة احتفاظ المحتوى (48 ساعة افتراضياً) | مطبَّق | `message_content`, `messageProcessingService` | `message-processing.test.ts` |
| Q2 | فصل المحتوى عن الهوية، نص وتعليق منفصلان، بلا نسخة مطبَّعة أو معروضة | مطبَّق | `0011`, `contentTypes.ts` | `content-types.test.ts` |
| Q3 | رسالة بلا نص ولا تعليق ⇒ `ignored/no_text` بلا محتوى | مطبَّق | `prepareContent`, `markIgnored` | `message-processing.test.ts` |
| Q4 | فشل المعالجة ⇒ `failed` مع تقدّم نقطة الاستئناف؛ التثبيت فقط عند فشل حفظ الهوية | مطبَّق | `messageProcessingService.process` | `message-processing-service.test.ts` |
| Q5 | تعديل/حذف الرسائل **مؤجَّل ومُوثَّق** | مؤجَّل بقرار | `docs/phase-2-step-5a-5b.md` §4 | — |
| Q6 | `is_repeat` الآن، ومنع النشر في المرحلة الثالثة | مطبَّق جزئياً بحسب القرار | `isRepeatContent`, `repeat_count` | `message-processing.test.ts` |
| Q7 | النتائج غير المؤكدة تبقى بلا فشل مع علم مراجعة | هيكل جاهز | `review_state` | — |
| Q8 | جدول `rule_sets` موحّد للفلاتر والتصنيفات | مطبَّق | `0010` | `telegram-filters.test.ts` |
| Q9 | لا فلتر ينطبق على المصدر ⇒ `ignored/no_source_filter` + تحذير واجهة لاحقاً | مطبَّق (الوسم) | `filterService.decide` | `telegram-filters.test.ts`, `message-processing.test.ts` |
| Q10 | البذور لكل مستخدم وغير قابلة للتعديل الجماعي؛ التخصيص نسخة جديدة | مطبَّق | `seeds.ts`, `is_builtin` | `telegram-filters.test.ts` |
| Q11 | 4096/1024/8192 ⇒ `ignored/too_long` بلا اقتطاع | مطبَّق | `CONTENT_LIMITS` | `content-types.test.ts`, `message-processing.test.ts` |
| Q12 | احتفاظ مستقل: محتوى/نتائج 48 ساعة، هوية+بصمة 30 يوماً | مطبَّق | `purgeExpiredContent`, `content_purged_at` | `message-processing.test.ts` |
| Q13 | معالجة متزامنة داخل العملية بلا طابور يحمل نصاً | مطبَّق | `runtime.ts` (`MessageProcessingService`) | `message-processing.test.ts` |
| Q14 | توسيع عدّادات المصدر + عرضها في صفحة الحالة | مطبَّق | `matched_count`…, `TelegramIngestPage.tsx` | `message-processing.test.ts` |

## قرارات الخطوة الخامسة (ج) — الاستخراج وفئات التواصل

| # | القرار/المتطلب | الحالة | المرجع في الكود | الاختبار |
|---|---|---|---|---|
| F05 | استخراج مقيَّد بالقرائن، بلا اختراع، والحقل الغائب يُحذف | مطبَّق | `extraction/fieldExtractor.ts`, `extraction/cues.ts` | `field-extractor.test.ts` |
| §7.5 | إسناد كل قيمة إلى موضعها في النص الأصلي (span) للتدقيق | مطبَّق | `normalizeWithMapping`, `message_extraction` | `normalization-mapping.test.ts`, `message-extraction.test.ts` |
| §7.4 | لا قيم افتراضية ولا «غير معروف» | مطبَّق | رفض المرشّحات غير الصالحة | `field-extractor.test.ts` |
| O03 | حجب أرقام الهواتف وروابط التواصل ومعرّفات الحساب افتراضياً | مطبَّق (تخزين الصيغة المحجوبة) | `extraction/contactDetector.ts`, `value_masked` | `contact-detector.test.ts`, `message-extraction.test.ts` |
| Q7 | الغموض ⇒ يبقى `processed` مع `review_state=needs_review` | مطبَّق | `extractionRepository.saveExtraction` | `message-extraction.test.ts` |
| Q4 | فشل الاستخراج ⇒ `failed` بلا إيقاف نقطة الاستئناف | مطبَّق | `messageProcessingService` | `message-processing-service.test.ts` |
| D06 | لا استخراج من الوسائط؛ النص والتعليق فقط | مطبَّق | `ExtractionService.extractAndStore` | `message-extraction.test.ts` |
| Q12 | نتائج الاستخراج تُحذف مع احتفاظ المحتوى | مطبَّق | `purgeExpiredContent` | `message-extraction.test.ts` |

## قرارات الخطوة السادسة (أ+ب) — التصنيف والقوالب والمراجعة

| # | القرار/المتطلب | الحالة | المرجع في الكود | الاختبار |
|---|---|---|---|---|
| §8 | تصنيف قائم على القواعد بلا ذكاء اصطناعي مدفوع، قابل للتخصيص | مطبَّق | `classificationService.ts`, `rule_sets.kind='classification'` | `classification.test.ts` |
| §8 | 10 تصنيفات بذرية مع «غير مصنف» كثابت عرض | مطبَّق | `seeds.ts` (`SEED_CLASSIFICATIONS`) | `telegram-filters.test.ts`, `message-results.test.ts` |
| O02 | التعديل اليدوي للتصنيف يغلب في العرض | مطبَّق | `resultsRepository.setManualClassification`, `origin='manual'` | `message-results.test.ts` |
| §7.2 | 7 قوالب جاهزة منذ البداية | مطبَّق | `seeds.ts` (`SEED_TEMPLATES`) | `message-results.test.ts` |
| §7.4 | حذف الحقل الغائب بدل قيمة افتراضية | مطبَّق | `templateRenderer.ts` | `template-renderer.test.ts` |
| §7.3 | تعديل أسماء الحقول وترتيبها وتعطيلها | مطبَّق (API) | `ruleConfigRepository.updateTemplate` | `message-results.test.ts` |
| O02 | أولوية القالب: route ← مصدر ← فلتر ← تصنيف ← افتراضي | مطبَّق | `templateResolver.ts` | `template-resolver.test.ts`, `message-results.test.ts` |
| O03 | التواصل محجوب في الواجهات وفي معاينة القالب | مطبَّق | `resultsService.maskContactSpans`, `contactsLine` | `message-results.test.ts` |
| §7.5 | إمكانية الرجوع للنص الأصلي للتحقق | مطبَّق (مقنَّعاً) | `GET /telegram/results/:id` | `message-results.test.ts` |
| D07/O03 | لا قيمة تواصل خامة في أي استجابة | مطبَّق | استعلامات لا تختار `value_raw` | `message-results.test.ts` |
| Q7 | الغموض ⇒ `review_state=needs_review` مع الاستمرار `processed` | مطبَّق | `resultsService.classifyAndSelectTemplate` | `message-results.test.ts` |
| Q12 | التصنيف واختيار القالب يُحذفان مع احتفاظ المحتوى | مطبَّق | `purgeExpiredContent` | `message-results.test.ts` |

## قرارات المرحلة الثالثة — الدفعتان 7‑أ و7‑ب

| # | القرار/المتطلب | الحالة | المرجع في الكود | الاختبار |
|---|---|---|---|---|
| §10.1 | النشر عبر Bot API بعد إثبات صلاحية البوت | مطبَّق (تحقق فقط، بلا إرسال) | `botService.ts`, `destinationService.ts` | `publish-bots-destinations.test.ts` |
| §12.6 | إضافة قناة، ربط البوت، اختبار الصلاحيات، إيقاف، حذف | مطبَّق | `publishingRoutes.ts`, `TelegramPublishPage.tsx` | `publish-bots-destinations.test.ts` |
| Q1 | تشفير رمز البوت بمفتاح مستقل + AAD على معرّف الصف | مطبَّق | `botCipher.ts` | `bot-cipher.test.ts` |
| Q2 | عميل Bot API بـfetch ومهلة وتصنيف أخطاء | مطبَّق | `botApiClient.ts` | `bot-api-client.test.ts` |
| Q3 | شروط المسار «أيٌّ من» (مصدر/فلتر/تصنيف) | مطبَّق | `route_scopes`, `listRoutingCandidates` | `publish-routes.test.ts` |
| Q4 | غموض المعالجة يفرض مراجعة النشر | مطبَّق | `planDeliveries` | `publish-routing.test.ts`, `publish-routes.test.ts` |
| Q5 | التقسيم افتراضي مع خيار رفض لكل مسار | مطبَّق (تخزين السياسة) | `publish_routes.length_policy` | `publish-routes.test.ts` |
| Q8 | إضافة الوجهة بـ@username أو chat_id | مطبَّق | `normalizeIdentifier` | `publish-routing.test.ts` |
| Q9 | بوت نشر واحد لكل مستخدم | مطبَّق | `publish_bots unique (user_id)` | `publish-bots-destinations.test.ts` |
| D05 | تسليم منطقي واحد لكل (رسالة، وجهة) | مطبَّق | `deliveries unique (identity_id, destination_id)` | `publish-routes.test.ts` |
| O02 | قالب المسار أعلى أولوية | مطبَّق | `planDeliveries`, `deliveries.template_id` | `publish-routing.test.ts`, `publish-routes.test.ts` |
| D01/§10.4 | نشر تلقائي افتراضياً ومراجعة اختيارية | مطبَّق | `route_publish_mode`, `deliveries.review` | `publish-routes.test.ts` |
| O05/Q14 | فحص حلقات ذري بمعرّفات فنية، عالمي، برفض محايد | مطبَّق | `routeService.applyActivation`, `findCyclePath` | `publish-routes.test.ts` |
| §17 | فصل حالة النشر عن حالة المعالجة | مطبَّق | `message_identity.publish_state` | `publish-routes.test.ts` |
| Q13 | احتفاظ مستقل لسجلات النشر | مطبَّق (عمود + سياسة؛ التنظيف الدوري في 7‑د مؤجَّل بصراحة) | `user_settings.delivery_retention_days` | — |
| D07/O03 | لا رمز بوت في أي استجابة/سجل/تدقيق | مطبَّق | `redactToken`, استعلامات بلا `token_ciphertext` | `publish-bots-destinations.test.ts` |
| Q5 (مرحلة 2) | تعديل/حذف الرسائل مؤجَّل | مؤجَّل كما هو | — | — |
| §10.5 | التنسيق، التقسيم، والإرسال والأخطاء | مطبَّق (7‑ج/7‑د) | `publisher.ts`, `deliveryPlanner.ts`, `deliveryWorker.ts` | `publish-formatting.test.ts`, `publish-plan.test.ts`, `publish-worker.test.ts` |

## قرارات المرحلة الثالثة — الدفعتان 7‑ج و7‑د

| # | القرار/المتطلب | الحالة | المرجع في الكود | الاختبار |
|---|---|---|---|---|
| §10.5/شرط المستخدم | قياس الطول **بعد تحليل كيانات HTML** لا قبله | مطبَّق | `htmlVisibleLength`, `htmlVisibleText` | `publish-formatting.test.ts` |
| O03/شرط المستخدم | حجب نهائي مزدوج لجهات الاتصال قبل التثبيت، وأي فشل ⇒ رفض آمن | مطبَّق | `enforceMasking`, `planPost` | `publish-formatting.test.ts`, `publish-plan.test.ts` |
| Q5/شرط المستخدم | `split` افتراضي، و«رفض» يمنع لا يقتطع (لا اقتطاع صامت) | مطبَّق | `planPost` (`policy`/`maxParts`) | `publish-formatting.test.ts`, `publish-plan.test.ts` |
| Q6 | لا ترقيم «(1/3)» في الأجزاء | مطبَّق | `planPost` | `publish-formatting.test.ts` |
| Q7 | HTML فقط، والمعاينة معطّلة | مطبَّق | `sendMessage`, `planPost` | `publish-formatting.test.ts`, `publish-worker.test.ts` |
| Q12 | 5 محاولات/6 ساعات، تباعد تصاعدي، واحترام `retry_after` حرفياً؛ **الإعادة محصورة في 429** | مطبَّق | `planRetry`, `classifySendFailure` | `publish-worker.test.ts` |
| قرار المستخدم (7‑د) | **5xx ⇒ نتيجة مجهولة** (لا إعادة تلقائية) لأن الخادم قد يكون حفظ الرسالة قبل سقوطه | مطبَّق | `classifySendFailure` → `server_unknown` | `publish-worker.test.ts` (اختبار مخصص) |
| قرار المستخدم (7‑د) | **تسلسل الأجزاء أهم من السرعة**: استحواذ على مستوى التسليم يمنع الإرسال المتوازي لأجزائه | مطبَّق | `claimPart` | `publish-worker.test.ts` |
| Q10/شرط المستخدم | **اللُقى إلزامية**: تزامن ≤3 داخل العملية، استحواذ تسليم + جزء، واستعادة لُقى منتهية | مطبَّق | `claimPart`, `recoverExpiredLeases`, `DeliveryWorker` | `publish-worker.test.ts` |
| O04/شرط المستخدم | **المحاولة تُحفظ قبل HTTP**؛ والمجهول لا يُعاد تلقائياً ويحتاج دليلاً بشرياً | مطبَّق | `openAttempt` قبل `sendMessage`, `delivery_evidence` | `publish-worker.test.ts` |
| D01/§10.4 | لا إرسال بلا اعتماد بشري عند طلب المراجعة، وإعادة التخطيط تُبطل الموافقة | مطبَّق | `claimPart` (شرط `approved_version = plan_version`), `DeliveryService.review` | `publish-worker.test.ts` |
| §10.5 | فاصل ١.٢ ثانية لكل محادثة | مطبَّق | `ChatSpacer` | `publish-worker.test.ts` |
| O06/D09 | لا إرسال بعد انتهاء احتفاظ المحتوى (إغلاق `content_expired`) | مطبَّق | `DeliveryPlanner.plan` | `publish-plan.test.ts` |
| Q15/§12.7 | إيقاف الوجهة يمنع الإرسال ويُغلق التسليم `blocked` | مطبَّق | `blockUnroutableDestinations` | `publish-worker.test.ts` |
| D07/O03 | لا رمز بوت ولا قيمة تواصل خامة في السجلات أو المحاولات | مطبَّق | `delivery_attempts` بلا نص، `redactToken` | `bot-api-client.test.ts`, `publish-worker.test.ts` |
| Q11 (مرحلة 2) | فحص `editMessageText` يدوي وصريح فقط، لا تلقائي | الالتزام قائم: لا استدعاء في الكود | — | — |
| Q5 (مرحلة 2) | تعديل/حذف الرسائل مؤجَّل | مؤجَّل كما هو | — | — |
| Q16 | لوحة بقراءة مباشرة + ذاكرة قصيرة 15 ثانية لكل مستخدم (`fresh=1` يتجاوزها) | مطبَّق | `DashboardService`, `dashboardRoutes` | `dashboard.test.ts` |
| Q17 | `/healthz` و`/readyz` عامّان ومختصران، والمقاييس للمدير فقط | مطبَّق | `createPublicOpsRouter`, `createAdminOpsRouter` | `ops.test.ts` |
| Q18 | النبض يُسجَّل في قاعدة البيانات (لا في الذاكرة) | مطبَّق | `worker_heartbeats`, `DeliveryWorker.heartbeat` | `ops.test.ts` |
| Q24 | **لا وصول مدير إلى محتوى المستخدم في v1**: المقاييس أعداد فقط، والنشاط يقتصر على صاحب الحساب | مطبَّق | `PgDashboardStore`, `opsRoutes` | `dashboard.test.ts`, `ops.test.ts` |
| Q26 | عتبات التنبيه من التصميم §7.2، ونبض العامل يُقاس بعتبة قابلة للضبط | مطبَّق | `buildAlerts`, `TG_OPS_WORKER_STALE_SECONDS` | `dashboard.test.ts`, `ops.test.ts` |
| Q29 | pino بمُعرّفات ترابط، بلا OTel | مطبَّق | `logger` | — |
| §20/17–18 (مؤجَّل بقرار المستخدم) | تعديل/حذف الرسائل المنشورة **خارج نطاق V1**؛ لا نهاية ولا واجهة ولا مسار إعادة إرسال للتعديل | مؤجَّل موثَّق | — | — |
| Q19 | سجل أخطاء موحّد `error_events`، احتفاظ 30 يوماً، بلا محتوى ولا استثناءات خام | مطبَّق | `0020`, `0022`, `lib/errorLog.ts` | `logs.test.ts` |
| Q21 | حذف يدوي للبيانات التشغيلية فقط، بعبارة تأكيد + تقرير أثر + تدقيق؛ والمدير ينفّذه بسبب إلزامي | مطبَّق | `PgRetentionStore.purgeOperationalData`, `/me/data/purge`, `/admin/users/:id/purge-data` | `deletion.test.ts` |
| Q22 | حذف الحساب **فوري نهائي** (كلمة مرور + عبارة حرفية): إبطال الجلسات + حذف كل ما يخصه + تدقيق بلا هوية | مطبَّق | `hardDeleteAccount`, `dangerZone.ts` | `deletion.test.ts`, `phase1.test.ts` |
| Q23 | مشغّل احتفاظ واحد داخل العملية يضم كل السياسات مع `retention_runs` ونبض `retention_scheduler` | مطبَّق | `retentionService.ts`, `0021` | `retention.test.ts` |
| §14 | لا يُحذف تسليم حيّ بالتنظيف؛ وتقصير الاحتفاظ يُطبَّق في الدورة التالية | مطبَّق | `purgeExpiredDeliveries` | `retention.test.ts` |
| D07/O03 (P4-ج) | لا نص رسالة ولا رقم تواصل ولا رمز في السجلات — قيد مخطط لا مراجعة بشرية | مطبَّق | `cleanDetail`, قيد `error_events_detail_shape` | `logs.test.ts` |
| Q20 | **إعادة النشر مقيَّدة بصرامة**: تُسمح فقط لـ`failed`/`cancelled`/`blocked`، و**يُمنع منعاً باتاً** أي إعادة لـ`uncertain` (تبقى معلَّقة حتى يحسمها الدليل)، والسقف ٣ إعادات | مطبَّق | `republishCapability`, `prepareRepublish`, `POST /publish/deliveries/:id/republish`, `0023` | `republish.test.ts` |
| Q20/§10.4 | إعادة التخطيط **تُبطل الاعتماد**: `approved_version = null` والعودة إلى `awaiting_review`, `plan_version` يتقدّم | مطبَّق | `prepareRepublish` (قفل صف) | `republish.test.ts` |
| Q20 (عدّاد) | المحاولة الفاشلة بعد الإعادة **لا تستهلك** عدّاد الإعادات؛ الاستهلاك عند إعادة التخطيط فقط | مطبَّق | `prepareRepublish` | `republish.test.ts` |
| Q30 (ترقيم مؤشِّر) | قائمة النتائج تُرقَّم بمؤشِّر ثابت (keyset على `received_at desc, id desc`) بدل `offset`؛ `total` يبقى للوضع القديم فقط (`offset`) | مطبَّق | `resultsRepository.list`, `resultsRoutes` | `results-journey.test.ts` |
| P4‑هـ/١ (اختبار الفلتر) | اختبار الفلاتر على نص تجريبي **في الذاكرة**: بلا استخراج وبلا أي كتابة في القاعدة | مطبَّق | `filterService.test`, `filterRoutes` | `filter-test.test.ts` |
| P4‑هـ/٣ (الخط الزمني) | الحالات الثلاث (`state`, `publish_state`, `deliveries.status`) تُدمج في خط زمني واحد مقروء، **بلا جدول جديد** وبلا نص رسالة أو أرقام تواصل | مطبَّق | `JourneyRepository`, `GET /results/:identityId/journey` | `results-journey.test.ts` |
| P4-و/١ (مركز التنبيهات) | تنبيهات داخلية مشتقّة من حالة حقيقية (تعطّل العامل، تراكم المجهول، إعادة ربط، مراجعة معلّقة) مع اعتراف صريح؛ **لا نص حر في القاعدة** | مطبَّق | `0024`, `notificationsRepository`, `notificationsService`, `GET/POST /api/v1/notifications` | `notifications.test.ts`, `notifications-policy.test.ts` |
| P4-و/١ (الاعتراف) | الاعتراف لا يُغلق التنبيه؛ والتصعيد (رفع الخطورة) **يُفرغ الاعتراف** — لا يُعترف بحالة حرجة بضغطة على تحذير | مطبَّق | `sync` (`isEscalation ⇒ acknowledged_at = null`) | `notifications.test.ts` |
| P4-و/١ (العتبات، Q26) | عتبة «تراكم المجهول» قابلة للضبط في `system_settings` لا مضمّنة في الكود | مطبَّق | `system.uncertain_alert_threshold`, `systemCount()` | `notifications-policy.test.ts`, `notifications.test.ts` |
| P4-و/٢ (`ErrorBoundary`) | حدود أخطاء على مستويين: حاجز أعلى للتطبيق + حاجز لكل صفحة داخل التنقّل، بلا رسالة استثناء خام للمستخدم، وإعادة ضبط عند تغيير المسار | مطبَّق | `components/ErrorBoundary.tsx`, `App.tsx`, `Layout.tsx` | — (بناء + `tsc`) |
| P4-و/٣ (الرحلة الكاملة E2E) | سيناريو واحد يغطي: تسجيل ← ربط ← مصدر ← فلتر (اختبار في الذاكرة) ← استقبال ← تصنيف/قالب ← وجهة/مسار ← إرسال ← نتائج/مؤشِّر ← خط زمني ← لوحة ← تنبيه ← اعتراف ← منع إعادة نشر المجهول ← سجلات/تدقيق بلا محتوى | مطبَّق | `test/e2e-journey.test.ts` | `e2e-journey.test.ts` |
| P4-ز/١ (ملفات التشغيل) | خدمة systemd واحدة (API + عامل + احتفاظ)، ترحيلات كوحدة oneshot مستقلة، ونسخ احتياطي بمؤقت — **لا وحدة عامل ثانية** تفادياً لمنافسة نفس الطابور | مطبَّق | `deploy/systemd/*` | `systemd-analyze verify` (نظيف) |
| P4-ز/٢ (nginx/TLS) | وكيل عكسي بـTLS 1.2/1.3 + HSTS + CSP + منع التأطير + تحديد معدل مزدوج؛ الخدمة على 127.0.0.1 فقط | مطبَّق | `deploy/nginx/tg-monitor.conf`, `deploy/nginx/snippets/tg-proxy.conf` | `nginx -t` (ناجح) |
| P4-ز/٣ (النسخ والاستعادة) | `pg_dump` مخصّص مضغوط + بصمة SHA-256 + تشذيب محدود؛ الاستعادة تُفحص أولاً وتُجرَّب في قاعدة منفصلة، والحيّة تحتاج تأكيداً مكتوباً | مطبَّق | `deploy/scripts/backup.sh`, `restore.sh` | تنفيذ فعلي: نسخة + استعادة مطابقة (25 ترحيلاً/44 جدولاً) |
| P4-ز/٤ (دليل التشغيل) | دليل عربي كامل: متطلبات، قاعدة، TLS، نشر أول، نسخ/استعادة، مفاتيح وتدويرها، ترقية/تراجع، مراقبة، أعطال، حوادث، كارثة | مطبَّق | `docs/runbook.md`, `deploy/README.md` | — |
| P4-ز/٥ (الأمان والحدود) | قائمة تحقّق أمان مُستندة للاختبارات + ثغرات معروفة مقبولة صريحة + حدود مضمّنة + أهداف أداء مقيسة | مطبَّق | `docs/production-readiness.md` | قياس 50,000 صف: صفحة عمق 5,000 في 1.9ms مقابل 30ms بـoffset |
| P4-ز/٦ (خلل بناء الإنتاج) | `tsc` لا ينسخ `.sql` ⇒ حزمة إنتاج لا تُرحّل. أُصلح بنسخ الأصول في البناء + بحث احتياطي لمجلد الترحيلات | مطبَّق | `scripts/copy-assets.mjs`, `src/db/migrate.ts` | `node dist/db/migrate.js` على قاعدة جديدة: 25 ترحيلاً |
| حادثة-١ (جلسة الواجهة في إطار المعاينة) | في إطار بمصدر شفاف (sandbox بلا `allow-same-origin`) يعامل المتصفح ملف الجلسة كطرف ثالث، فيُحجب `SameSite=Lax` و`credentials: same-origin`. الحل: `SESSION_COOKIE_SAMESITE` (افتراضي `lax`، وخيار `none` يفرض `Secure`) + `credentials: include` في العميل | مطبَّق | `config/env.ts`, `auth/sessionService.ts`, `web/src/api/client.ts` | الاختبارات 261/261 + تحقّق حيّ: `Set-Cookie: … HttpOnly; Secure; SameSite=None` ثم `/auth/session` ⇒ `authenticated: true` |
| حادثة-٢ (زر الخروج لا يستجيب) | فشل طلب `POST /auth/logout` (جلسة منتهية أو رمز CSRF قديم أو حجب ملف التعريف) كان يترك الحالة المحلية كما هي فلا يحدث أي أثر مرئي. الحل: الخروج يُفرّغ الحالة ويحوّل للدخول في كل الأحوال | مطبَّق | `web/src/auth/AuthContext.tsx`, `components/Layout.tsx` | `tsc` نظيف + بناء الواجهة ناجح |
| حادثة-٣ (حجب ملف الجلسة كلياً في إطار المعاينة) | `SameSite=None` غير كافٍ حين يمنع المتصفح كوكيز الطرف الثالث. أُضيف مسار بديل مقيّد: `AUTH_BEARER_FALLBACK` يُرجع رمز الجلسة في جسم الدخول ويُقبل في `Authorization: Bearer`، ويُتجاوز CSRF لهذا المسار وحده (الترويسة لا تُرسل تلقائياً). **مرفوض في الإنتاج** (يرفض الإقلاع) | مطبَّق | `config/env.ts`, `middleware/auth.ts`, `middleware/csrf.ts`, `auth/routes.ts`, `web/src/api/client.ts` | 261/261 + تحقّق حيّ: `GET /dashboard/summary` بترويسة فقط ⇒ 200، و`POST` بلا CSRF عبر Bearer ⇒ 200 |
| حادثة-٤ (تشخيص 401 في بيئة المعاينة) | ترويسة `Authorization` قد تُعترض لدى بعض الوكلاء، ولا سبيل لتخمين ما وصل. الحل: قناتان (`x-session-token` + `Authorization: Bearer`)، وإعادة محاولة واحدة عند 401 مع وجود رمز، وتسجيل **حضور** القنوات فقط (`authProbe`) مع كل 401 (بلا قيم) | مطبَّق | `sessionService.ts`, `middleware/auth.ts`, `app.ts`, `web/src/api/client.ts` | 261/261 + تحقّق: `/auth/session` و`/dashboard/summary` بترويسة `x-session-token` وحدها ⇒ 200، وبدونها ⇒ 401 مع `authProbe` |
| تسليم-V1/١ (شاشتا الفلاتر والتصنيفات) | تحرير قواعد المحرّك من الواجهة بلا سطر أوامر: محرّر شرط مشترك، اختبار فوري في الذاكرة، إيقاف/حذف، وعزل كامل بالمالك | مطبَّق | `web/src/components/RuleEditor.tsx`, `pages/TelegramFiltersPage.tsx`, `pages/TelegramClassificationsPage.tsx`, `api/client.ts` | `tsc` + بناء الواجهة + اختبار حيّ على الـAPI (إنشاء/تعديل/حذف) |
| تسليم-V1/٢ (CRUD للتصنيفات) | تعميم طبقة التخزين على النوعين (`kind`) بدل تكرار المنطق، مع مسارات إنشاء/تعديل/حذف للتصنيف وتدقيق لكل عملية | مطبَّق | `ruleConfigRepository.ts` (`createRuleSet/updateRuleSet/deleteRuleSet/getRuleSet`), `resultsRoutes.ts` | `rule-admin.test.ts` (7 اختبارات) |
| تسليم-V1/٣ (دمج التصنيفات) | دمج أربعة تصنيفات دراسية في «خدمات طلابية» لإنهاء الغموض: نقل الشروط باتحاد المصطلحات، تسطيح القواميس المتخصصة فقط (لا العامة)، نقل نتائج التصنيف وروابط القوالب، ثم الحذف — idempotent | مطبَّق | `db/migrations/0026_merge_student_classifications.sql`, `processing/seeds.ts` | تنفيذ فعلي: 10 تصنيفات ⇒ 7، ونقل صفّي تصنيف، والاختبارات 268/268 |
| تسليم-V1/٤ (رؤية سبب الوقف) | كانت `ambiguous` مُثبَّتة `false` في استجابة التفاصيل ⇒ وقف بلا تفسير. صُحّحت من القاعدة وأُضيفت `reviewHints` تُعرض في صفحة الرسالة | مطبَّق | `resultsService.ts`, `resultsRepository.ts`, `web/src/pages/TelegramResultDetailPage.tsx` | تحقّق حيّ: `ambiguous=true` + تلميح «أكثر من تصنيف طابق الرسالة» |
