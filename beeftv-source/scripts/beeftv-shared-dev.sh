#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_DIR="${GO_DIR:-/tmp/beeftv-go.rpIfVN}"
BACKEND_ADDR="${CANVAS_DESKTOP_BACKEND_ADDR:-127.0.0.1:8080}"
LAUNCH_TOKEN="${CANVAS_DESKTOP_LAUNCH_TOKEN:-$(openssl rand -hex 32)}"

export CANVAS_DESKTOP_BACKEND_ADDR="$BACKEND_ADDR"
export CANVAS_DESKTOP_LAUNCH_TOKEN="$LAUNCH_TOKEN"
export VITE_API_PROXY_TARGET="http://${BACKEND_ADDR}"
export VITE_DESKTOP_LAUNCH_TOKEN="$LAUNCH_TOKEN"
if ! command -v go >/dev/null 2>&1 && [ -x "$GO_DIR/go/bin/go" ]; then
  export PATH="$GO_DIR/go/bin:$PATH"
fi
export GOTOOLCHAIN=local

cd "$ROOT_DIR"
(cd web && bun run dev -- --host 127.0.0.1 --port 3000) &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT INT TERM

cd backend/cmd/desktop
go run github.com/wailsapp/wails/v2/cmd/wails@v2.16.0 dev
