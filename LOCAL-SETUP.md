# تشغيل المشروع محلياً (لتسجيل الدخول التفاعلي إلى تيليجرام)

هذه الحزمة **لا تحتوي** أي أسرار: لا ملف `.env`، ولا مفاتيح، ولا جلسات، ولا `node_modules`.

## المتطلبات
- Node.js **20 أو أحدث** وnpm 10+.
- اتصال إنترنت (لتثبيت الحزم، وللاتصال بخوادم تيليجرام أثناء تسجيل الدخول).
- لا حاجة إلى Docker ولا PostgreSQL مثبّت: المشروع يستخدم PostgreSQL مضمّناً للتطوير (`embedded-postgres`) على المنفذ 55432.

## 1) فك الضغط والتثبيت
```bash
unzip telegram-monitor-local.zip -d telegram-monitor
cd telegram-monitor
npm install        # يثبّت الحزم لكل الأعمال (workspaces) ويثبّت ثنائيات PostgreSQL المضمّنة
```

## 2) إنشاء ملف البيئة
```bash
cd apps/api
cp .env.example .env
```
ثم عدّل `apps/api/.env` وأكمل هذه القيم:
- `DATABASE_URL=postgres://postgres:devpassword@127.0.0.1:55432/telegram_monitor`
- `TG_API_ID` و`TG_API_HASH`: من <https://my.telegram.org> (تطبيقك).
- `TG_SESSION_ENC_KEY`: ولّده محلياً ولا تشاركه:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
- اترك `TG_SESSION_ENC_KEY_VERSION=1` و`TG_SESSION_ENC_KEY_PREVIOUS` فارغاً.
- تأكد أن `TG_TEST_SERVERS=false`.

## 3) تشغيل قاعدة البيانات والترحيلات
في طرفية أولى (تُترك مفتوحة):
```bash
cd telegram-monitor
npm run dev:db
```
في طرفية ثانية:
```bash
cd telegram-monitor
npm run migrate
```

## 4) فحص التهيئة (لا اتصال)
```bash
cd telegram-monitor/apps/api
npm run telegram:smoke
```
المتوقع: `بيانات التطبيق: مهيأة` و`مفتاح تشفير الجلسات: مهيأ`.

## 5) تسجيل الدخول التفاعلي
```bash
cd telegram-monitor/apps/api
npm run telegram:smoke -- --login --listen 30
```
سيطلب بالترتيب: رقم الهاتف بصيغة دولية، ثم رمز الدخول من تطبيق تيليجرام، ثم كلمة مرور التحقق بخطوتين إن وُجدت.
تعليمات أمان: المُدخلات تظهر على الشاشة أثناء كتابتها — لا تشارك الشاشة أو تسجّل الطرفية. الجلسة لا تُطبع ولا تُحفظ (سنبني حفظ الحساب في خطوة لاحقة)، ويمكنك إنهاء الجلسة من «الأجهزة النشطة» داخل تيليجرام.

## 5.5) ربط حساب من الواجهة
بعد `npm run dev:api` و`npm run dev:web`، افتح `http://localhost:5173` وسجّل الدخول، ثم «حسابات تيليجرام»:
أدخل الرقم بالصيغة الدولية → أدخل الرمز → أدخل كلمة التحقق بخطوتين إن طُلبت. الحالة المؤقتة في الخادم فقط،
ولا تُحفظ رموز أو جلسات في المتصفح.

## 5.6) إدارة المصادر من الواجهة
بعد ربط حساب (5.5) افتح «مصادر تيليجرام» (`/telegram/sources`):
- «عرض المحادثات» ثم «إضافة للمراقبة»، أو الإضافة بمعرّف مثل `@channel_name`.
- لكل مصدر: إيقاف/استئناف المراقبة، التحقق من الوصول، «تضمين رسائلي»، الحذف.
- الحد الأقصى 25 مصدراً لكل حساب (`TG_MAX_SOURCES_PER_ACCOUNT` في `apps/api/.env`).
- لا تُقرأ رسائل في هذه المرحلة: الصفحة تدير الحالة والإعدادات فقط.

## 5.7) حالة الالتقاط
بعد إضافة مصادر واتصال الحساب، افتح «حالة الالتقاط» (`/telegram/ingest`):
- إجمالي الرسائل المُلتقطة، والتحديثات غير المرتبطة بمصادر، وفشل حفظ الهوية، ومدة احتفاظ معرّفات منع التكرار.
- جدول لكل مصدر: مُلتقطة/مكررة/مستبعدة/آخر رسالة/حالة اتصال الحساب.
- لا تُعرض نصوص رسائل لأن النظام لا يخزّنها في هذه المرحلة.
- متغيرات الضبط في `apps/api/.env`: `TG_INGEST_ENABLED`, `TG_INGEST_IDENTITY_RETENTION_DAYS` (30),
  `TG_INGEST_MAX_ATTEMPTS`, `TG_INGEST_PURGE_INTERVAL_MINUTES`.

## 6) (اختياري) بقية المشروع
```bash
npm run dev:api     # خادم API على المنفذ 4000
npm run dev:web     # واجهة Vite
npm test            # 136 ناجحاً + 4 اختبارات حيّة متجاوزة
```

## ملاحظات
- ملف `.env` مُستثنى في `.gitignore`؛ لا ترفعه أو تشاركه.
- للتشغيل على Windows استخدم PowerShell؛ الأوامر نفسها، و`cp` تقابلها `Copy-Item`.
- إن ظهر `FLOOD_WAIT` في تسجيل الدخول فانتظر المدة المذكورة قبل إعادة المحاولة.
