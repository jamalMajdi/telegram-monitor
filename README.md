# TG Monitor — مراقبة رسائل تيليجرام وتصفيتها ونشرها

نظام متعدد المستخدمين يقرأ رسائل قنوات/مجموعات تيليجرام عبر MTProto، يطابقها على قواعد فلترة،
يستخرج منها بيانات منظّمة، ثم **ينشرها** في قنوات تيليجرام أخرى عبر Bot API — مع مراجعة بشرية،
وسجل كامل، وتنبيهات، وبريد صادر. كل شيء عربي/RTL من الواجهة إلى السجلات.

> **الحالة:** V1 مكتمل ومُختبَر (601 اختباراً ناجحاً، 0 فاشل). حزمة P0 من تدقيق ما قبل التسليم
> مُنفَّذة (تأكيدات الحذف، البريد الصادر، مستهلك صندوق الإرسال، تنبيه الفشل المتكرر).
> P1/P2 مؤجَّلة إلى V2 بقرار صاحب المنتج — التفاصيل في `docs/pre-handover-audit-2026-11.md`.

---

## البنية

```
apps/api    Node.js + TypeScript + Express + PostgreSQL 15
            MTProto عبر teleproto · Bot API للنشر · ترحيلات SQL · مستهلك صندوق بريد
apps/web    React + TypeScript + Tailwind (RTL) + Vite — الواجهة الكاملة
deploy      systemd · nginx · نسخ احتياطي/استعادة · توليد أسرار · healthcheck
docs        التشغيل والتصميم والتقارير (§ انظر «أين أقرأ»)
scripts     قاعدة تطوير مضمَّنة (embedded PostgreSQL)
```

نشر أحادي المنفذ: الـAPI يخدم الواجهة المبنية و`/api/v1` على منفذ واحد (انظر `docs/runbook.md` §15).

---

## التشغيل السريع (تطوير)

```bash
npm ci

# 1) قاعدة تطوير مضمَّنة على 55432 (بلا Docker)
npm run dev:db            # اتركه يعمل في نافذة

# 2) الإعدادات: انسخ القالب واملأ الأسرار
cp apps/api/.env.example apps/api/.env
#    المفاتيح: TG_SESSION_ENC_KEY و TG_BOT_ENC_KEY (32 بايت base64)
#    أو استخدم: deploy/scripts/generate-secrets.sh

# 3) الترحيلات + أول مدير
npm run migrate
npm run --workspace @tg/api create-admin

# 4) التشغيل
npm run dev:api           # http://localhost:4000  (/health /ready)
npm run dev:web           # http://localhost:5173
```

بيانات دخول العرض لا تُحفظ في المستودع: أنشئ المدير بأمر `create-admin` أو من
`BOOTSTRAP_ADMIN_EMAIL` في `.env` غير المتعقَّب.

---

## البريد الصادر (P0)

البريد **مُعطَّل افتراضياً وبأمان**: بلا `SMTP_HOST` تبقى الرسائل `pending` في
`notification_outbox` بلا فقدان ولا أعطال إقلاع. للتفعيل:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587              # 465 ⇒ SMTP_SECURE=true
SMTP_SECURE=false          # STARTTLS
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=no-reply@example.com
APP_PUBLIC_URL=https://app.example.com   # أصل روابط استعادة كلمة المرور
OUTBOX_INTERVAL_SECONDS=30
```

قواعد صريحة في الكود: المصادقة لا تُرسل على قناة غير مشفّرة أبداً (`tls_unavailable`)،
ولا يوجد خيار لتعطيل التحقق من الشهادة (`SMTP_CA_PATH` لشهادة داخلية).
كل رسالة تُبنى من **قالب مغلق** (`auth.password_reset` · `alerts.raised` · `alerts.cleared`):
لا نص حر، ولا محتوى رسائل، ولا أرقام تواصل، ولا رموز في السجلات.

---

## بوابات الجودة

```bash
npm test                  # 65 ملفاً · 601 ناجح · 0 فاشل · 4 متجاوز
npm run --workspace @tg/api typecheck
npm run --workspace @tg/web typecheck
npm run smoke:web         # 24/24 فحص واجهة (بلا متصفح)
npm run build             # بناء API + الواجهة
```

اختبارات قاعدة البيانات تُشغَّل **ملفاً لكل عملية** (عزل نسخ PostgreSQL المضمَّنة)،
واختبار SMTP يعمل ضد **خادم SMTP حقيقي** على `127.0.0.1` بشهادة TLS مُولَّدة للاختبار —
لا محاكاة لدالة الإرسال.

---

## الأمان

- الأسرار في `.env` **غير المتعقَّب** فقط؛ `.gitignore` يستثني `.env` و`.env.*` عدا القوالب.
- لا أسرار في السجلات (`pino` يحجب `password` و`token` و`csrfToken` وترويسات الكوكيز).
- رموز البوتات وجلسات MTProto **مشفَّرة** (AES-256-GCM) بمفاتيح مستقلة قابلة للتدوير.
- CSRF + جلسات بصلاحية مطلقة + تحديد معدل + سجل تدقيق لكل إجراء إداري.
- **لا ترفع `.env` ولا أي مفاتيح.** إن تسرّب مفتاح: دوّره فوراً (`docs/runbook.md` §8).

إن وجدت ثغرة: لا تفتح Issue عاماً — أبلغ مالك المستودع مباشرة.

---

## أين أقرأ

| الملف | لماذا |
|---|---|
| `docs/HANDOVER.md` | **ابدأ هنا للتسليم:** ما في الحزمة، بوابات الجودة، حدود V1، قائمة أمان فورية |
| `docs/runbook.md` | التشغيل اليومي: نشر، ترقية، نسخ/استعادة، أعطال، بريد، تنبيهات (§19) |
| `docs/ops-summary.md` | شرح بلا أكواد: الرحلة من رسالة إلى منشور |
| `docs/p0-implementation-report-2026-11.md` | حزمة P0 بالأدلة + ستة أعطال إنتاجية اكتشفتها الاختبارات |
| `docs/pre-handover-audit-2026-11.md` | التدقيق: 19 ملاحظة مصنّفة P0/P1/P2 |
| `docs/engine-explained.md` | المحرّك: الفلترة، الاستخراج، القوالب، التقسيم |
| `docs/database.md` | الجداول والعلاقات والقيود |
| `docs/security.md` | نموذج التهديد والضوابط |
| `docs/decisions-traceability.md` | كل قرار (D/O/Q) وأين نُفِّذ في الكود |

---

## الرخصة والاستخدام

مشروع خاص بمالكه؛ لا رخصة مفتوحة ممنوحة افتراضياً. الاستخدام أو النشر يحتاج إذن المالك.
