#!/usr/bin/env bash
#
# استعادة موثوقة من نسخة احتياطية (P4-ز).
#
# المبادئ:
#   - **الافتراضي آمن**: لا استعادة داخل القاعدة الحيّة إلا بطلب صريح وكلمة تأكيد مكتوبة.
#   - **تحقق قبل اللمس**: البصمة تُفحص، والملف يُقرأ بـpg_restore --list قبل أي كتابة.
#   - **قاعدة هدف منفصلة أولاً**: الاستعادة تُجرَّب في قاعدة جديدة (tg_restore_*) ثم تُقارن الأرقام.
#   - **لا طباعة أسرار**: السجلات تذكر أسماء الملفات وقواعد البيانات فقط.
#
# الاستخدام:
#   restore.sh --file <dump> --target-db <name> [--create] [--force]      # قاعدة منفصلة (مستحسن)
#   restore.sh --file <dump> --in-place                                    # استبدال القاعدة الحيّة (خطر)
#   restore.sh --verify <dump>                                             # فحص الملف فقط بلا كتابة
#
set -Eeuo pipefail

PG_BIN="${PG_BIN:-/usr/bin}"
ENV_FILE="${ENV_FILE:-/etc/tg-monitor/api.env}"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
die() { log "خطأ: $*"; exit 1; }
usage() {
  sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

FILE=""; TARGET_DB=""; CREATE=0; FORCE=0; IN_PLACE=0; VERIFY_ONLY=0
while (($#)); do
  case "$1" in
    --file) FILE="${2:-}"; shift 2 ;;
    --target-db) TARGET_DB="${2:-}"; shift 2 ;;
    --create) CREATE=1; shift ;;
    --force) FORCE=1; shift ;;
    --in-place) IN_PLACE=1; shift ;;
    --verify) VERIFY_ONLY=1; shift ;;
    -h|--help) usage ;;
    # مسار ملف مجرّد يُقبل كوسيط أول (يسمح بـ: restore.sh --verify <dump>).
    -*) die "وسيط غير معروف: $1" ;;
    *) [[ -z "$FILE" ]] || die "وسيط إضافي غير متوقع: $1"; FILE="$1"; shift ;;
  esac
done

[[ -n "$FILE" ]] || usage
[[ -r "$FILE" ]] || die "الملف غير موجود أو غير مقروء: $FILE"
PG_RESTORE="$PG_BIN/pg_restore"
PSQL="$PG_BIN/psql"
[[ -x "$PG_RESTORE" && -x "$PSQL" ]] || die "pg_restore/psql غير موجودَين في $PG_BIN"

# (1) فحص البصمة إن وُجدت.
# نُقارن البصمة المحسوبة بالمخزَّنة مباشرةً بدل `sha256sum -c`: ملف البصمة يحمل اسم الملف الأصلي،
# و`-c` قد يقرأ **ملفاً آخر** بنفس الاسم فيمرّ خطأً (اختُبر: نسخة معدّلة باسم مختلف نجت من الفحص).
if [[ -r "$FILE.sha256" ]]; then
  expected="$(awk 'NR==1 {print $1}' "$FILE.sha256")"
  actual="$(sha256sum "$FILE" | awk '{print $1}')"
  [[ -n "$expected" && "$expected" == "$actual" ]] \
    || die "بصمة الملف لا تطابق — النسخة تالفة أو مُعدَّلة"
  log "بصمة SHA-256 مطابقة"
else
  log "تحذير: لا ملف بصمة بجانب النسخة؛ تابع الفحص الداخلي فقط"
fi

# (2) فحص القراءة: لا نلمس أي قاعدة قبل التأكد أن الملف يُقرأ.
"$PG_RESTORE" --list "$FILE" > /dev/null || die "الملف غير قابل للقراءة بـpg_restore"

if ((VERIFY_ONLY)); then
  tables="$("$PG_RESTORE" --list "$FILE" | awk '$0 ~ / TABLE DATA / {c++} END {print c+0}')"
  log "الملف سليم — جداول ببيانات: $tables"
  exit 0
fi

if [[ -z "${DATABASE_URL:-}" && -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL غير مضبوط"

if ((IN_PLACE)); then
  target_url="$DATABASE_URL"
  [[ $FORCE -eq 1 ]] || die "الاستعادة داخل القاعدة الحيّة تحتاج --force صريحاً"
  printf 'اكتب RESTORE لتأكيد استبدال القاعدة الحيّة: ' >&2
  read -r answer
  [[ "$answer" == "RESTORE" ]] || die "أُلغيت الاستعادة"
else
  [[ -n "$TARGET_DB" ]] || die "حدّد --target-db (استعادة إلى قاعدة منفصلة) أو --in-place"
  [[ "$TARGET_DB" =~ ^[a-z][a-z0-9_]{2,62}$ ]] || die "اسم قاعدة غير صالح: $TARGET_DB"
  # اشتقاق عنوان القاعدة الهدف من نفس الخادم بلا طباعة كلمة المرور.
  target_url="$(python3 - "$DATABASE_URL" "$TARGET_DB" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
url, db = sys.argv[1], sys.argv[2]
parts = urlsplit(url)
print(urlunsplit((parts.scheme, parts.netloc, '/' + db, parts.query, parts.fragment)))
PY
)"
  admin_url="$(python3 - "$DATABASE_URL" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
parts = urlsplit(sys.argv[1])
print(urlunsplit((parts.scheme, parts.netloc, '/postgres', parts.query, parts.fragment)))
PY
)"
  if ((CREATE)); then
    log "إنشاء قاعدة الهدف $TARGET_DB"
    "$PSQL" "$admin_url" -v ON_ERROR_STOP=1 -q -c "create database \"$TARGET_DB\"" \
      || die "تعذّر إنشاء القاعدة (قد تكون موجودة؛ استخدم --force للاستعادة فوقها)"
  fi
fi

if ((FORCE)); then
  clean_flags=(--clean --if-exists)
else
  clean_flags=()
fi

log "بدء الاستعادة"
"$PG_RESTORE" \
  --dbname="$target_url" \
  --no-owner \
  --no-privileges \
  --single-transaction \
  "${clean_flags[@]}" \
  --exit-on-error \
  "$FILE"

# (3) تحقق بعد الاستعادة: الترحيلات وعدد الجداول — بلا أي بيانات محتوى.
db_label=$([[ $IN_PLACE -eq 1 ]] && echo "(القاعدة الحيّة)" || echo "$TARGET_DB")
counts="$("$PSQL" "$target_url" -At -F' ' -v ON_ERROR_STOP=1 -c \
  "select (select count(*) from schema_migrations) || ' migrations, ' ||
          (select count(*) from information_schema.tables where table_schema='public') || ' tables'")"
log "اكتملت الاستعادة $db_label — $counts"
log "تذكير: إن كانت استعادة كاملة للإنتاج فأوقف الخدمة قبل الاستبدال، ثم نفّذ migrate وتحقّق من /readyz"
