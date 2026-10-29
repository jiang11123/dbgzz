#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MEASURE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/beeftv-measure.XXXXXX")"
trap 'rm -rf "$MEASURE_DIR"' EXIT

(
  cd "$ROOT_DIR/backend"
  go build -o "$MEASURE_DIR/beeftv-desktop" ./cmd/desktop
  binary_bytes="$(stat -f '%z' "$MEASURE_DIR/beeftv-desktop" 2>/dev/null || stat -c '%s' "$MEASURE_DIR/beeftv-desktop")"
  dependency_count="$(go list -deps ./cmd/desktop | sort -u | wc -l | tr -d ' ')"
  echo "desktop_binary_bytes=$binary_bytes"
  echo "desktop_go_dependency_count=$dependency_count"
  go test ./internal/bootstrap -run '^TestDesktopColdOpenBudgetAndNoIdleOutbound$' -count=1 -v
)

repository_kib="$(du -sk "$ROOT_DIR/backend/internal" "$ROOT_DIR/web/src" | awk '{total += $1} END {print total}')"
echo "backend_and_frontend_source_kib=$repository_kib"
