# دليل التشغيل — TG Monitor (P4‑ز)

> هذا الدليل موجَّه لمن ينشر النظام ويصونه على خادم Linux. كل خطوة مكتوبة لتنفّذها حرفياً؛
> وحيث يوجد خطر مكتوب صراحةً **⚠️ الخطر**.
> المرجع المرافق: `docs/production-readiness.md` (الأمان والحدود وأهداف الأداء) و`deploy/README.md` (خريطة الملفات).

**فهرس:** [1 المتطلبات](#1-المتطلبات) · [2 التحضير](#2-تحضير-الخادم) · [3 القاعدة](#3-قاعدة-البيانات) · [4 TLS](#4-tls-و-nginx) · [5 النشر](#5-النشر-الأول) · [6 النسخ الاحتياطي](#6-النسخ-الاحتياطي-والاستعادة) · [7 المفاتيح](#7-المفاتيح-والأسرار) · [8 الترقية](#8-الترقية-والتدوير) · [9 المراقبة](#9-المراقبة-اليومية) · [10 الأعطال](#10-جدول-الأعطال-والحلول) · [11 الحوادث](#11-خطة-الاستجابة-للحوادث) · [12 الكوارث](#12-استعادة-الكارثة)

---

## 1) المتطلبات

| المكوّن | الإصدار الأدنى | ملاحظات |
| --- | --- | --- |
| Linux | Ubuntu 22.04/Debian 12 أو ما يعادلهما | أي توزيعة بها systemd |
| Node.js | **20.11+** (LTS) | `node -v` |
| PostgreSQL | **16+** (مُختبَر على 17) | نفس الخادم أو مُدار |
| nginx | 1.24+ | TLS + وكيل عكسي + خدمة ملفات الواجهة |
| أدوات | `pg_dump`, `pg_restore`, `psql`, `openssl`, `curl`, `python3` | `postgresql-client` يوفر الأولى |
| موارد | 1 vCPU · 1 GB RAM · 10 GB قرص | كافية لبداية؛ راقب الذاكرة والقرص |

**منافذ مفتوحة للعالم: 80 و443 فقط.** المنفذ 4000 يبقى على `127.0.0.1`.

---

## 2) تحضير الخادم

```bash
# مستخدم الخدمة (بلا صدفة تفاعلية، بلا امتيازات)
sudo useradd --system --create-home --home-dir /opt/tg-monitor --shell /usr/sbin/nologin tgmon

# مجلدات التشغيل
sudo mkdir -p /etc/tg-monitor /var/backups/tg-monitor /var/log/tg-monitor
sudo chown root:tgmon /etc/tg-monitor && sudo chmod 750 /etc/tg-monitor
sudo chown tgmon:tgmon /var/backups/tg-monitor /var/log/tg-monitor
sudo chmod 700 /var/backups/tg-monitor

# الحزم
sudo apt update
sudo apt install -y postgresql-client nginx curl openssl python3
# Node 20 LTS من nodesource أو الحزمة الرسمية — تحقّق: node -v ≥ 20.11
```

**جدار الحماية:**

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80,443/tcp
sudo ufw enable
sudo ss -lntp | grep -E ':(4000|5432)'   # يجب ألّا يظهر شيء على 0.0.0.0
```

---

## 3) قاعدة البيانات

**⚠️ لا تستخدم دور superuser للتطبيق.** أنشئ دوراً مخصّصاً يملك قاعدته فقط:

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE tgmon LOGIN PASSWORD 'استبدلها-بكلمة-قوية-من-generate-secrets';
CREATE DATABASE tg_monitor OWNER tgmon ENCODING 'UTF8';
REVOKE ALL ON DATABASE tg_monitor FROM PUBLIC;
SQL
```

تأكد أن الاتصال المحلي يعمل بكلمة مرور (`scram-sha-256`) في `pg_hba.conf`، ثم:

```bash
psql "postgres://tgmon:...@127.0.0.1:5432/tg_monitor" -c 'select version()'
```

**إعدادات PostgreSQL الموصى بها** (في `postgresql.conf`، ثم `systemctl restart postgresql`):

| الإعداد | القيمة | السبب |
| --- | --- | --- |
| `max_connections` | 100 | حمولة V1 + هامش |
| `shared_buffers` | 25% من الذاكرة | افتراضي معقول |
| `work_mem` | 8MB | استعلامات القوائم واللوحة |
| `checkpoint_timeout` | 15min | يقلّل I/O |
| `log_min_duration_statement` | 2000 | يظهر الاستعلامات البطيئة في السجل |

الأرشيف (WAL) **ليس مطلوباً** لأن النسخ اليومي كافٍ لـV1؛ إن أردت RPO دقائق ففعّل `archive_mode` و`pgBackRest` (خارج نطاق هذه الدفعة).

---

## 4) TLS و nginx

```bash
# شهادة Let's Encrypt (DNS للاسم يجب أن يشير إلى الخادم مسبقاً)
sudo apt install -y certbot
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d monitor.example.com \
     --agree-tos -m ops@example.com --no-eff-email

# ملفات nginx من المستودع
sudo cp deploy/nginx/tg-monitor.conf /etc/nginx/sites-available/tg-monitor.conf
sudo cp deploy/nginx/snippets/tg-proxy.conf /etc/nginx/snippets/tg-proxy.conf
sudo sed -i 's/monitor\.example\.com/اسمك.الحقيقي/g' /etc/nginx/sites-available/tg-monitor.conf
sudo ln -sf /etc/nginx/sites-available/tg-monitor.conf /etc/nginx/sites-enabled/tg-monitor.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

**تجديد الشهادة** يعمل تلقائياً بمؤقت certbot. تحقّق: `systemctl list-timers | grep certbot`.

> ملف nginx في المستودع **مُتحقَّق منه** بـ`nginx -t` (P4‑ز)، ويشمل: HSTS، CSP، منع التأطير،
> تحديد معدل مزدوج (طبقة nginx + طبقة التطبيق)، وحدّ جسم 256KB.

---

## 5) النشر الأول

```bash
# (1) الكود
sudo mkdir -p /opt/tg-monitor && sudo chown tgmon:tgmon /opt/tg-monitor
sudo -u tgmon git clone <repo> /opt/tg-monitor   # أو فكّ أرشيف الإصدار
cd /opt/tg-monitor
sudo -u tgmon npm ci
sudo -u tgmon npm run build           # يبني API (مع نسخ الترحيلات) والواجهة
```

**⚠️ البناء ينسخ ملفات `.sql` إلى `dist`** عبر `apps/api/scripts/copy-assets.mjs`. لا تحذف هذه الخطوة:
بلا نسخها يفشل `node dist/db/migrate.js` في الإنتاج (خلل اكتُشف وأُصلح في P4‑ز).

```bash
# (2) الأسرار
sudo -u tgmon deploy/scripts/generate-secrets.sh    # انسخ المخرجات إلى FILE أدناه بيدك
sudo install -o root -g tgmon -m 640 deploy/env/api.env.example /etc/tg-monitor/api.env
sudo -e /etc/tg-monitor/api.env     # املأ: DATABASE_URL، APP_ORIGIN، المفتاحان، TG_API_ID/HASH
```

**قائمة تحقّق قبل المتابعة (كلها إلزامية):**

- [ ] `NODE_ENV=production` و`DEV_EXPOSE_RESET_TOKEN=false` (التحقق يرفض التشغيل بغيرهما)
- [ ] `APP_ORIGIN=https://<اسمك>` بلا شرطة نهائية، و`COOKIE_SECURE=true`
- [ ] `DATABASE_URL` بدور `tgmon` لا `postgres`
- [ ] `TG_SESSION_ENC_KEY` و`TG_BOT_ENC_KEY` مضبوطان ومختلفان (32 بايت base64 لكل منهما)
- [ ] `LOG_FILE=` فارغ (journald)
- [ ] `psql "$DATABASE_URL" -c 'select 1'` ينجح

```bash
# (3) الوحدات
sudo cp deploy/systemd/tg-migrate.service deploy/systemd/tg-api.service \
        deploy/systemd/tg-backup.service deploy/systemd/tg-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-migrate.service     # يطبّق 25 ترحيلاً
sudo systemctl enable --now tg-api.service
sudo systemctl enable --now tg-backup.timer

# (4) الفحص
curl -fsS http://127.0.0.1:4000/healthz
curl -fsS http://127.0.0.1:4000/readyz
BASE_URL=https://monitor.example.com deploy/scripts/healthcheck.sh ; echo "exit=$?"
journalctl -u tg-api -n 30 --no-pager
```

**إنشاء أول مدير:** ضع بريدك في `BOOTSTRAP_ADMIN_EMAIL`، سجّل حساباً بهذا البريد عبر الواجهة،
ثم **أفرغ المتغيّر** وأعد التشغيل (`systemctl restart tg-api`).

**التسجيل العام:** للتشغيل المغلق عطّل التسجيل من إعدادات النظام (مدير) بعد إنشاء الحسابات.

---

## 6) النسخ الاحتياطي والاستعادة

### النسخ (تلقائي يومياً 03:17، ويدوياً عند الحاجة)

```bash
sudo systemctl start tg-backup            # نسخة فورية
sudo ls -lh /var/backups/tg-monitor       # ملفات .dump + .sha256
sudo journalctl -u tg-backup -n 20 --no-pager
```

السكربت يحتفظ بآخر **14** نسخة (`BACKUP_KEEP`)، يفحص كل نسخة بـ`pg_restore --list` فور إنشائها،
ويكتب بصمة SHA‑256 بجانبها.

**⚠️ الخطر الأكبر: نسخ على نفس القرص = لا حماية من تلف القرص.** انسخ المجلد خارج الخادم:

```bash
# مثال rsync إلى مضيف آخر (أو rclone إلى تخزين كائنات)
rsync -a --delete /var/backups/tg-monitor/ backup-host:/srv/tg-monitor-backups/
```

### تمرين الاستعادة (نفّذه **قبل** الإطلاق، وكل ثلاثة أشهر)

```bash
# (1) فحص الملف بلا أي كتابة
sudo -u tgmon deploy/scripts/restore.sh --verify /var/backups/tg-monitor/tg-monitor-*.dump

# (2) استعادة إلى قاعدة منفصلة للمقارنة (لا تلمس الإنتاج)
sudo -u tgmon deploy/scripts/restore.sh \
     --file /var/backups/tg-monitor/<أحدث>.dump \
     --target-db tg_restore_drill --create

# (3) قارن الأرقام
psql "$DATABASE_URL" -At -c "select count(*) from schema_migrations, users" > /tmp/a
psql "postgres://.../tg_restore_drill" -At -c "select count(*) from schema_migrations, users" > /tmp/b
diff /tmp/a /tmp/b && echo "متطابق"

# (4) نظّف
psql "postgres://.../postgres" -c 'drop database tg_restore_drill'
```

**الاستعادة الكاملة (كارثة):** أوقف الخدمة أولاً، ثم استعد **في القاعدة الحيّة**:

```bash
sudo systemctl stop tg-api
sudo -u tgmon deploy/scripts/restore.sh --file <dump> --in-place --force   # يطلب كتابة RESTORE
sudo systemctl start tg-migrate   # يطبّق أي ترحيل أحدث من النسخة
sudo systemctl start tg-api
deploy/scripts/healthcheck.sh
```

**RPO المستهدف:** ≤ 24 ساعة (نسخة يومية). **RTO المستهدف:** ≤ 30 دقيقة لاستعادة كاملة على خادم جاهز.

---

## 7) المفاتيح والأسرار

| السرّ | الوظيفة | لو فُقد | لو تسرّب |
| --- | --- | --- | --- |
| `TG_SESSION_ENC_KEY` | تشفير جلسات MTProto (AES‑256‑GCM) | **كل** الحسابات تحتاج إعادة ربط | جلسات مسروقة = وصول كامل لحسابات تيليجرام المستخدمين → **دوِّر فوراً وأبطل الجلسات** |
| `TG_BOT_ENC_KEY` | تشفير رموز بوتات النشر | كل بوتات النشر تحتاج إعادة إدخال الرمز | إمكانية نشر باسم بوتات المستخدمين → **دوِّر فوراً** |
| كلمة مرور القاعدة | اتصال التطبيق | إعادة تعيين (`ALTER ROLE`) | وصول لكل البيانات → دوِّر وحدّث `DATABASE_URL` |
| مفاتيح TLS | HTTPS | تجديد عبر certbot | انتحال هوية الموقع |

**قواعد ثابتة:** لا تُخزَّن الأسرار في Git ولا في مجلد النسخ الاحتياطي نفسه؛ احتفظ بها في مدير أسرار
أو نسخة ورقية/مشفّرة منفصلة. الملف `/etc/tg-monitor/api.env` بصلاحية `640 root:tgmon` فقط.

**نسخة احتياطية للمفاتيح:** بلا `TG_SESSION_ENC_KEY` لا يمكن فك الجلسات المحفوظة حتى مع نسخة قاعدة سليمة —
النسخة الاحتياطية للقاعدة **بدون** المفاتيح ناقصة.

---

## 8) الترقية وتدوير المفاتيح

### ترقية إصدار

```bash
cd /opt/tg-monitor
sudo systemctl start tg-backup                 # نسخة قبل كل ترقية (بلا استثناء)
sudo -u tgmon git fetch --tags && sudo -u tgmon git checkout <tag>
sudo -u tgmon npm ci && sudo -u tgmon npm run build
sudo systemctl restart tg-migrate              # ترحيلات أمامية فقط
sudo systemctl restart tg-api
deploy/scripts/healthcheck.sh && journalctl -u tg-api -n 50 --no-pager
```

**التراجع (rollback):** الكود يمكن التراجع عنه بـ`git checkout <tag-قديم>` وإعادة البناء. **الترحيلات لا تُتراجع**
(forward-only). إن كان الترحيل الجديد قد غيّر بنية لا يفهمها الإصدار القديم، فالحل استعادة النسخة السابقة للقاعدة.

### تدوير مفتاح التشفير (بلا فقدان بيانات)

```bash
# 1) الجديد يُضاف كـ«سلف» للفك فقط
TG_SESSION_ENC_KEY_PREVIOUS=<المفتاح-القديم>      # ثم ضع المفتاح الجديد في TG_SESSION_ENC_KEY
TG_SESSION_ENC_KEY_VERSION=2                       # رقم أعلى
sudo systemctl restart tg-api

# 2) أعِد حفظ الأسرار المُشفَّرة لتنتقل إلى المفتاح الجديد:
#    - جلسات MTProto: يعيد الحساب الربط أو يُعاد التشفير عبر السكربت التشغيلي المعتمد
#    - رموز البوتات: أعد إدخال رمز كل بوت من الواجهة (تُشفَّر بالمفتاح الجديد)
# 3) بعد التحقق من عمل كل الحسابات/البوتات: احذف *_PREVIOUS وأعد التشغيل.
```

**⚠️ لا تحذف `*_PREVIOUS` قبل التأكد** أن كل صف أُعيد تشفيره، وإلا صارت البيانات غير قابلة للفك.

---

## 9) المراقبة اليومية

| ما تراقبه | كيف | الدورية |
| --- | --- | --- |
| حياة الخدمة | `systemctl status tg-api` + `healthcheck.sh` | كل 5 دقائق (cron/مراقبة خارجية) |
| جهوزية العامل | `/readyz` → `publishWorker.state` | كل 5 دقائق |
| ضغط القرص/الذاكرة | `df -h /var`, `systemctl show tg-api -p MemoryCurrent` | يومياً |
| النسخ الاحتياطي | `systemctl list-timers tg-backup.timer` + وجود نسخة اليوم | يومياً |
| صندوق التنبيهات | الواجهة → «التنبيهات» (شارة حمراء = حرج) | عند كل دخول |
| أخطاء الخادم | `journalctl -u tg-api -p err --since -24h` | يومياً |
| احتفاظ البيانات | `retention_runs` في لوحة المدير | أسبوعياً |

**cron مقترح للمراقبة الخارجية:**

```cron
*/5 * * * * root BASE_URL=https://monitor.example.com /opt/tg-monitor/deploy/scripts/healthcheck.sh || logger -t tg-health "فشل فحص الصحة: $?"
```

**`healthcheck.sh`** يُرجع: `0` سليم · `1` الخدمة لا تستجيب · `2` قاعدة البيانات غير جاهزة · `3` عامل النشر متوقف.

---

## 10) جدول الأعطال والحلول

| العَرَض | السبب المرجّح | الفحص | الحل |
| --- | --- | --- | --- |
| `502 Bad Gateway` | الخدمة متوقفة/انهارت | `systemctl status tg-api`، `journalctl -u tg-api -n 100` | أصلح السبب ثم `systemctl restart tg-api` |
| `503` من `/healthz` | القاعدة غير متصلة | `psql "$DATABASE_URL" -c 'select 1'` | أعد تشغيل PostgreSQL، تحقّق من `pg_hba` والقرص |
| الدخول يفشل بلا سبب | `APP_ORIGIN` أو `COOKIE_SECURE` خطأ | سجل الخدمة عند `POST /auth/login` | صحّح القيمتين وأعد التشغيل |
| `CSRF` مرفوض دائماً | الوصول بـhttp أو أصل مختلف | ترويسة `Origin` في المتصفح | استخدم https والاسم الصحيح |
| تنبيه «عامل النشر متوقف» | العامل معطّل أو متجمد | `/readyz`، `TG_PUBLISH_WORKER_ENABLED` | فعّله؛ إن تجمّد فالدورة تُستأنف تلقائياً بعد `TG_PUBLISH_LEASE_SECONDS` |
| تسليمات `uncertain` تتراكم | أخطاء شبكة/5xx من تيليجرام | لوحة النشر → التسليم | **لا إعادة تلقائية**: سجّل دليلاً (رأيت الرسالة أم لا) ثم أعد النشر إن لزم (٣ كحد أقصى) |
| «حساب يحتاج إعادة دخول» | جلسة MTProto أُبطلت من تيليجرام | صفحة حسابات تيليجرام | أعد الربط بالرمز |
| لا رسائل جديدة | المصادر موقوفة/خامل | صفحة حالة الالتقاط | تحقّق من حالة الحساب والمصدر ثم أعد التوصيل |
| «الرسائل تصل لكن لا تُنشر» | لا مسار/وجهة فعّالة أو المراجعة معلّقة | لوحة النشر + التنبيهات | فعّل المسار أو اعتمد التسليم |
| نمو القرص | احتفاظ طويل + سجلات | `du -sh /var/lib/postgresql`, `journalctl --disk-usage` | راجع `user_settings` ومدد الاحتفاظ؛ `journalctl --vacuum-time=30d` |
| فشل `tg-migrate` | قاعدة غير متاحة أو ترحيل خاطئ | `journalctl -u tg-migrate -n 50` | أصلح القاعدة؛ الترحيلات أمامية — لا تُعدَّل، يُضاف ترحيل جديد |

---

## 11) خطة الاستجابة للحوادث

| الحادث | الفعل الفوري | بعده |
| --- | --- | --- |
| تسريب مفتاح تشفير | تدوير المفتاح (§8) + `UPDATE` لإبطال الجلسات إن لزم + تعطيل الحسابات المتأثرة | مراجعة `audit_events`، إبلاغ المستخدمين |
| تسريب كلمة مرور مدير | تعطيل الحساب، إبطال جلساته (`sessions`)، إعادة تعيين، مراجعة التدقيق | مراجعة صلاحيات المديرين |
| قاعدة بيانات تالفة | `systemctl stop tg-api`، استعادة من آخر نسخة سليمة، `tg-migrate`، تشغيل، فحص | مقارنة أعداد ما بعد النسخة (قد تُفقد رسائل الساعات الأخيرة — مقبول بـRPO 24h) |
| إرسال مزدوج للرسائل | أوقف العامل: `TG_PUBLISH_WORKER_ENABLED=false` + restart | راجع `delivery_parts`/`delivery_attempts` لمعرفة الأجزاء المرسلة |
| إساءة استخدام (غزو) | حجب IP في nginx/firewall، تقليل حدود المعدل | مراجعة `login_attempts`, `error_events` |
| جهاز الخادم مفقود | استعادة على خادم جديد: تثبيت → نسخة → مفاتيح → تشغيل | تحقّق من `tg_account_sessions` واستعادة اتصالات تيليجرام |

---

## 12) استعادة الكارثة — تسلسل كامل

1. خادم جديد + حزم (§2) + PostgreSQL (§3).
2. استعادة الكود من الإصدار المعلَّم، `npm ci`, `npm run build` (§5).
3. استعادة `/etc/tg-monitor/api.env` **مع المفتاحين** (بدونهما لا تُفكّ الجلسات).
4. استعادة أحدث نسخة: `restore.sh --file <dump> --target-db tg_monitor --create` (أو `--in-place` لو القاعدة موجودة).
5. `tg-migrate` ثم `tg-api` ثم `tg-backup.timer`، وnginx + TLS (§4).
6. الفحص: `/healthz`, `/readyz`, دخول مدير، ظهور النتائج، إرسال تجريبي إلى وجهة اختبار.
7. تحقّق من استعادة اتصالات تيليجرام (قد تحتاج إعادة ربط إن أُبطلت الجلسات).
8. سجّل الحادث: الوقت، آخر نسخة، ما فُقد، الإجراءات.

---

## ملحق: مواقع مهمة

| المسار | المحتوى |
| --- | --- |
| `/opt/tg-monitor` | الكود والبناء (`apps/api/dist`, `apps/web/dist`) |
| `/etc/tg-monitor/api.env` | كل متغيّرات البيئة (640 root:tgmon) |
| `/var/backups/tg-monitor` | النسخ `*.dump` + بصماتها (700 tgmon) |
| `/var/log/tg-monitor` | مساحة سجلات اختيارية (الافتراضي journald) |
| `journalctl -u tg-api` | سجلات الخدمة المهيكلة (JSON) |
| `journalctl -u tg-migrate` / `-u tg-backup` | سجلات الترحيل والنسخ |
| `docs/production-readiness.md` | الأمان والحدود وأهداف الأداء |


---

## 13) إدارة الفلاتر والتصنيفات من الواجهة (بعد V1)

منذ هذه النسخة تُدار قواعد المحرّك من الواجهة بلا سطر أوامر ولا SQL:

| الشاشة | المسار | ما تفعله |
| --- | --- | --- |
| **الفلاتر** | `/telegram/filters` | إنشاء/تعديل/إيقاف/حذف فلتر: كلمات، نمط مطابقة (`word/phrase/contains`)، شرط منفيّ، قاموس، أولوية، نطاق (كل المصادر أو المربوطة)، **واختبار فوري بلا حفظ** |
| **التصنيفات** | `/telegram/classifications` | نفس المحرّر لكن على قواعد التصنيف: النوع الذي يحدّد القالب وهل تُوقف الرسالة للمراجعة |

**قواعد سلوكية تذكّر بها أثناء التعديل:**
1. القاعدة تُطابق فقط إذا تحقّقت **كل** شروطها؛ والشرط «أي» يكفيه مصطلح واحد.
2. تطابق **تصنيفين** مع رسالة واحدة ⇒ غموض ⇒ وقف للمراجعة. الحل: تضييق الشروط أو دمج المتشابه.
3. الاختبار داخل الشاشة يجري **في الذاكرة**: لا يحفظ ولا يكتب أي صف.
4. كل تعديل يرفع `processing_version` فتُبنى لقطة جديدة تلقائياً — لا إعادة تشغيل لازمة.

**دمج تصنيفات الطلبات الدراسية (الترحيل 0026):** دُمجت «طلبات المساعدة الدراسية» و«واجبات واختبارات»
و«مشاريع جامعية» و«خدمات» في تصنيف واحد **«خدمات طلابية»** بأولوية 20، ونُقلت إليه نتائج التصنيف
وروابط القوالب ثم حُذفت القديمة. الترحيل idempotent ويعمل تلقائياً عند `npm run migrate`.

> ⚠️ **الخطر:** حذف تصنيف مستخدم في رسائل سبق تصنيفها يُبقي `message_classification` بمعرّف غير موجود؛
> لذلك يُنصح بالدمج (تعديل التصنيف القائم) بدل الحذف إذا كان قد استُخدم فعلاً.

**أداة سطر الأوامر (اختيارية للمشغّل):** `node apps/api/scripts/tg-cli.mjs` — نفس الـAPI، مفيدة في
الاستيراد الجماعي أو عند تعذّر الوصول للواجهة. لا تُستخدم لتجاوز الواجهة في العمليات اليومية.

### 13.5 فحص سريع بعد أي تحديث للواجهة

```bash
npm run smoke:web    # 16 فحصاً بلا متصفح — يجب أن ينتهي بـ«كل فحوص الصفحات ناجحة»
```

فشل هذا الفحص يعني أن شاشةً تفترض حقلاً لا يرسله الـAPI ⇒ شاشة خطأ في المتصفح.
التفصيل: `docs/fix-E-MWWD4Z41.md`.

---

## 14) البذور والمعجم: كيف تُحدَّث وكيف تُتحقَّق

### 14.1 القاعدة
- البذور تُطبَّق تلقائياً عند أول استخدام لكل مستخدم (قواميس، فلاتر، تصنيفات، قوالب، روابط).
- `user_config_state.seed_version` يخزّن **بصمة محتوى** البذور (لا رقماً ترتيبياً).
  أي تعديل في `seeds.ts` يغيّر البصمة ⇒ عند أول طلب للمستخدم تُضاف **الناقصات فقط**.
- التعديلات التي تجريها من الواجهة محفوظة: الترقية لا تحذف شرطاً ولا تستبدل قاعدة عدّلتها
  (`rule_sets.version > 1` ⇒ مستثناة). الاستثناء الوحيد: `SEED_TERM_REMOVALS` (تصحيحات معجمية بمطابقة تامة).

### 14.2 التحقّق بعد أي تحديث
```bash
npm run migrate                       # يضمن تطبيق 0027 وما بعده
psql "$DATABASE_URL" -c "select d.name, count(t.id) from dictionaries d \
  join dictionary_terms t on t.dictionary_id = d.id group by d.name order by 2 desc;"
```
المتوقّع: 8 قواميس، وإجمالي يتجاوز 1000 مصطلح (منها «مصطلحات دراسية» > 150).

اختبار قاعدة سريع (بلا حفظ):
```bash
curl -s -X POST "$APP_URL/api/v1/telegram/classifications/<ID>/test" \
  -H "content-type: application/json" --cookie "<session>" -H "x-csrf-token: <token>" \
  -d '{"text":"احد يقدر يسوي بحوث ومشاريع"}'
```
المتوقّع: مطابقة «خدمات طلابية» وحدها (بلا غموض). ونفس الشيء للفلاتر عبر `/telegram/filters/<ID>/test`.

### 14.3 سلوك النشر عند فشل الاستخراج (مهم تشغيلياً)
- لا يُنشر قالب فارغ أبداً: العنوان والفاصل ليسا محتوى (`publisher.buildLines` يرفض ذلك).
- إن لم يُنتج القالب أي حقل ⇒ يُنشر **النص الأصلي** في حقل «التفاصيل» (أو أول حقل حرّ)،
  ويُسجَّل `template_produced_no_fields` في السجل.
- إن غاب النص الأصلي أيضاً (انتهاء احتفاظ/وسائط بلا نص) ⇒ التسليم يُغلق `blocked` بسبب `empty` بلا إرسال.
- لمراقبة المنشورات المبنية على النص الأصلي: `PlanningResult.source = 'raw_text'` (يُسجَّل مع التخطيط).

### 14.4 فحص آلي سريع بعد أي تعديل على القوالب/النشر
```bash
npm --workspace @tg/api test -- 2>/dev/null || npx tsx --test apps/api/test/publish-empty-guard.test.ts
```

---

## 15) نشر أحادي المنفذ (الواجهة + الـAPI على 4000)

الخدمة تفحص تلقائياً وجود بناء الواجهة (`apps/web/dist`) وتخدمه من **نفس المنفذ**:
- `GET /` وأي مسار واجهة (`/telegram/filters`, `/telegram/results` …) ⇒ `index.html` (SPA).
- `/assets/*` تُخدم كملفات ثابتة.
- المسارات المحجوزة لا تُظلّل: `/api/*` و`/healthz` و`/readyz` تمرّ إلى الـAPI، ومسار بامتداد ملف
  غير موجود يعيد **404** حقيقياً لا صفحة التطبيق.

الفائدة: أصل واحد ⇒ لا CORS ولا رحلة CSRF بين أصلين، ومعاينة/نشر بعملية واحدة.

```bash
npm run build                       # يبني الـAPI والواجهة (apps/web/dist)
npm run dev:api                     # يخدم الاثنين على http://localhost:4000
```

- لتغيير المجلد: `WEB_DIST_DIR=/path/to/dist`. لفصل الواجهة على منفذ آخر: أفرغه واحذف/انقل `apps/web/dist`.
- تحقّق سريع: `curl -I http://localhost:4000/` ⇒ 200 و`content-type: text/html`.
- إن كانت `COOKIE_SECURE=true` (الافتراضي في الإنتاج) فالجلسة تعمل على **https** فقط؛ عبر http لن يُرسل
  المتصفح ملف تعريف الجلسة (سلوك مقصود لحماية الجلسة).

---

## 16) هوية المصدر والمرسل (توقيع المنشور)

**الترحيل:** `apps/api/src/db/migrations/0028_source_attribution.sql`
(أعمدة على `message_identity` و`user_settings` و`publish_routes`). التطبيق:

```bash
cd apps/api && npx tsx src/db/migrate.ts
```

### 16.1 أين تُدار

| المكان | التحكّم | الـAPI |
|---|---|---|
| الإعدادات (واجهة) | تشغيل/إيقاف + المصدر/المرسل/الاثنان + @username + المعرّف | `GET/PATCH /api/v1/me/settings` |
| جدول المسارات (واجهة) | «حسب الإعداد العام» / «بلا هوية» / تحديد صريح **لكل مسار** | `attributionMode` في `POST/PATCH /api/v1/telegram/publish/routes` |

- إعداد المستخدم: `attributionEnabled` (افتراضي `true`) و`attributionMode` ∈ `source|sender|both`،
  و`attributionShowUsername` (`true`)، و`attributionShowId` (`false`). لا يقبل الخادم `off` هنا (400) —
  الإيقاف العام يكون بـ`attributionEnabled=false`، والإيقاف الموضعي بـ`attributionMode:"off"` على المسار.
- تجاوز المسار: `null` = وراثة، و`off|source|sender|both` = قرار صريح لهذا المسار وحده.

### 16.2 ترتيب الحسم (كما في الكود)

1. `publish_routes.attribution_mode = 'off'` ⇒ لا هوية (سبب `route_off`).
2. `attribution_mode` صريح ⇒ يُطبَّق كما هو (حتى لو كان الإعداد العام موقوفاً).
3. وإلا: الإعداد العام — موقوف ⇒ لا هوية (`user_disabled`)، مفعّل ⇒ النمط المختار.

### 16.3 فحص سريع بعد أي تحديث

```bash
# الإعداد العام (يتطلب كوكي tg_sid ورمز CSRF من /auth/session)
curl -s localhost:4000/api/v1/me/settings -H "Cookie: tg_sid=…" | python3 -m json.tool | grep -A5 attribution

# تجاوز مسار واحد ثم إعادته
curl -s -X PATCH localhost:4000/api/v1/telegram/publish/routes/<id> -H "Cookie: tg_sid=…" \
  -H "X-CSRF-Token: …" -H 'Content-Type: application/json' -H 'Origin: http://localhost:4000' \
  -d '{"name":"…","destinationId":"…","scopes":[…],"attributionMode":"off"}'
```

```sql
-- هل تُلتقط هوية المرسل فعلاً للرسائل الجديدة؟
select count(*) filter (where sender_id is not null) as with_sender, count(*) as total
  from message_identity where created_at > now() - interval '1 day';
-- الأسطر كما ستظهر (عيّنة من آخر تسليم)
select part_index, left(text, 400) from delivery_parts
 where delivery_id = '<id>' order by part_index;
```

### 16.4 أعطال محتملة

| العرض | السبب المرجّح | المعالجة |
|---|---|---|
| لا يظهر سطر المرسل أبداً | الرسالة وصلت قبل الترحيل 0028، أو منشور قناة مجهول بلا توقيع | سلوك مقصود: التقط للمستقبل فقط؛ القنوات الموقّعة تُظهر `postAuthor` |
| ظهرت الهوية رغم إيقافها | للمسار تجاوز صريح `source/sender/both` يتقدّم على الإيقاف العام | عدّل المسار إلى «حسب الإعداد العام» |
| اختفت الهوية لمسار واحد فقط | `attribution_mode = 'off'` على ذلك المسار | أعدها إلى `null` |
| اسم مصدره رقم يظهر محجوباً | حاجب جهات الاتصال يعمل على أسماء المصادر | سلوك أمني مقصود |
| منشور بلا محتوى لم يُنشر ومعه هوية | حارس المنشور الفارغ | سلوك مقصود: الهوية ليست محتوىً |

---

## 17) التقاط هوية المرسل: الخطوة الاحتياطية (إصلاح 2026-11-26)

### 17.1 ما ظهر في الإنتاج
منشور حقيقي ظهر فيه **سطر المصدر فقط** (`📣 المصدر: ارسال رسائل · @jldsjf`) وغاب سطر المرسل رغم أن
الميزة مفعّلة. الفحص أثبت أن المشكلة في **الالتقاط** لا في العرض: في `message_identity` كانت
`sender_id` محفوظة (7490507720 و1374219975) بينما `sender_username` و`sender_display_name` = `null`.

**السبب الجذري:** تيليجرام يُرسل في التحديث معرّف المرسل فقط (`fromId: PeerUser`)، ومكتبة العميل
لا ترفق مصفوفة `users` مع التحديث الوارد (تُرفق الكيانات فقط عند `dispatch` المحلي)، فتبقى
`message._entities` فارغة ⇒ لا اسم ولا @username.

### 17.2 السلسلة الجديدة (`senderResolver.ts`)
| المرحلة | ما تفعله | كلفتها |
|---|---|---|
| 0 | إن كان الاسم واليوزر واصلَين ⇒ لا شيء | صفر |
| 1 | كاش محلي: نجاح 6 ساعات، فشل 10 دقائق (المفتاح: حساب + مرسل) | صفر |
| 2 | `getEntity(userId)` من كاش الجلسة | بلا شبكة عند المعرفة |
| 3 | `getMessages(PeerChat/PeerChannel/PeerUser بالنوع الصريح، ids=[messageId])` ثم إعادة `getEntity` | طلب واحد عند الحاجة فقط |

قيود مقصودة: مهلة 3 ثوانٍ لكل محاولة، لا يُسجَّل أي محتوى أو معرّف في السجلات، وأي فشل يعني
بقاء الهوية بالمعرّف فقط **بلا إسقاط الرسالة**. الترقية تُنفَّذ داخل نافذة نقطة الاستئناف
(`checkpoint.begin`) فلا يتقدّم `pts` قبل حسمها.

**درس مهم من الفحص الحيّ:** تمرير معرّف المجموعة كرقم مجرّد يجعل المكتبة تفترض أنه **مستخدم**
(`Could not find the input entity for PeerUser{...}`). لذلك يُمرَّر النظير بنوعه الصريح من `peerKey`.

### 17.3 إصلاح ذاتي للصفوف القديمة
عند معرفة اسم مرسل/@username — ولو في رسالة لاحقة — تُكمَّل صفوفه السابقة الناقصة على نفس المصدر
والمستخدم في نفس معاملة الالتقاط (`repairedSenders`). لا يمسّ ذلك مستخدماً آخر ولا مصدراً آخر.

### 17.4 كيف تتحقّق
```sql
-- نسبة الرسائل التي وصلت باسم مرسل خلال آخر يوم
select count(*) total, count(sender_id) with_id, count(sender_username) with_username,
       count(sender_display_name) with_name
  from message_identity where first_seen_at > now() - interval '1 day';
```
- إن بقيت `with_name = 0` مع `with_id > 0` فالكاش/الجلسة لا يعرف المستخدم (حساب لم يرَ المرسل قط).
- فحص مباشر لسياق تسليم: `renderAttribution` يجب أن يُرجع سطرَي المصدر والمرسل.

### 17.5 ملاحظة تشغيلية على بيئة التطوير
سجل الإقلاع يقول `attempted: 80, connected: 1, failed: 79` — الحساب الحقيقي واحد، والبقية بقايا
حسابات تجريبية في قاعدة التطوير بجلسات وهمية (`Not a valid string`). لا تؤثر على التشغيل،
ويمكن تنظيفها بحذف الحسابات غير المستخدمة من الواجهة عند الحاجة.

## 18) تدقيق ما قبل التسليم: ماذا تغيّر في التشغيل (2026-11)

المرجع الكامل: `docs/pre-handover-audit-2026-11.md`. ما يهم المشغّل هنا:

**أ) نبضة حياة الاتصال (جديدة).** كل حساب متصل يُفحص كل 45 ثانية بسؤال النقل الحقيقي
(`isConnected`). نبضتان مقطوعتان ⇒ استعادة تلقائية بعميل جديد من آخر جلسة محفوظة.
نفاد المحاولات السريعة لا يعني الموت: محاولة بطيئة كل 5 دقائق. أما `flood_wait`
و`needs_reauth` فلا إعادة تلقائية لهما (بقرار المنتج).
للفحص اليدوي: `manager.probeLiveness(accountId)`.

**ب) لا نشر مكرر بعد لُقية منتهية.** إن سقط العامل بعد الإرسال وقبل تسجيل النجاح،
تنتهي اللُّقية فيصير الجزء والتسليم `uncertain` برمز `lease_expired_unknown`،
**ولا يُعاد الإرسال تلقائياً**. عند رؤية هذا الرمز: تحقّق في القناة ثم سجّل دليلاً
(نُشر / لم يُنشر) من شاشة النشر، وأعد النشر يدوياً عند الحاجة (حدّ 3).

**ج) الرسائل السامّة.** النص الوارد يُنقّى من `NUL` ومحارف التحكم قبل التخزين
(كان محرف واحد كافياً لتوقيف التقاط الحساب). علامات الاتجاه وZWJ محفوظة.

**د) عملاء الربط المهجورون.** منظّف كل دقيقة يفصل عملاء المصادقة الذين تجاوزوا
(مدة صلاحية المحاولة + دقيقة). لا حاجة لتدخل يدوي.

**هـ) البيانات الوهمية نُظّفت.** نسخة CSV قبل الحذف في
`/home/user/backups/purge-20261127-094632/` (135 مستخدماً، 133 حساباً، 133 مصدراً،
121 تسليماً). إقلاع الخادم الآن: `attempted: 1, connected: 1, failed: 0`.

**و) كيف تتحقق من عدم تكرار النشر بعد حادثة؟**

```sql
-- أجزاء أُغلقت كمجهولة ولا يجوز إعادة إرسالها تلقائياً
select d.id, d.status, p.part_index, p.status, p.last_error_code
  from deliveries d join delivery_parts p on p.delivery_id = d.id
 where p.status = 'uncertain' and p.last_error_code = 'lease_expired_unknown'
 order by d.created_at desc limit 20;
```

## 19) البريد الصادر والتنبيهات والفشل المتكرر (P0 — 2026-11)

المرجع الكامل: `docs/p0-implementation-report-2026-11.md`. ما يهم المشغّل:

**أ) تشغيل البريد (خطوتان).**
1) في `apps/api/.env` عيّن **معاً**: `SMTP_HOST` و`SMTP_FROM` (و`SMTP_USER`/`SMTP_PASS` إن كان
الخادم يتطلب مصادقة). منفذ 465 ⇒ `SMTP_SECURE=true`؛ منفذ 587 ⇒ `SMTP_SECURE=false` (STARTTLS).
2) عيّن `APP_PUBLIC_URL` إلى العنوان الذي يفتحه المستخدم فعلاً — روابط الاستعادة تُبنى منه.

قواعد صريحة في الكود: المصادقة **لا** تُرسل على قناة غير مشفّرة (يُرفض الإرسال بـ
`tls_unavailable`)؛ ولا يوجد خيار لتعطيل التحقق من الشهادة (يمكن تمرير `SMTP_CA_PATH` (مسار ملف PEM) لشهادة داخلية).
`SMTP_HOST` فارغ = بريد معطَّل **بلا أعطال إقلاع**: تبقى الرسائل `pending` بلا استهلاك محاولات.

**ب) مستهلك الصندوق يسير تلقائياً** (`OUTBOX_INTERVAL_SECONDS=30`): كل دورة تُسلّم رسالة
واحدة على الأكثر، مع لُقية (لا إرسال مزدوج بين عمليتين) وتأخير متزايد
`30s → 2m → 10m → 30m → 1h` ثم `failed` بعد `OUTBOX_MAX_ATTEMPTS=5`.
`OUTBOX_INTERVAL_SECONDS=0` يُعطّل المستهلك صراحةً (للصيانة فقط).

**ج) مراقبة الصندوق.**

```sql
-- ما ينتظر الإرسال (يجب أن يبقى صفراً في وضع سليم مع SMTP مفعّل)
select status, count(*) from notification_outbox group by status;
-- فاشل نهائياً: اقرأ last_error (رموز مغلقة: auth_failed|rejected|timeout|connect_failed|...)
select template, attempts, last_error, created_at from notification_outbox
 where status = 'failed' order by created_at desc limit 20;
```

`GET /api/v1/admin/overview` يعرض `failed_notifications` و`alerts_open_critical`.

**د) الفشل المتكرر في وجهة.** المعنى: **آخر تسليمات منتهية متتالية فشلت، من الأحدث إلى الأقدم،
قبل أول تسليم منشور**. عند بلوغ 3:
- تنبيه `destination_failures` في مركز التنبيهات (تحذير لوجهة، **حرج** لوجهتين أو أكثر)،
- رسالة بريد واحدة لهذا التنبيه (مفتاح منع التكرار `alert:<id>` — لا تكرار ولو تكرر المسح)،
- لافتة فوق صفحة «النشر إلى تيليجرام» + شارة «إخفاقات متكررة (N)» في صف الوجهة،
- `failureStreak` / `lastFailureAt` في استجابة `GET /telegram/publish/destinations`.

تسليم ناجح واحد يقطع السلسلة ويُغلق التنبيه تلقائياً. للفحص المباشر:

```sql
with ranked as (
  select destination_id, status, last_error_code, created_at, id,
         row_number() over (partition by destination_id order by created_at desc, id desc) rn
    from deliveries where user_id = $1
   where status in ('published','partial','failed','uncertain','blocked'))
select destination_id, count(*) as streak, (array_agg(last_error_code order by rn))[1] as code
  from ranked
 where rn <= 5 and status <> 'published'
   and rn < coalesce((select min(rn) from ranked r2 where r2.destination_id = ranked.destination_id and r2.status = 'published'), 99)
 group by destination_id order by streak desc;
```

**هـ) تأكيدات الحذف (واجهة).** حذف وجهة، حذف مسار، وإعادة النشر: كلها تفتح حوار تأكيد يعرض
الأثر بالأرقام (المعرّف، عدد المسارات المرتبطة، السقف المتبقي للإعادات). لا `window.confirm`
بعد اليوم. لا يمكن تنفيذ الإجراء بالخطأ بضغطة واحدة.

**و) بوابة الاختبار تغيّرت تشغيلياً (لا تغطية).** `npm test` صار يُشغّل ملفات قاعدة البيانات
**ملفاً لكل عملية** بالتتابع (بدل كل الملفات في عملية واحدة) وبحد 240 ثانية للملف. السبب:
أعطال تهيئة عشوائية لنسخ PostgreSQL المضمَّنة داخل عملية واحدة (رأيناها فعلياً في بوابة P0:
`ECONNREFUSED` على منفذ نسخة اختبار). كما صار اختيار منفذ نسخة الاختبار يأتي من النظام
(`listen(0)`) بدل النطاق العشوائي `55000..55499` الذي كان يتصادم مع قاعدة التطوير `55432`.

آخر بوابة كاملة (2026-11): **65 ملفاً · 601 اختبار ناجح · 0 فاشل · 4 متجاوز**،
`tsc` نظيف للـAPI والواجهة، `smoke:web` 24/24، بناء الإنتاج ناجح.
