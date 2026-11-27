# ملفات التشغيل للإنتاج (P4‑ز)

كل ما يلزم لنشر النظام على خادم Linux حقيقي. الخطوات الكاملة في **`docs/runbook.md`**؛
وهنا خريطة الملفات وما يفعله كل ملف ولماذا.

## الخريطة

| المسار | الغرض | تحقّق منه في P4‑ز |
| --- | --- | --- |
| `systemd/tg-api.service` | خدمة النظام الرئيسية: API + عامل النشر + مشغّل الاحتفاظ في **عملية واحدة** | `systemd-analyze verify` نظيف |
| `systemd/tg-migrate.service` | تطبيق الترحيلات (oneshot) قبل تشغيل الخدمة | `systemd-analyze verify` نظيف |
| `systemd/tg-backup.service` + `.timer` | نسخة احتياطية يومية 03:17 مع تشذيب 14 نسخة | `systemd-analyze verify` نظيف |
| `nginx/tg-monitor.conf` | وكيل عكسي TLS + خدمة SPA + تحديد معدل + ترويسات أمان | `nginx -t` ناجح |
| `nginx/snippets/tg-proxy.conf` | ترويسات الوكيل المشتركة (IP الحقيقي بلا ثقة عمياء) | `nginx -t` ناجح |
| `env/api.env.example` | كل متغيّرات الإنتاج بقيم آمنة وتعليقات | مراجعة يدوية |
| `scripts/backup.sh` | pg_dump مخصّص مضغوط + بصمة SHA‑256 + تشذيب + فشل صادق | **شُغِّل فعلياً**: 3 نسخ + تشذيب صحيح |
| `scripts/restore.sh` | فحص → استعادة إلى قاعدة منفصلة (أو `--in-place`) → تحقق | **شُغِّل فعلياً**: 25 ترحيلاً/44 جدولاً مطابقة |
| `scripts/healthcheck.sh` | فحص خارجي: 0 سليم · 1 لا يستجيب · 2 قاعدة غير جاهزة · 3 عامل متوقف | شُغِّل ضد الخدمة الحيّة |
| `scripts/generate-secrets.sh` | توليد مفتاحي التشفير (مختلفين) وكلمة مرور القاعدة | شُغِّل |

## قرارات معمارية مثبَّتة هنا

1. **وحدة واحدة لا وحدتان.** التطبيق يشغّل API والعامل والاحتفاظ معاً. تشغيل وحدة «عامل» ثانية
   يعني نسختين تتنافسان على نفس الطابور وتضاعف استعادة اتصالات تيليجرام. الفصل يحتاج قراراً موثَّقاً.
2. **لا تُعرَّض الخدمة للإنترنت.** `API_HOST=127.0.0.1` + nginx فقط؛ المنافذ 80/443 وحدها مفتوحة.
3. **التسجيلات تذهب إلى journald** لا إلى ملف، فتبقى موحّدة وقابلة للتدوير بـ`journalctl`.
4. **النسخ الاحتياطي يفشل بصوت عالٍ** (exit ≠ 0) ليظهر في `systemctl --failed` والمراقبة؛ النسخة الصامتة الفاشلة أخطر من عدم وجود نسخة.
5. **الاستعادة افتراضياً إلى قاعدة منفصلة**؛ القاعدة الحيّة تحتاج `--in-place --force` وكتابة كلمة `RESTORE`.

## تثبيت سريع

```bash
sudo install -o root -g root -m 644 systemd/*.service systemd/*.timer /etc/systemd/system/
sudo install -o root -g root -m 644 nginx/tg-monitor.conf /etc/nginx/sites-available/
sudo install -o root -g root -m 644 nginx/snippets/tg-proxy.conf /etc/nginx/snippets/
sudo install -o root -g tgmon -m 640 env/api.env.example /etc/tg-monitor/api.env
sudo systemctl daemon-reload && sudo systemctl enable --now tg-migrate tg-api tg-backup.timer
sudo nginx -t && sudo systemctl reload nginx
```

> بعد التثبيت: املأ `/etc/tg-monitor/api.env` (وخصوصاً `DATABASE_URL` والمفتاحين و`APP_ORIGIN`)
> قبل تشغيل الخدمة، ثم اتّبع قائمة التحقّق في `docs/production-readiness.md` §4.
