#!/usr/bin/env bash
#
# توليد الأسرار المطلوبة للإنتاج (P4-ز). لا يكتب شيئاً إلى القرص: يطبع الأسرار لتضعها
# في /etc/tg-monitor/api.env بيدك، ثم تمسح المخرج من الطرفية.
#
#   deploy/scripts/generate-secrets.sh
#
set -Eeuo pipefail
command -v openssl >/dev/null || { echo "openssl غير مثبت" >&2; exit 1; }

echo "# ألصق في /etc/tg-monitor/api.env ثم: chown root:tgmon api.env && chmod 640 api.env"
echo "# مفتاح جلسات MTProto (AES-256-GCM، 32 بايت base64) — لا يُدوَّر بلا خطة:"
echo "TG_SESSION_ENC_KEY=$(openssl rand -base64 32)"
echo "# مفتاح رموز بوتات النشر (مستقل عن الأول — Q1):"
echo "TG_BOT_ENC_KEY=$(openssl rand -base64 32)"
echo "# كلمة مرور دور قاعدة البيانات (إن أنشأت الدور الآن):"
echo "# DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)"
echo
echo "تذكير: النسخ الاحتياطي للمفتاحين لا يقل أهمية عن النسخ الاحتياطي للقاعدة،"
echo "        لكن **لا** تخزّنهما في المستودع ولا في مجلد النسخ نفسه."
