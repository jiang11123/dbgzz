#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

for private_path in \
  docs/adr \
  docs/design \
  docs/superpowers \
  docs/content/docs/progress
do
  if [ -e "$private_path" ]; then
    echo "internal documentation leaked into public tree: $private_path" >&2
    exit 1
  fi
done

node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const roots = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md", "docs", "web/src/components/ui/README.md"];
const files = [];

function collect(entry) {
  if (!fs.existsSync(entry)) return;
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(entry)) collect(path.join(entry, child));
    return;
  }
  if (/\.(?:md|mdx)$/i.test(entry)) files.push(entry);
}

for (const root of roots) collect(root);

const failures = [];
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const links = source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (!rawTarget || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(rawTarget)) continue;
    const target = decodeURIComponent(rawTarget.split("#", 1)[0].split("?", 1)[0]);
    if (!target) continue;
    const candidates = [];
    if (target.startsWith("/docs/")) {
      const route = target.slice("/docs/".length);
      candidates.push(path.resolve("docs/content/docs", route));
    } else if (target.startsWith("/images/")) {
      candidates.push(path.resolve("docs/public", target.slice(1)));
    } else {
      candidates.push(path.resolve(path.dirname(file), target));
    }
    const expanded = candidates.flatMap((candidate) => [candidate, `${candidate}.md`, `${candidate}.mdx`]);
    if (!expanded.some((candidate) => fs.existsSync(candidate))) failures.push(`${file}: ${rawTarget}`);
  }
}

if (failures.length) {
  console.error("broken local documentation links:\n" + failures.join("\n"));
  process.exit(1);
}

console.log(`public documentation audit passed (${files.length} files)`);
NODE
