#!/bin/sh
# نسخة احتياطية يومية — النسخة التي تعمل **داخل حاوية Compose**.
#
# لماذا ملف منفصل عن deploy/scripts/backup.sh؟
#   - `backup.sh` مكتوب لمسار المضيف/systemd (bash، PG_BIN=/usr/bin، DATABASE_URL من ملف).
#   - هذه النسخة تعمل في صورة `postgres:17-alpine` (sh فقط، pg_dump في PATH،
#     واتصال جاهز عبر PGHOST/PGUSER/PGPASSWORD) — فلا نُشوّه نصّاً مجرَّباً بمسار آخر.
# وخواص السلامة نفسها: تحقّق بعد الكتابة، وبصمة SHA-256 بجانب كل ملف، واحتفاظ محدود.
set -eu

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
FILE="$DIR/tg-${STAMP}.dump"

umask 077
mkdir -p "$DIR"

echo "[backup] بدء النسخة: $FILE"

if ! pg_dump -Fc --no-owner --no-privileges -f "$FILE"; then
  echo "[backup] فشل pg_dump — النسخة الجزئية حُذفت" >&2
  rm -f "$FILE"
  exit 1
fi

# 1) الملف قابل للقراءة بفهرسه الداخلي (كشف البتر/التلف فوراً).
if ! pg_restore --list "$FILE" >/dev/null 2>&1; then
  echo "[backup] فشل التحقّق من الفهرس — الملف حُذف" >&2
  rm -f "$FILE" "$FILE.sha256"
  exit 1
fi

# 2) بصمة SHA-256 بجانب الملف: استعادة من نسخة تالفة لا تبدأ أصلاً.
sha256sum "$FILE" > "$FILE.sha256"

SIZE="$(wc -c < "$FILE" | tr -d ' ')"
echo "[backup] تمّت ($SIZE بايت) واجتازت التحقّق"

# آخر نسخة ناجحة، يقرأها المراقب/المشغّل بلا تنقيب في الملفات.
printf '%s %s\n' "$STAMP" "$SIZE" > "$DIR/last-success.txt"

# الاحتفاظ: ملفات tg- فقط، والأقدم من المدة المحددة.
find "$DIR" -maxdepth 1 -type f \( -name 'tg-*.dump' -o -name 'tg-*.dump.sha256' \) -mtime "+$KEEP" -print -delete 2>/dev/null || true

echo "[backup] النسخ الحالية: $(find "$DIR" -maxdepth 1 -type f -name 'tg-*.dump' | wc -l | tr -d ' ')"
