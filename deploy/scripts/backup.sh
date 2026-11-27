#!/usr/bin/env bash
#
# نسخة احتياطية موثوقة لقاعدة بيانات النظام (P4-ز).
#
# المبادئ:
#   - صيغة pg_dump المخصّصة (custom) مضغوطة: تُستعاد انتقائياً وتُفحص بلا استعادة كاملة.
#   - بصمة SHA-256 بجانب كل نسخة: استعادة من ملف تالف لا تبدأ أصلاً.
#   - **لا يُطبع DATABASE_URL أبداً** (يحمل كلمة مرور): السجلات تذكر الملف والحجم فقط.
#   - تُحذف النسخ الأقدم من حدّ صريح (BACKUP_KEEP) لا بلا حد.
#   - تُفشل العملية (exit != 0) عند أي خطأ، فيراها systemd/المراقبة.
#
# الاستخدام:
#   deploy/scripts/backup.sh                 # يقرأ DATABASE_URL من البيئة أو /etc/tg-monitor/api.env
#   BACKUP_DIR=/srv/backups BACKUP_KEEP=7 deploy/scripts/backup.sh
#
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/tg-monitor}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
PG_BIN="${PG_BIN:-/usr/bin}"
ENV_FILE="${ENV_FILE:-/etc/tg-monitor/api.env}"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
die() { log "خطأ: $*"; exit 1; }

# إن لم يكن DATABASE_URL في البيئة، نقرأه من ملف البيئة بلا طباعته.
if [[ -z "${DATABASE_URL:-}" && -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL غير مضبوط (لا في البيئة ولا في $ENV_FILE)"

PG_DUMP="$PG_BIN/pg_dump"
PG_RESTORE="$PG_BIN/pg_restore"
[[ -x "$PG_DUMP" ]] || die "pg_dump غير موجود في $PG_BIN (اضبط PG_BIN)"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
host_short="$(hostname -s 2>/dev/null || echo host)"
target="$BACKUP_DIR/tg-monitor-${host_short}-${stamp}.dump"
# تشغيلان في الثانية نفسها لا يكتبان فوق بعضهما: لاحقة تسلسلية عند التصادم.
suffix=1
base="$target"
while [[ -e "$target" ]]; do
  suffix=$((suffix + 1))
  target="${base%.dump}-${suffix}.dump"
done

log "بدء نسخة احتياطية إلى $target"
started=$SECONDS

"$PG_DUMP" \
  --dbname="$DATABASE_URL" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="$target"

# فحص فوري: ملف لا يقرأه pg_restore لا يُعدّ نسخة.
"$PG_RESTORE" --list "$target" > /dev/null || die "النسخة غير قابلة للقراءة: $target"

( cd "$BACKUP_DIR" && sha256sum "$(basename "$target")" > "$(basename "$target").sha256" )
size="$(du -h "$target" | cut -f1)"
elapsed=$((SECONDS - started))
log "تمّت النسخة: $(basename "$target") (${size}, ${elapsed}s) وبصمتها محفوظة"

# تشذيب: نُبقي أحدث BACKUP_KEEP نسخة (والبصمات التابعة لها)، ونحذف ما قبلها.
mapfile -t old < <(ls -1t "$BACKUP_DIR"/tg-monitor-*.dump 2>/dev/null | tail -n "+$((BACKUP_KEEP + 1))")
if ((${#old[@]} > 0)); then
  for file in "${old[@]}"; do
    rm -f -- "$file" "$file.sha256"
    log "حُذفت نسخة قديمة: $(basename "$file")"
  done
fi

log "انتهى التشغيل بنجاح"
