# syntax=docker/dockerfile:1.7

FROM alpine:3.22 AS protocol-package-build

RUN apk add --no-cache nodejs zip

WORKDIR /src
COPY plugin-packages ./plugin-packages
RUN ./plugin-packages/build-packages.sh

FROM golang:1.25-alpine AS backend-build

ARG GOPROXY=https://proxy.golang.org,direct
ARG BUILD_VERSION
ARG BUILD_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV GOPROXY=$GOPROXY

RUN apk add --no-cache build-base

WORKDIR /src/backend
COPY VERSION /src/VERSION
COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY backend ./
RUN --mount=type=cache,target=/root/.cache/go-build set -eu; \
    version="${BUILD_VERSION:-$(tr -d '\r\n' </src/VERSION)}"; \
    ldflags="-s -w -X infinite-canvas/backend/internal/buildinfo.Version=${version} -X infinite-canvas/backend/internal/buildinfo.Commit=${BUILD_COMMIT} -X infinite-canvas/backend/internal/buildinfo.BuildTime=${BUILD_TIME}"; \
    CGO_ENABLED=1 GOOS=linux go build -trimpath -ldflags="$ldflags" -o /out/infinite-canvas-backend ./cmd/server

FROM alpine:3.22

RUN apk add --no-cache ca-certificates tzdata wget \
    && addgroup -S app \
    && adduser -S app -G app

WORKDIR /app
ENV GIN_MODE=release
# Loopback inside the container. Compose sets CANVAS_BACKEND_ADDR=:8080 so other
# containers can reach the API. Do not publish 8080 on all host interfaces:
# the server profile has no launch token.
ENV CANVAS_BACKEND_ADDR=127.0.0.1:8080
ENV CANVAS_BACKEND_DATA_DIR=/data

RUN mkdir -p /data && chown -R app:app /data
COPY --from=backend-build /out/infinite-canvas-backend /usr/local/bin/infinite-canvas-backend
COPY --from=protocol-package-build /src/plugin-packages /app/plugin-packages

USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/api/health/ready >/dev/null || exit 1
CMD ["infinite-canvas-backend"]
