# النشر في الإنتاج — دليل تنفيذي (Oracle Always Free · DuckDNS · Gmail)

> رفيق هذه الصفحة: `docs/hosting-plan.md` (لماذا هذه المنصات بالأرقام).
> كل الأوامر مكتوبة لتُنقل كما هي. المسار الكامل ≈ 25 دقيقة + وقت الإصدار الأول.

**ما ستحتاجه:** حساب Oracle Cloud (بطاقة للتحقق) · حساب DuckDNS (مجاني) · حساب Gmail ·
مفتاح SSH · حساب GitHub (المستودع موجود بالفعل).

---

## ٠) قبل أي شيء: ما لا يجب فعله

- ❌ لا ترفع `.env` إلى GitHub ولا ترسله في أي محادثة. الأسرار تُولَّد **على الخادم**.
- ❌ لا تفتح منفذ PostgreSQL أو 4000 للإنترنت. البوابة الوحيدة: 80/443.
- ❌ لا تشغّل `docker compose up` قبل تعديل قيم `CHANGE_ME` في `.env` (السكربت يمنعك).

---

## ١) إنشاء الآلة على Oracle Cloud (Always Free)

1. سجّل في **cloud.oracle.com** → Free Tier. اختر **Home Region** بعناية (لا تُغيَّر لاحقاً):
   الأقرب لليمن عملياً: **Jeddah/Riyadh** إن ظهرت، وإلا **Frankfurt** أو **Singapore**.
2. القائمة → **Compute → Instances → Create instance**:
   - **Image:** Canonical Ubuntu **24.04** (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` · **2 OCPU** · **12 GB** (الحصة المجانية الحالية بعد تخفيض يونيو 2026)
   - **Boot volume:** 100 GB (الحد الكلي 200 GB)
   - **SSH keys:** ارفع مفتاحك العام (`~/.ssh/id_ed25519.pub`)
   - **Assign public IPv4:** نعم
3. إن ظهرت **"Out of host capacity"**: أعد المحاولة في ساعة أخرى، أو جرّب AD آخر، أو 1 OCPU/6GB
   أولاً ثم كبّر لاحقاً. (شائع في المناطق المزدحمة، وليس خطأً منك.)
4. بعد الإنشاء: **Networking → VCN → Security Lists → Default Security List** أضف
   Ingress: `0.0.0.0/0` على **TCP 80** و**TCP 443** (وUDP 443 للـHTTP/3 إن أردت).
   > `ufw` داخل الآلة لا يكفي وحده: أوراكل تفلتر قبل الوصول إلى الآلة.
5. سجّل **Public IP** ثم:
   ```bash
   ssh -i ~/.ssh/id_ed25519 ubuntu@<PUBLIC_IP>
   ```

---

## ٢) نطاق مجاني على DuckDNS (نصف دقيقة)

1. سجّل الدخول إلى **duckdns.org** بحساب GitHub/Google.
2. أنشئ نطاقاً: `tgmon` ⇒ يصبح `tgmon.duckdns.org`. انسخ **token** من أعلى الصفحة.
3. وجّهه إلى IP الخادم:
   ```bash
   curl "https://www.duckdns.org/update?domains=tgmon&token=<TOKEN>&ip=<PUBLIC_IP>"
   # الرد المتوقع: OK
   ```
4. تحقّق: `dig +short tgmon.duckdns.org` ⇒ يجب أن يعطي IP خادمك.
   > DuckDNS مجاني ودائم، ويصلح تماماً لشهادة Let's Encrypt. لو كان لديك نطاقك الخاص لاحقاً،
   > يكفي تغيير `DOMAIN` في `.env` وإعادة النشر.

---

## ٣) التثبيت بأمر واحد

```bash
sudo apt-get update -qq && sudo apt-get install -y -qq git
git clone https://github.com/jamalMajdi/telegram-monitor.git ~/tg-src
sudo bash ~/tg-src/deploy/scripts/bootstrap.sh
```

يفعل: حزم النظام · `ufw` (80/443 فقط) · Docker + Compose · نسخة المستودع في
`/opt/tg-monitor/src` · **توليد أسرار** وكتابة `/opt/tg-monitor/.env` بصلاحية 600 ·
مؤقت النبضة اليومية ضد استعادة الموارد الخاملة.

ثم **عدّل ستّ قيم** فقط:

```bash
sudo nano /opt/tg-monitor/.env
```
| المتغيّر | القيمة |
|---|---|
| `DOMAIN` | `tgmon.duckdns.org` |
| `ACME_EMAIL` | بريدك (تنبيهات الشهادة) |
| `BOOTSTRAP_ADMIN_EMAIL` | بريدك — أول حساب يسجّل بهذه الصفحة يصبح **مديراً** |
| `TG_API_ID` + `TG_API_HASH` | من **my.telegram.org → API development tools** |
| `APP_PUBLIC_URL` | `https://tgmon.duckdns.org` |
| `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | انظر §٥ (Gmail) |

ثم:

```bash
sudo bash /opt/tg-monitor/src/deploy/scripts/deploy.sh build
```

المتوقّع في النهاية:
```
✅ https://tgmon.duckdns.org/healthz يعمل (TLS سليم)
```

---

## ٤) أول دخول وربط تيليجرام

1. افتح `https://<DOMAIN>` → **إنشاء حساب** بالبريد الذي وضعته في `BOOTSTRAP_ADMIN_EMAIL`.
   (أول حساب فقط يصبح مديراً — تأكد أنه حسابك.)
2. **الحساب → كلمة المرور** لتغييرها إن أردت.
3. **تيليجرام → الحسابات → ربط حساب**: أدخل الرقم بصيغة دولية، ثم الرمز من تطبيق تيليجرام.
   > الربط يجري **من عنوان الخادم** — وهذا مطلوب: الجلسة تُشفَّر وتُحفظ في القاعدة،
   > وعند إعادة التشغيل تُستعاد تلقائياً (`TG_RESTORE_ON_START=true`).
4. **النشر → ربط البوت**: رمز بوت من **@BotFather** (`/newbot`)، ثم أضِفه **مشرفاً**
   في قناة النشر مع حقّ النشر، ثم **إضافة وجهة** بإدخال `@username` القناة.
5. أنشئ مصدر مراقبة (`تيليجرام → المصادر`)، وفلتراً، وقالباً، ثم **مسار نشر**.
   من هنا كل شيء يعمل: التقاط ← مطابقة ← استخراج ← نشر.

---

## ٥) البريد عبر Gmail (App Password)

1. على حساب Gmail: **التحقق بخطوتين** مفعّل (إلزامي).
2. **myaccount.google.com/apppasswords** → أنشئ كلمة مرور تطبيق (16 حرفاً) → انسخها بلا مسافات.
3. في `.env`:
   ```ini
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=youraddress@gmail.com
   SMTP_PASS=abcdefghijklmnop        # كلمة مرور التطبيق
   SMTP_FROM=youraddress@gmail.com   # يجب أن يساوي SMTP_USER
   ```
4. أعد النشر: `sudo bash /opt/tg-monitor/src/deploy/scripts/deploy.sh build`
5. **التحقق العملي:** اخرج من الحساب → «نسيت كلمة المرور» → يجب أن تصل الرسالة خلال ثوانٍ.

**حدود Gmail:** ~500 مستلم/يوم، وGoogle يعيد كتابة `From` إلى حسابك المصادَق.
كافٍ تماماً لاستعادة كلمة المرور وبريد التنبيهات. إن تجاوزته لاحقاً: بدّل إلى Brevo/Resend
بتغيير ثلاثة أسطر في `.env` فقط (لا كود).

فحص سريع من الخادم:
```bash
docker compose -f /opt/tg-monitor/docker-compose.yml --env-file /opt/tg-monitor/.env logs --tail=20 api | grep -i "بريد"
```

---

## ٦) CI/CD من GitHub (اختياري لكن مُوصى)

**Settings → Secrets and variables → Actions:**

| النوع | الاسم | القيمة |
|---|---|---|
| Secret | `DEPLOY_HOST` | IP العام |
| Secret | `DEPLOY_USER` | `ubuntu` |
| Secret | `DEPLOY_SSH_KEY` | المفتاح **الخاص** (`cat ~/.ssh/id_ed25519`) |
| Secret | `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -H <IP>` |
| Variable | `DEPLOY_MODE` | `build` (بناء على الخادم) أو `image` (بناء على GitHub ← أسرع للخادم) |
| Variable | `PUBLIC_DOMAIN` | `tgmon.duckdns.org` |

- **`ci.yml`** يعمل تلقائياً على كل دفع: 601 اختباراً + `tsc` للطرفين + فحص واجهة + بناء صورة.
- **`deploy.yml`** يدوي (Actions → Deploy → Run workflow) أو على وسوم `v*`.
  في وضع `image` يدفع الصورة إلى GHCR، وعلى الخادم ضع توكن قراءة:
  ```bash
  printf '%s' '<PAT بصلاحية read:packages>' | sudo tee /opt/tg-monitor/ghcr-token >/dev/null
  sudo chmod 600 /opt/tg-monitor/ghcr-token
  ```

---

## ٧) المسار البديل: Northflank (إن تعذّر تسجيل Oracle)

النظام مصمّم لينتقل بتغيير متغيّرين — لأن الصورة واحدة والواجهة يخدمها الـAPI.

1. **Create Service → Combined service** من مستودع GitHub نفسه (يقرأ `Dockerfile` تلقائياً).
2. **Add addon → PostgreSQL** (الخطة المجانية). انسخ `DATABASE_URL` الذي يعطيه.
3. متغيّرات البيئة: نفس مفاتيح `.env` أعلاه، مع:
   ```ini
   NODE_ENV=production
   DATABASE_URL=<من الإضافة>
   WEB_DIST_DIR=/app/apps/web/dist
   APP_ORIGIN=https://<نطاق Northflank>     # وAPP_PUBLIC_URL مثله
   COOKIE_SECURE=auto
   SESSION_COOKIE_SAMESITE=lax
   DEV_EXPOSE_RESET_TOKEN=false
   AUTH_BEARER_FALLBACK=false
   ```
4. **Port:** داخلي `4000` من نوع HTTP. TLS والشهادة من Northflank (لا Caddy ولا Caddyfile).
5. الترحيلات: أضف **Job** لمرة واحدة: `node dist/db/migrate.js` (أو أمر في Start command:
   `node dist/db/migrate.js && node dist/index.js`).
6. النسخ الاحتياطي: فعّل النسخ التلقائي في الإضافة، أو جدولة Job يومي بـ`pg_dump`.

> ملاحظة صريحة: Northflank تصف خطتها المجانية بـ«للتطوير والاختبار». هي أنسب من Render
> (الذي ينام ويقتل MTProto)، لكن Oracle أدقّ للتشغيل الدائم. لو كبر الاستخدام:
> انتقال إلى VPS مدفوع ~€5 لا يغيّر سطراً في الكود (`DEPLOY_HOST` جديد فقط).

---

### ⚠️ مساران للفحص فقط — لا تخترع ثالثاً

| المسار | ماذا يعني |
|---|---|
| `/healthz` | حياة العملية (200 دائماً ما دام الخادم يستجيب) |
| `/readyz` | جهوزية حقيقية: القاعدة + عامل النشر + الطابور (JSON) |

أي مسار آخر غير موجود يُعيد **صفحة التطبيق برمز 200** (لأن الواجهة SPA). لذلك راقب
`/healthz` حصراً: مراقبة مسار مخترع ستبدو «خضراء» وهي لا تفحص شيئاً.

## ٨) التشغيل اليومي

```bash
cd /opt/tg-monitor

# الحالة والسجلّات
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs -f --tail=100 api

# تحديث إلى آخر نسخة
sudo bash src/deploy/scripts/deploy.sh build

# نسخة احتياطية فورية + قائمة النسخ
docker compose --env-file .env -f docker-compose.yml exec backup /usr/local/bin/backup.sh
ls -lh backups/ && cat backups/last-success.txt
```

**استعادة نسخة** — تحقّق من البصمة أولاً (نسخة تالفة لا تُاستعاد):
```bash
cd /opt/tg-monitor/backups && sha256sum -c tg-<STAMP>.dump.sha256
```
ثم:

```bash
docker compose --env-file .env -f docker-compose.yml stop api
docker compose --env-file .env -f docker-compose.yml exec -T postgres \
  sh -c 'dropdb -U "$POSTGRES_USER" --if-exists telegram_monitor && createdb -U "$POSTGRES_USER" telegram_monitor'
docker compose --env-file .env -f docker-compose.yml exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d telegram_monitor --no-owner < backups/tg-<STAMP>.dump
docker compose --env-file .env -f docker-compose.yml start api
```

**المراقبة الخارجية (مجانية):** ضع في UptimeRobot/BetterStack مراقبة HTTP على
`https://<DOMAIN>/healthz` كل 5 دقائق + تنبيه بريدي. هذا يكشف أيضًا استعادة الموارد الخاملة.

**مؤشرات أسبوعية:**
```bash
docker system df                          # مساحة الصور (نظّف بـdocker image prune -f)
df -h /                                   # القرص
docker compose --env-file .env -f docker-compose.yml exec -T postgres \
  psql -U tgmon -d telegram_monitor -c "select pg_size_pretty(pg_database_size(current_database()));"
```

---

## ٩) جدول الأعطال

| العَرَض | السبب المرجّح | الحل |
|---|---|---|
| `Out of host capacity` عند الإنشاء | منطقة مزدحمة | جرّب AD آخر أو 1 OCPU، أو أعد المحاولة لاحقاً |
| الشهادة لا تُصدر | DNS لا يشير للخادم، أو 80 محجوب | `dig +short <DOMAIN>` · افتح 80 في Security List · `logs caddy` |
| `502` من Caddy | الـAPI لم يقلع | `logs api` — ابحث عن خطأ `.env` أو `DATABASE_URL` |
| `password authentication failed` | `POSTGRES_PASSWORD` تغيّر بعد إنشاء الحجم | أعِد القيمة القديمة، أو احذف الحجم **بعد نسخة** |
| تيليجرام: `needs_reauth` | جلسة أُبطلت (تسجيل خروج من الجهاز/تغيير رمز) | أعد الربط من الواجهة (رقم + رمز) |
| بريد لا يصل | `SMTP_FROM` ≠ `SMTP_USER`، أو كلمة مرور عادية بدل App Password | صحّح القيمتين، ثم: `select status,last_error from notification_outbox` |
| `last_error=auth_failed` في الصندوق | بيانات Gmail خاطئة/منتهية | أنشئ App Password جديداً |
| الآلة «اختفت» فجأة | استعادة موارد خاملة (7 أيام تحت 20%) | المؤقت يمنعها؛ أعد الإنشاء من النسخة الاحتياطية إن حدثت |
| الوجهة تفشل 3 مرات | البوت طُرد أو سُحبت صلاحيته | لافتة تحذير في صفحة النشر + بريد `destination_failures` |
