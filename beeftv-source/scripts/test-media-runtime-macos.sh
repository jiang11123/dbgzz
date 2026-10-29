#!/usr/bin/env bash
set -euo pipefail
runtime="${1:?usage: test-media-runtime-macos.sh media-runtime-directory}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/beeftv-probe-test.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
# Relocate the real runtime beside test binaries at both GUI and CLI positions.
bundle="$scratch/中文 bundle fixture/Contents"
mkdir -p "$bundle/MacOS/cli" "$bundle/Resources/agent-host"
cp -R "$runtime" "$bundle/Resources/agent-host/media-runtime"
(
  cd "$root/backend"
  go test -c ./internal/asset -o "$bundle/MacOS/BeefTV"
  go test -c ./internal/mediatools -o "$bundle/MacOS/MediaProbe"
)
for executable in "$bundle/MacOS/BeefTV" "$bundle/MacOS/cli/beeftv"; do
  if [[ "$executable" == */cli/beeftv ]]; then cp "$bundle/MacOS/BeefTV" "$executable"; fi
  env -u CANVAS_FFPROBE_PATH PATH=/usr/bin:/bin:/usr/sbin:/sbin BEEFTV_TEST_BUNDLED_MEDIA=1 \
    "$executable" -test.run '^TestBundledMediaMetadataWithoutSystemFFprobe$' -test.v
done
env -u CANVAS_FFPROBE_PATH PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$bundle/MacOS/MediaProbe" -test.run '^TestProbeLocalDoesNotFetchPlaylistURLs$' -test.v
