#!/bin/sh
set -eu

root=${1:-.}
notice="$root/THIRD_PARTY_NOTICES.md"
package="$root/web/package.json"

test -f "$notice"
test -f "$package"

node - "$package" "$notice" <<'NODE'
const fs = require("node:fs");
const [packagePath, noticePath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const notice = fs.readFileSync(noticePath, "utf8");
const missing = Object.keys(manifest.dependencies || {}).filter((name) => !notice.includes(`\`${name}\``));
if (missing.length) {
  console.error(`direct frontend dependencies missing from THIRD_PARTY_NOTICES.md: ${missing.join(", ")}`);
  process.exit(1);
}
NODE

for module in \
  github.com/gin-gonic/gin \
  github.com/google/uuid \
  github.com/volcengine/volc-sdk-golang \
  github.com/wailsapp/wails/v2 \
  golang.org/x/net \
  golang.org/x/sync \
  golang.org/x/sys \
  gorm.io/driver/sqlite \
  gorm.io/gorm
do
  grep -Fq "\`$module\`" "$notice" || {
    echo "direct Go dependency missing from THIRD_PARTY_NOTICES.md: $module" >&2
    exit 1
  }
done

for path in \
  web/public/mediapipe/wasm \
  web/public/three/basis \
  web/public/canvas/models/blaze-face-full-range-sparse.tflite \
  web/public/canvas/models/facecap.glb \
  web/public/welcome/credits.html
do
  test -e "$root/$path"
  grep -Fq "\`$path" "$notice" || {
    echo "bundled asset missing from THIRD_PARTY_NOTICES.md: $path" >&2
    exit 1
  }
done

if find "$root" -path '*/node_modules' -prune -o -iname '*tldraw*' -print | grep -q .; then
  echo "tldraw residue remains in the public source snapshot" >&2
  exit 1
fi

echo "third-party notice audit passed: $root"
