# syntax=docker/dockerfile:1
#
# صورة إنتاج TG Monitor (API + عامل الصندوق + خادم الواجهة على نفس المنفذ).
#
# لماذا بناء متعدّد المراحل: صورة التشغيل لا تحمل أدوات البناء ولا شيفرة الواجهة المصدرية،
# وتعمل بمستخدم غير جذر. وكل الاعتماديات JS صافية (بلا ترجمة أصلية) ⇒ الصورة نفسها
# تُبنى لـlinux/amd64 وlinux/arm64 بلا تعديل — وهذا شرط خطة Oracle Always Free (ARM).

# ── المرحلة 1: البناء ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# طبقة الاعتماديات أولاً: تتغيّر أقل من الشيفرة، فتبقى مخزَّنة (cache) بين البناءات.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund

# الشيفرة + البناء (الـAPI ينسخ ترحيلات .sql إلى dist، والواجهة تُبنى بـVite).
COPY apps ./apps
COPY scripts ./scripts
RUN npm --workspace @tg/api run build \
 && npm --workspace @tg/web run build \
 && npm prune --omit=dev

# ── المرحلة 2: التشغيل ───────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/apps/web/dist \
    API_HOST=0.0.0.0 \
    API_PORT=4000
WORKDIR /app

# مستخدم غير جذر بمعرّف ثابت (يبقى ثابتاً بين النسخ ولا يملك أي صلاحية على المضيف).
RUN groupadd --gid 10001 tgmon \
 && useradd --uid 10001 --gid tgmon --create-home --shell /usr/sbin/nologin tgmon

COPY --from=build --chown=tgmon:tgmon /app/node_modules ./node_modules
COPY --from=build --chown=tgmon:tgmon /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=tgmon:tgmon /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=tgmon:tgmon /app/apps/web/dist ./apps/web/dist

USER tgmon
WORKDIR /app/apps/api

EXPOSE 4000

# فحص حياة بلا أدوات إضافية (الصورة لا تحمل curl): fetch من Node نفسه.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# إشارات نظامية صحيحة (SIGTERM ⇒ إغلاق آمن: العامل يتوقف، المقابس تُغلق، الاتصالات تُحفظ).
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
