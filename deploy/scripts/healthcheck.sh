#!/usr/bin/env bash
#
# فحص صحة خارجي للاستخدام في المراقبة وcron (P4-ز).
#
#   healthcheck.sh                     # يقرأ BASE_URL افتراضياً http://127.0.0.1:4000
#   BASE_URL=https://monitor.example.com healthcheck.sh
#
# رموز الخروج: 0 سليم · 1 الخدمة لا تستجيب · 2 قاعدة البيانات غير جاهزة · 3 عامل النشر متوقف
set -Eeuo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"
TIMEOUT="${TIMEOUT:-5}"
log() { printf '%s\n' "$*" >&2; }

fetch() { curl -fsS --max-time "$TIMEOUT" "$BASE_URL$1" 2>/dev/null || return 1; }

if ! health="$(fetch /healthz)"; then
  log "غير سليم: /healthz لا يستجيب ($BASE_URL)"
  exit 1
fi
if ! ready="$(fetch /readyz)"; then
  log "غير جاهز: /readyz رفض الطلب — $health"
  exit 2
fi

worker_state="$(printf '%s' "$ready" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("publishWorker",{}).get("state","unknown"))' 2>/dev/null || echo unknown)"
case "$worker_state" in
  ok) log "سليم: قاعدة البيانات متصلة وعامل النشر ينبض"; exit 0 ;;
  stale|missing) log "تحذير: عامل النشر $worker_state — الرسائل لن تُرسل"; exit 3 ;;
  *) log "سليم (حالة العامل غير معروفة: $worker_state)"; exit 0 ;;
esac
