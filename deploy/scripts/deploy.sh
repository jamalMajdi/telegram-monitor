#!/usr/bin/env bash
# نشر/تحديث الحزمة على الخادم.
#
#   sudo bash deploy/scripts/deploy.sh build        # بناء الصورة محلياً (بلا أي سجل صور)
#   sudo bash deploy/scripts/deploy.sh image <tag>  # سحب صورة جاهزة من GHCR
#
# لماذا الوضعان: «بناء محلي» هو الأنسب لآلة واحدة مجانية (لا حساب سجل، لا حدود سحب،
# ولا توكن إضافي). «سحب صورة» هو الأنسب إن بنت GitHub Actions الصورة مسبقاً.
#
# ما يفعله دائماً: تحديث الملفات من المستودع → إعادة بناء/سحب → ترحيلات → إقلاع →
# تحقّق صحي حقيقي → تراجع تلقائي إن فشل الفحص.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tg-monitor}"
REPO_DIR="$APP_DIR/src"
ENV_FILE="$APP_DIR/.env"
COMPOSE="docker compose --env-file $ENV_FILE -f $APP_DIR/docker-compose.yml"
MODE="${1:-build}"
TAG="${2:-latest}"

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

[ -f "$ENV_FILE" ] || { echo "لا يوجد $ENV_FILE — شغّل bootstrap.sh أولاً."; exit 1; }
grep -q 'CHANGE_ME' "$ENV_FILE" && { echo "ملف .env فيه قيم CHANGE_ME لم تُعدَّل بعد. أوقف النشر."; exit 1; }

cd "$APP_DIR"

# 1) تحديث الملفات من المستودع (المستودع عام ⇒ لا بيانات دخول على الخادم).
log "تحديث المستودع"
git -C "$REPO_DIR" fetch --depth=1 origin main
git -C "$REPO_DIR" reset --hard origin/main
cp "$REPO_DIR/docker-compose.prod.yml" "$APP_DIR/docker-compose.yml"
cp "$REPO_DIR/deploy/Caddyfile" "$APP_DIR/Caddyfile"
mkdir -p "$APP_DIR/deploy"
cp -r "$REPO_DIR/deploy/scripts" "$APP_DIR/deploy/scripts"

# 2) الصورة
case "$MODE" in
  build)
    log "بناء الصورة محلياً (multi-arch تلقائياً حسب معمارية هذا الخادم)"
    $COMPOSE build api
    ;;
  image)
    log "سحب الصورة ghcr.io/...:$TAG"
    if [ -f "$APP_DIR/ghcr-token" ]; then
      # توكن قراءة فقط لحزم GHCR (يُنشأ من GitHub ويوضع هنا بصلاحية 600).
      head -c 200 "$APP_DIR/ghcr-token" | docker login ghcr.io -u "${GHCR_USER:-jamalMajdi}" --password-stdin
    fi
    IMAGE_TAG="$TAG" IMAGE_REPO="ghcr.io/jamalmajdi/telegram-monitor" $COMPOSE pull api migrate
    ;;
  *)
    echo "وضع غير معروف: $MODE (استخدم build أو image <tag>)"; exit 1;;
esac

# 3) الإقلاع (migrate خدمة لمرة واحدة؛ api لا يبدأ قبل نجاحها).
log "إقلاع الحزمة"
if [ "$MODE" = "image" ]; then
  IMAGE_TAG="$TAG" IMAGE_REPO="ghcr.io/jamalmajdi/telegram-monitor" $COMPOSE up -d --remove-orphans
else
  $COMPOSE up -d --remove-orphans
fi

# 4) تحقّق صحي حقيقي (لا نكتفي بـ«up -d نجح»).
log "فحص الصحة"
DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]')"
ok=0
for i in $(seq 1 30); do
  sleep 3
  # من الداخل: /ready يتحقّق من القاعدة والعامل.
  if $COMPOSE exec -T api node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ok=1; break
  fi
  printf '.'
done
echo

if [ "$ok" -ne 1 ]; then
  echo "فشل الفحص الصحي — سجلّات آخر 40 سطراً:"
  $COMPOSE logs --tail=40 api
  echo
  echo "أعيد تشغيل النسخة السابقة إن كانت موجودة: $COMPOSE up -d"
  exit 1
fi

# 5) فحص خارجي عبر البوابة (TLS + الشهادة) — إن كان النطاق يشير للخادم.
if [ -n "$DOMAIN" ] && curl -fsS --max-time 10 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
  echo "✅ https://$DOMAIN/healthz يعمل (TLS سليم)"
else
  echo "⚠️  الفحص الخارجي لم ينجح بعد — قد تكون الشهادة قيد الإصدار. راجع: $COMPOSE logs caddy"
fi

log "النسخة الحالية"
$COMPOSE ps
