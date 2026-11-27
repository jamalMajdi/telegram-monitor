#!/usr/bin/env bash
# تثبيت TG Monitor على خادم Ubuntu (Oracle Cloud Always Free ARM أو أي VPS).
#
# يفعل مرة واحدة ما لا يجب أن يُعاد يدوياً: حزم النظام، الجدار الناري، Docker،
# مستخدم الخدمة، الأسرار، ملف .env بصلاحية 600، وأول إقلاع.
#
# التشغيل (كمستخدم له sudo، من داخل نسخة المستودع):
#   sudo bash deploy/scripts/bootstrap.sh
#
# مبادئ مقصودة:
# - **لا سرّ يمرّ عبر المحادثة أو المستودع:** كل المفاتيح تُولَّد على الخادم بـopenssl.
# - **لا منفذ عام إلا 80/443** (وSSH مقيّد مسبقاً في Security List/جدار المزوّد).
# - **idempotent:** إعادة تشغيله لا تُتلف شيئاً ولا تُبدّل أسراراً موجودة.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tg-monitor}"
REPO_DIR="$APP_DIR/src"
ENV_FILE="$APP_DIR/.env"
REPO_URL="${REPO_URL:-https://github.com/jamalMajdi/telegram-monitor.git}"
BRANCH="${BRANCH:-main}"

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "شغّل هذا السكربت بـsudo."; exit 1; }

# ── 1) حزم النظام ────────────────────────────────────────────────────────────
log "تحديث الحزم وتثبيت الأساسيات"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git jq ufw fail2ban openssl >/dev/null

# ── 2) الجدار الناري: 80/443 فقط + SSH مقيّد ─────────────────────────────────
log "إعداد الجدار الناري (ufw): 80/443 فقط، وحدّ محاولات SSH"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp comment 'SSH' >/dev/null
ufw limit 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp comment 'HTTP (ACME + redirect)' >/dev/null
ufw allow 443/tcp comment 'HTTPS' >/dev/null
ufw allow 443/udp comment 'HTTP/3' >/dev/null
ufw --force enable >/dev/null
ufw status verbose | sed 's/^/   /'

# ── 3) Docker (من المستودع الرسمي) ───────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "تثبيت Docker Engine + Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null
else
  log "Docker مثبَّت مسبقاً — تخطٍّ"
fi
docker --version | sed 's/^/   /'
docker compose version | sed 's/^/   /'

# من شغّل السكربت يبقى قادراً على النشر بلا sudo (عضوية مجموعة docker)،
# وGitHub Actions يدخل بهذا المستخدم نفسه.
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  usermod -aG docker "$SUDO_USER"
  log "أُضيف $SUDO_USER إلى مجموعة docker (يسري بعد إعادة تسجيل الدخول)"
fi

# ── 4) نسخة المستودع ─────────────────────────────────────────────────────────
log "جلب المستودع إلى $REPO_DIR"
mkdir -p "$APP_DIR"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch --depth=1 origin "$BRANCH"
  git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

# ── 5) ملف الأسرار ───────────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  log "‏$ENV_FILE موجود — لن أُبدّل أسراره (idempotent). عالج القيم الناقصة يدوياً."
else
  log "توليد الأسرار على الخادم وكتابة $ENV_FILE"
  PG_PASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-28)"
  SESSION_KEY="$(openssl rand -base64 32)"
  BOT_KEY="$(openssl rand -base64 32)"

  cat > "$ENV_FILE" <<ENVEOF
# ═══ TG Monitor — إعدادات الإنتاج (صلاحية 600، لا يدخل المستودع) ═══
# عدّل الأسطر المعلَّمة بـ«← عدّل» ثم: sudo bash $APP_DIR/src/deploy/scripts/deploy.sh build

# ── النطاق وTLS ─────────────────────────────────────────────────────────────
# نطاق DuckDNS: سجّل في duckdns.org واسمك يصبح yourname.duckdns.org ثم وجّهه إلى IP هذا الخادم.
DOMAIN=CHANGE_ME.duckdns.org            # ← عدّل
ACME_EMAIL=CHANGE_ME@example.com        # ← عدّل (بريد استلام تنبيهات الشهادة)

# ── قاعدة البيانات ──────────────────────────────────────────────────────────
POSTGRES_DB=telegram_monitor
POSTGRES_USER=tgmon
POSTGRES_PASSWORD=$PG_PASS
BACKUP_KEEP_DAYS=14
BACKUP_INTERVAL_SECONDS=86400

# ── الصورة والنشر (اتركها كما هي في وضع «بناء محلي») ────────────────────────
IMAGE_REPO=tg-monitor-api
IMAGE_TAG=local

# ── التطبيق ─────────────────────────────────────────────────────────────────
NODE_ENV=production
API_PORT=4000
API_HOST=0.0.0.0
LOG_LEVEL=info
BOOTSTRAP_ADMIN_EMAIL=CHANGE_ME@example.com   # ← عدّل: أول مدير للنظام

# الجلسات والأمان
SESSION_IDLE_MINUTES=480
SESSION_ABSOLUTE_HOURS=720
SESSION_COOKIE_NAME=tg_sid
COOKIE_SECURE=auto
SESSION_COOKIE_SAMESITE=lax
AUTH_BEARER_FALLBACK=false
DEV_EXPOSE_RESET_TOKEN=false
LOGIN_MAX_FAILED_ATTEMPTS=5
LOGIN_LOCK_MINUTES=15
LOGIN_ATTEMPT_WINDOW_MINUTES=15

# مفاتيح التشفير — وُلِّدت على هذا الخادم الآن. لا تُنسخ إلى أي مكان آخر،
# واحتفظ بنسخة آمنة منها: فقدانها يعني إعادة ربط الحسابات والبوتات.
TG_SESSION_ENC_KEY=$SESSION_KEY
TG_SESSION_ENC_KEY_VERSION=1
TG_SESSION_ENC_KEY_PREVIOUS=
TG_BOT_ENC_KEY=$BOT_KEY
TG_BOT_ENC_KEY_VERSION=1
TG_BOT_ENC_KEY_PREVIOUS=

# ── تيليجرام MTProto (من my.telegram.org) ───────────────────────────────────
TG_API_ID=CHANGE_ME                      # ← عدّل
TG_API_HASH=CHANGE_ME                    # ← عدّل
TG_MAX_RECONNECT_ATTEMPTS=5
TG_RECONNECT_BASE_DELAY_MS=1000
TG_FLOOD_SLEEP_THRESHOLD=0
TG_CATCH_UP=true
TG_TEST_SERVERS=false
TG_REQUEST_TIMEOUT_SECONDS=20
TG_LOGIN_TTL_MINUTES=10
TG_LOGIN_MAX_CODE_ATTEMPTS=5
TG_LOGIN_MAX_PASSWORD_ATTEMPTS=3
TG_LOGIN_MAX_RESENDS=3
TG_LOGIN_RESEND_INTERVAL_SECONDS=30
TG_RESTORE_ON_START=true

# ── البريد الصادر (Gmail App Password) ──────────────────────────────────────
# 1) فعّل التحقق بخطوتين في حسابك ثم: myaccount.google.com/apppasswords
# 2) SMTP_FROM **يجب** أن يساوي حساب Gmail نفسه (Google يعيد كتابة المُرسِل وإلا).
APP_PUBLIC_URL=https://CHANGE_ME.duckdns.org   # ← عدّل (نفس DOMAIN)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=CHANGE_ME@gmail.com                 # ← عدّل
SMTP_PASS=CHANGE_ME_APP_PASSWORD              # ← عدّل (16 حرفاً بلا مسافات)
SMTP_FROM=CHANGE_ME@gmail.com                 # ← عدّل (نفس SMTP_USER)
SMTP_FROM_NAME=منصة الرصد والنشر
SMTP_TIMEOUT_MS=20000
SMTP_CA_PATH=
OUTBOX_INTERVAL_SECONDS=30
OUTBOX_MAX_ATTEMPTS=5
ENVEOF

  chown root:root "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "كُتب $ENV_FILE بصلاحية 600 — فيه 6 قيم «CHANGE_ME» يجب تعديلها قبل التشغيل"
fi

# ── 6) ملفات الحزمة في مكانها ────────────────────────────────────────────────
log "تركيب ملفات Compose وCaddyfile"
cp "$REPO_DIR/docker-compose.prod.yml" "$APP_DIR/docker-compose.yml"
cp "$REPO_DIR/deploy/Caddyfile" "$APP_DIR/Caddyfile"
# نُنسخ سكربتات النشر إلى جانب ملف Compose: المسارات داخله نسبية إلى مكانه.
mkdir -p "$APP_DIR/deploy"
cp -r "$REPO_DIR/deploy/scripts" "$APP_DIR/deploy/scripts"
mkdir -p "$APP_DIR/backups"

# ── 7) مؤقت منع استعادة الموارد الخاملة (أوراكل) ─────────────────────────────
if [ -d /etc/systemd/system ]; then
  log "تثبيت مؤقت النبضة اليومية (يمنع استعادة آلة Always Free الخاملة)"
  install -m 0644 "$REPO_DIR/deploy/systemd/tg-monitor-keepalive.service" /etc/systemd/system/
  install -m 0644 "$REPO_DIR/deploy/systemd/tg-monitor-keepalive.timer" /etc/systemd/system/
  install -m 0755 "$REPO_DIR/deploy/scripts/keepalive.sh" /usr/local/bin/tg-keepalive
  systemctl daemon-reload
  systemctl enable --now tg-monitor-keepalive.timer >/dev/null
fi

# ── 8) الخلاصة ───────────────────────────────────────────────────────────────
cat <<DONE

═══════════════════════════════════════════════════════════════════
 التثبيت تم. الخطوات المتبقية عليك (٣ دقائق):

 1) عدّل القيم المعلَّمة «← عدّل» في:
      sudo nano $ENV_FILE
    (DOMAIN, ACME_EMAIL, BOOTSTRAP_ADMIN_EMAIL, TG_API_ID, TG_API_HASH, SMTP_*)

 2) تأكد أن نطاق DuckDNS يشير إلى IP هذا الخادم، ثم افتح 80/443 في
    Security List داخل لوحة Oracle (ufw وحده لا يكفي هناك).

 3) شغّل النشر:
      sudo bash $REPO_DIR/deploy/scripts/deploy.sh build

 ثم: https://<DOMAIN>  ← أنشئ أول مدير بكلمة مرور قوية.
═══════════════════════════════════════════════════════════════════
DONE
