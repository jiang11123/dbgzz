#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_DIR="${BEEFTV_GO_DIR:-/tmp/beeftv-go.rpIfVN/go}"

if ! command -v go >/dev/null 2>&1 && [[ -x "$GO_DIR/bin/go" ]]; then
  export PATH="$GO_DIR/bin:$PATH"
fi

if ! command -v go >/dev/null 2>&1; then
  echo "Go is required for the local release gate (set BEEFTV_GO_DIR when using a bundled toolchain)" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required for the local release gate" >&2
  exit 1
fi

echo "Checking local network audit syntax"
node --check "$ROOT_DIR/web/scripts/beeftv-local-network-audit.mjs"

echo "Checking desktop route isolation"
(
  cd "$ROOT_DIR/backend"
  go test ./internal/handler -run '^TestRegisterDesktopCanvasAPIExcludesHostedOnlyRoutes$' -count=1 -timeout=45s
  go test ./internal/bootstrap -run '^(TestDesktopSchemaExcludesHostedTables|TestDesktopColdOpenBudgetAndNoIdleOutbound)$' -count=1 -timeout=45s
  go test ./internal/provider ./internal/database ./internal/workspace -run '^(TestManifestValidationAndRegistryIsolation|TestSQLitePoolUsesSingleWriterWithoutLockFailures|TestBackupRestoreRoundTrip)$' -count=1 -timeout=45s
)

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required for the local frontend release gate" >&2
  exit 1
fi

echo "Checking local frontend contracts"
(
  cd "$ROOT_DIR/web"
  bun test test/local-generation-pipeline.test.ts test/local-task-events.test.ts test/local-project-library.test.ts
  bun run build
)

echo "Checking default release size budget"
node "$ROOT_DIR/scripts/report-beeftv-release-size.mjs" "$ROOT_DIR/web/dist"

echo "Checking repository diff"
git -C "$ROOT_DIR" diff --check

dependency_count="$(cd "$ROOT_DIR/backend" && go list -deps ./cmd/desktop | sort -u | wc -l | tr -d ' ')"
source_kib="$(du -sk "$ROOT_DIR/backend/internal" "$ROOT_DIR/web/src" | awk '{total += $1} END {print total}')"
echo "Local metrics: go_dependencies=$dependency_count source_kib=$source_kib"

echo "BeefTV local release gate passed"
