#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/backend/cmd/desktop"
GO_DIR="${BEEFTV_GO_DIR:-/tmp/beeftv-go.rpIfVN/go}"

HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
AGENT_TARGET="${BEEFTV_WAILS_PLATFORM:-$HOST_OS/$(uname -m)}"
[[ "$AGENT_TARGET" != "darwin/x86_64" ]] || AGENT_TARGET="darwin/amd64"
[[ "$AGENT_TARGET" != "linux/x86_64" ]] || AGENT_TARGET="linux/amd64"
if [[ "$AGENT_TARGET" == linux/* && ( "$HOST_OS" != linux || "$AGENT_TARGET" != linux/amd64 || "$(uname -m)" != x86_64 ) ]]; then
  echo "Linux releases require a native Linux x64 host" >&2
  exit 1
fi
bun "$ROOT_DIR/scripts/package-agent-host.mjs" "$AGENT_TARGET" --verify-runtime

if [[ ! -f "$ROOT_DIR/VERSION" ]]; then
  echo "VERSION file is required" >&2
  exit 1
fi

VERSION_VALUE="$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")"
if [[ ! "$VERSION_VALUE" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid VERSION: $VERSION_VALUE" >&2
  exit 1
fi

if ! command -v go >/dev/null 2>&1 && [[ -x "$GO_DIR/bin/go" ]]; then
  export PATH="$GO_DIR/bin:$PATH"
fi

if ! command -v go >/dev/null 2>&1; then
  echo "Go is required (set BEEFTV_GO_DIR when using a bundled toolchain)" >&2
  exit 1
fi

# Use the shared size gate default; an explicit BEEFTV_WEB_BUDGET_MIB override
# applies consistently to local and CI builds.

if [[ "${BEEFTV_SKIP_LOCAL_VERIFY:-}" != "1" ]]; then
  "$ROOT_DIR/scripts/verify-beeftv-local-release.sh"
fi

COMMIT_VALUE="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME_VALUE="${CANVAS_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export CANVAS_BUILD_VERSION="$VERSION_VALUE"
export BEEFTV_DIST_PLATFORM="${AGENT_TARGET/\//-}"
export GOTOOLCHAIN="${GOTOOLCHAIN:-local}"

LDFLAGS="-X infinite-canvas/backend/internal/buildinfo.Version=$VERSION_VALUE -X infinite-canvas/backend/internal/buildinfo.Commit=$COMMIT_VALUE -X infinite-canvas/backend/internal/buildinfo.BuildTime=$BUILD_TIME_VALUE"
if [[ -n "${BEEFTV_UPDATER_PUBLIC_KEY:-}" ]]; then
  UPDATER_LDFLAGS="$(
    cd "$ROOT_DIR/backend"
    go run ./cmd/update-release print-ldflags
  )"
  LDFLAGS="$LDFLAGS $UPDATER_LDFLAGS"
fi
if [[ -n "${BEEFTV_EXTRA_LDFLAGS:-}" ]]; then
  LDFLAGS="$LDFLAGS $BEEFTV_EXTRA_LDFLAGS"
fi

if [[ -n "${BEEFTV_WAILS_PLATFORM:-}" ]]; then
  host_arch="$(uname -m)"
  case "$BEEFTV_WAILS_PLATFORM" in
    darwin/amd64)
      if [[ "$host_arch" == "arm64" ]]; then
        export CGO_ENABLED=1
        export CGO_CFLAGS="${CGO_CFLAGS:+$CGO_CFLAGS }-arch x86_64"
        export CGO_LDFLAGS="${CGO_LDFLAGS:+$CGO_LDFLAGS }-arch x86_64"
      fi
      ;;
    darwin/arm64)
      if [[ "$host_arch" == "x86_64" ]]; then
        export CGO_ENABLED=1
        export CGO_CFLAGS="${CGO_CFLAGS:+$CGO_CFLAGS }-arch arm64"
        export CGO_LDFLAGS="${CGO_LDFLAGS:+$CGO_LDFLAGS }-arch arm64"
      fi
      ;;
  esac
fi

echo "Building BeefTV $VERSION_VALUE ($COMMIT_VALUE)"

# The frontend embeds the source index, so the native packet must exist before
# Wails builds it. Keep the runtime outside Wails' -clean output directory.
if [[ "$AGENT_TARGET" == darwin/* ]]; then
  MEDIA_RUNTIME_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/beeftv-release-media.XXXXXX")"
  trap 'rm -rf "$MEDIA_RUNTIME_STAGE"' EXIT
  if [[ -n "${BEEFTV_MEDIA_RUNTIME:-}" ]]; then
    bun -e 'const fs=require("fs"),crypto=require("crypto");const [root,target]=process.argv.slice(1);const m=JSON.parse(fs.readFileSync(root+"/manifest.json","utf8"));if(m.target!==target||crypto.createHash("sha256").update(fs.readFileSync(root+"/ffprobe")).digest("hex")!==m.probeSHA256)throw Error("Media runtime target or checksum mismatch")' "$BEEFTV_MEDIA_RUNTIME" "$AGENT_TARGET"
    cp -R "$BEEFTV_MEDIA_RUNTIME" "$MEDIA_RUNTIME_STAGE/media-runtime"
  else
    bash "$ROOT_DIR/scripts/package-media-runtime-macos.sh" "$AGENT_TARGET" \
      "$MEDIA_RUNTIME_STAGE/media-runtime" "" \
      "$ROOT_DIR/dist/BeefTV-${VERSION_VALUE}-ffprobe-${AGENT_TARGET/\//-}-sources.tar.gz"
  fi
fi

mkdir -p "$DESKTOP_DIR/build"
cp "$ROOT_DIR/assets/app-icon.png" "$DESKTOP_DIR/build/appicon.png"

(
  cd "$DESKTOP_DIR"
  if [[ "$AGENT_TARGET" == linux/amd64 ]]; then
    go run github.com/wailsapp/wails/v2/cmd/wails@v2.16.0 build \
      -clean -trimpath -platform linux/amd64 -tags webkit2_41 -ldflags "$LDFLAGS"
  elif [[ -n "${BEEFTV_WAILS_PLATFORM:-}" ]]; then
    go run github.com/wailsapp/wails/v2/cmd/wails@v2.16.0 build \
      -clean \
      -trimpath \
      -platform "$BEEFTV_WAILS_PLATFORM" \
      -ldflags "$LDFLAGS"
  else
    go run github.com/wailsapp/wails/v2/cmd/wails@v2.16.0 build \
      -clean \
      -trimpath \
      -ldflags "$LDFLAGS"
  fi
)

if [[ "$AGENT_TARGET" == linux/amd64 ]]; then
  LINUX_BUNDLE="$DESKTOP_DIR/build/bin/BeefTV-linux"
  mkdir -p "$LINUX_BUNDLE/plugin-packages" "$LINUX_BUNDLE/cli"
  mv "$DESKTOP_DIR/build/bin/BeefTV" "$LINUX_BUNDLE/BeefTV"
  cp "$ROOT_DIR/plugin-packages/"*.beeftv-plugin "$LINUX_BUNDLE/plugin-packages/"
  cp "$ROOT_DIR/docs/linux-install.md" "$LINUX_BUNDLE/README.md"
  bun "$ROOT_DIR/scripts/package-agent-host.mjs" "$AGENT_TARGET" "$LINUX_BUNDLE/agent-host"
  bun "$ROOT_DIR/scripts/distribution-notices.mjs" "${AGENT_TARGET/\//-}" "$LINUX_BUNDLE/agent-host/licenses" "$VERSION_VALUE"
  (
    cd "$ROOT_DIR/backend"
    go build -trimpath -ldflags "$LDFLAGS" -o "$LINUX_BUNDLE/cli/beeftv" ./cmd/beeftv
  )
  chmod 755 "$LINUX_BUNDLE/BeefTV" "$LINUX_BUNDLE/cli/beeftv"
  echo "Release bundle: $LINUX_BUNDLE"
  exit 0
fi

# Official protocol packages are runtime dependencies. Finder launches use the
# bundle Resources directory and must never depend on the caller's cwd.
APP_BUNDLE="$DESKTOP_DIR/build/bin/BeefTV.app"
PLUGIN_RESOURCE_DIR="$APP_BUNDLE/Contents/Resources/plugin-packages"
mkdir -p "$PLUGIN_RESOURCE_DIR"
cp "$ROOT_DIR/plugin-packages/"*.beeftv-plugin "$PLUGIN_RESOURCE_DIR/"

bun "$ROOT_DIR/scripts/package-agent-host.mjs" "$AGENT_TARGET" \
  "$APP_BUNDLE/Contents/Resources/agent-host"
cp -R "$MEDIA_RUNTIME_STAGE/media-runtime" "$APP_BUNDLE/Contents/Resources/agent-host/media-runtime"
bun "$ROOT_DIR/scripts/distribution-notices.mjs" "${AGENT_TARGET/\//-}" \
  "$APP_BUNDLE/Contents/Resources/agent-host/licenses" "$VERSION_VALUE"
# Reuse the explicitly supplied (or already installed) encoder, including its
# license. The native workflow adapter must not rely on a Finder-launched PATH.
ENCODER_SOURCE="${BEEFTV_FFMPEG_RUNTIME:-/Applications/BeefTV.app/Contents/Resources/agent-host/media-runtime/ffmpeg}"
if [[ -x "$ENCODER_SOURCE" ]]; then
  ENCODER_LICENSE="${BEEFTV_FFMPEG_LICENSE:-$(dirname "$ENCODER_SOURCE")/ffmpeg.LICENSE}"
  [[ -f "$ENCODER_LICENSE" ]] || { echo "Encoder license missing: $ENCODER_LICENSE" >&2; exit 1; }
  ENCODER_ARCH="${AGENT_TARGET##*/}"
  [[ "$ENCODER_ARCH" != amd64 ]] || ENCODER_ARCH=x86_64
  file "$ENCODER_SOURCE" | grep -q "$ENCODER_ARCH" || { echo "Wrong encoder architecture" >&2; exit 1; }
  otool -L "$ENCODER_SOURCE" | tail -n +2 | while read -r dylib _; do
    case "$dylib" in /usr/lib/*|/System/Library/*) ;; *) echo "Non-system encoder dependency: $dylib" >&2; exit 1 ;; esac
  done
  ENCODER_DEST="$APP_BUNDLE/Contents/Resources/agent-host/media-runtime"
  cp "$ENCODER_SOURCE" "$ENCODER_DEST/ffmpeg"
  cp "$ENCODER_LICENSE" "$ENCODER_DEST/ffmpeg.LICENSE"
  if [[ -f "$(dirname "$ENCODER_SOURCE")/ffmpeg.README" ]]; then cp "$(dirname "$ENCODER_SOURCE")/ffmpeg.README" "$ENCODER_DEST/ffmpeg.README"; fi
  chmod 755 "$ENCODER_DEST/ffmpeg"
  codesign --force --sign - "$ENCODER_DEST/ffmpeg"
fi
if [[ "$AGENT_TARGET" == "darwin/$(uname -m)" || ( "$AGENT_TARGET" == darwin/amd64 && "$(uname -m)" == x86_64 ) ]]; then
  bash "$ROOT_DIR/scripts/test-media-runtime-macos.sh" "$APP_BUNDLE/Contents/Resources/agent-host/media-runtime"
fi

# The beeftv CLI ships inside the bundle. External agents (Codex, Claude Code,
# Cursor) connect through it with their own client credential, so the installed
# app must carry it -- PATH is not a prerequisite.
#
# It goes in Contents/MacOS/cli, not directly next to the app binary: macOS
# volumes are case-insensitive by default, so a file named beeftv beside BeefTV
# is the same file and would overwrite the app binary.
CLI_BINARY="$APP_BUNDLE/Contents/MacOS/cli/beeftv"
mkdir -p "$(dirname "$CLI_BINARY")"
(
  cd "$ROOT_DIR/backend"
  if [[ -n "${BEEFTV_WAILS_PLATFORM:-}" ]]; then
    GOOS="${BEEFTV_WAILS_PLATFORM%%/*}" GOARCH="${BEEFTV_WAILS_PLATFORM##*/}" \
      go build -trimpath -ldflags "$LDFLAGS" -o "$CLI_BINARY" ./cmd/beeftv
  else
    go build -trimpath -ldflags "$LDFLAGS" -o "$CLI_BINARY" ./cmd/beeftv
  fi
)
if [[ ! -x "$CLI_BINARY" ]]; then
  echo "beeftv CLI was not built into the bundle: $CLI_BINARY" >&2
  exit 1
fi
# Adding a Mach-O binary to Contents/MacOS invalidates the bundle signature.
# Sign the CLI the same ad-hoc way the bundle is signed; the --deep bundle
# signature below then covers it too.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$CLI_BINARY"
fi

# Keep the generated macOS bundle metadata aligned with the repository version.
APP_PLIST="$APP_BUNDLE/Contents/Info.plist"
if [[ -f "$APP_PLIST" ]] && command -v plutil >/dev/null 2>&1; then
  MACOS_VERSION="${VERSION_VALUE#v}"
  MACOS_VERSION="${MACOS_VERSION%%-*}"
  plutil -replace CFBundleShortVersionString -string "$MACOS_VERSION" "$APP_PLIST"
  plutil -replace CFBundleVersion -string "$MACOS_VERSION" "$APP_PLIST"
fi

# The plist edit and the bundled CLI both invalidate Wails' ad-hoc signature;
# sign the final bundle so the local install gate can verify it.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_BUNDLE"
fi

echo "Release bundle: $APP_BUNDLE"
