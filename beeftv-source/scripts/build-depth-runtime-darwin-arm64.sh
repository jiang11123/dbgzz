#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOL_DIR="$ROOT_DIR/tools/depth-capture"
OUTPUT_DIR="${1:-$ROOT_DIR/build/depth-runtime}"
STAGE_DIR="$(mktemp -d /tmp/beeftv-depth-runtime.XXXXXX)"
RUNTIME_STAGE="$STAGE_DIR/runtime"
VDA_COMMIT="4f5ae23172ba60fd7bc11ef671cca678842c7072"
MODEL_SHA256="13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609"
MODEL_SIZE="116440756"
MODEL_NAME="video_depth_anything_vits.pth"
ARCHIVE_NAME="beeftv-depth-runtime-v1-darwin-arm64.zip"

trap 'rm -rf "$STAGE_DIR"' EXIT

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This builder requires an Apple Silicon Mac" >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to build the optional depth runtime" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR" "$RUNTIME_STAGE/.venv/lib/python3.11" "$RUNTIME_STAGE/.venv/bin" "$RUNTIME_STAGE/worker"
(
  cd "$TOOL_DIR"
  uv sync --python 3.11 --frozen
)

PYTHON_BIN="$(cd "$TOOL_DIR" && uv run python -c 'import sys; print(sys.executable)')"
PYTHON_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$PYTHON_BIN")"
PYTHON_ROOT="$(cd "$(dirname "$PYTHON_REAL")/.." && pwd)"
rsync -aL --exclude='__pycache__' "$PYTHON_ROOT/" "$RUNTIME_STAGE/.python/"
rsync -aL --exclude='__pycache__' --exclude='*.pyc' "$TOOL_DIR/.venv/lib/python3.11/site-packages/" "$RUNTIME_STAGE/.venv/lib/python3.11/site-packages/"
rsync -a --exclude='__pycache__' --exclude='*.pyc' "$TOOL_DIR/depth_capture/" "$RUNTIME_STAGE/worker/depth_capture/"

printf '%s\n' \
  '#!/bin/sh' \
  'RUNTIME_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"' \
  'export PYTHONPATH="$RUNTIME_DIR/.venv/lib/python3.11/site-packages${PYTHONPATH:+:$PYTHONPATH}"' \
  'exec "$RUNTIME_DIR/.python/bin/python3.11" "$@"' \
  > "$RUNTIME_STAGE/.venv/bin/python"
chmod 0750 "$RUNTIME_STAGE/.venv/bin/python"

if [[ -n "${BEEFTV_VDA_SOURCE_DIR:-}" ]]; then
  if [[ "$(git -C "$BEEFTV_VDA_SOURCE_DIR" rev-parse HEAD)" != "$VDA_COMMIT" ]]; then
    echo "BEEFTV_VDA_SOURCE_DIR is not at the required commit $VDA_COMMIT" >&2
    exit 1
  fi
  rsync -a "$BEEFTV_VDA_SOURCE_DIR/" "$STAGE_DIR/vda-repo/"
else
  git -c http.version=HTTP/1.1 clone --filter=blob:none --no-checkout https://github.com/DepthAnything/Video-Depth-Anything.git "$STAGE_DIR/vda-repo"
  git -C "$STAGE_DIR/vda-repo" checkout "$VDA_COMMIT"
fi
rsync -a --exclude='.git' --exclude='checkpoints' --exclude='outputs' "$STAGE_DIR/vda-repo/" "$RUNTIME_STAGE/vda/"

cp "$STAGE_DIR/vda-repo/LICENSE" "$RUNTIME_STAGE/LICENSE-Video-Depth-Anything" 2>/dev/null || true
printf '%s\n' "$VDA_COMMIT" > "$RUNTIME_STAGE/VDA_COMMIT"

"$RUNTIME_STAGE/.venv/bin/python" -c 'import torch, cv2, numpy; print(torch.__version__)'
(
  cd "$RUNTIME_STAGE"
  ditto -c -k --norsrc . "$OUTPUT_DIR/$ARCHIVE_NAME"
)

RUNTIME_SIZE="$(stat -f '%z' "$OUTPUT_DIR/$ARCHIVE_NAME")"
RUNTIME_SHA256="$(shasum -a 256 "$OUTPUT_DIR/$ARCHIVE_NAME" | awk '{print $1}')"
RUNTIME_FILES="$(python3 -c 'import sys,zipfile; print(len(zipfile.ZipFile(sys.argv[1]).infolist()))' "$OUTPUT_DIR/$ARCHIVE_NAME")"
RUNTIME_EXPANDED_SIZE="$(python3 -c 'import sys,zipfile; print(sum(item.file_size for item in zipfile.ZipFile(sys.argv[1]).infolist()))' "$OUTPUT_DIR/$ARCHIVE_NAME")"
printf '{\n  "version": 1,\n  "runtime": {\n    "urls": ["https://github.com/glanderness/BeefTV/releases/download/v1.5.5/%s"],\n    "size": %s,\n    "sha256": "%s",\n    "files": %s,\n    "expandedSize": %s\n  },\n  "model": {\n    "urls": [\n      "https://github.com/glanderness/BeefTV/releases/download/v1.5.5/%s",\n      "https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/main/%s"\n    ],\n    "size": %s,\n    "sha256": "%s"\n  }\n}\n' \
  "$ARCHIVE_NAME" "$RUNTIME_SIZE" "$RUNTIME_SHA256" "$RUNTIME_FILES" "$RUNTIME_EXPANDED_SIZE" "$MODEL_NAME" "$MODEL_NAME" "$MODEL_SIZE" "$MODEL_SHA256" \
  > "$OUTPUT_DIR/depth-runtime-manifest.json"

echo "Runtime: $OUTPUT_DIR/$ARCHIVE_NAME"
echo "Manifest: $OUTPUT_DIR/depth-runtime-manifest.json"
