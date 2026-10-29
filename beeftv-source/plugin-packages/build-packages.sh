#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

node "$root_dir/embed-documentation.mjs"

package_plugin() {
  package_id=$1
  package_dir="$root_dir/$package_id"
  output_file="$root_dir/$package_id.beeftv-plugin"
  temporary_file="$root_dir/.$package_id.beeftv-plugin.tmp"
  rm -f "$temporary_file"
  (
    cd "$package_dir"
    find manifest.json README.md docs assets web backend LICENSE -type f 2>/dev/null | LC_ALL=C sort | zip -X -q "$temporary_file" -@
  )
  mv "$temporary_file" "$output_file"
}

for manifest in "$root_dir"/*/manifest.json; do
  package_dir=${manifest%/manifest.json}
  package_id=${package_dir##*/}
  package_plugin "$package_id"
done
