# syntax=docker/dockerfile:1.7

# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
ARG BUILD_VERSION
ENV CANVAS_BUILD_VERSION=${BUILD_VERSION}
COPY web/package.json web/bun.lock ./
COPY web/patches ./patches
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY README.md /app/README.md
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /app/
COPY licenses /app/licenses
COPY scripts/distribution-notices.mjs /app/scripts/distribution-notices.mjs
COPY assets /app/assets
COPY backend/internal/providerpreset/image_contracts.json /app/backend/internal/providerpreset/image_contracts.json
COPY backend/internal/providerpreset/video_contracts.json /app/backend/internal/providerpreset/video_contracts.json
COPY web ./
# 生产镜像只构建云端工作台前端；Agent Runtime 在后端 Worker 中运行。
RUN bun --bun ./node_modules/vite/bin/vite.js build

# 运行镜像：nginx 托管静态前端，并在 Compose 中把 /api 转发到后端服务。
FROM nginx:1.27-alpine

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
