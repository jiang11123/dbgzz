#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: $0 PUBLIC_SOURCE_DIRECTORY" >&2
    exit 64
fi

root=${1%/}
if [ ! -d "$root" ]; then
    echo "public source directory does not exist: $root" >&2
    exit 66
fi

failed=0

report_forbidden() {
    echo "forbidden public-release path: $1" >&2
    failed=1
}

for required_file in README.md LICENSE NOTICE backend/go.mod web/package.json; do
    if [ ! -f "$root/$required_file" ]; then
        echo "missing required public-release file: $required_file" >&2
        failed=1
    fi
done

find "$root" -mindepth 1 \( -path "$root/.git" -o -path "$root/.git/*" \) -prune -o -print | while IFS= read -r path; do
    relative=${path#"$root"/}
    case "/$relative/" in
        */.worktrees/*|*/.playwright-mcp/*|*/web/.playwright/*|*/artifacts/*|*/test-evidence/*|*/data/*|*/backend/data/*|*/backend/cmd/desktop/build/*)
            printf '%s\n' "$relative"
            ;;
    esac
done > "${TMPDIR:-/tmp}/beeftv-public-audit-forbidden-$$"

while IFS= read -r relative; do
    [ -n "$relative" ] && report_forbidden "$relative"
done < "${TMPDIR:-/tmp}/beeftv-public-audit-forbidden-$$"
rm -f "${TMPDIR:-/tmp}/beeftv-public-audit-forbidden-$$"

find "$root" \( -path "$root/.git" -o -path "$root/.git/*" \) -prune -o -type f -print | while IFS= read -r path; do
    relative=${path#"$root"/}
    basename=${relative##*/}
    case "$relative" in
        backend/server|backend/desktop|plugin-packages/*.beeftv-plugin)
            printf '%s\n' "$relative"
            continue
            ;;
    esac
    case "$basename" in
        *.db|*.db-*|*.sqlite|*.sqlite3|*.log|*.app|*.dmg|*.p12|*.mobileprovision|*.pem|*.key)
            printf '%s\n' "$relative"
            ;;
    esac
done > "${TMPDIR:-/tmp}/beeftv-public-audit-files-$$"

while IFS= read -r relative; do
    [ -n "$relative" ] && report_forbidden "$relative"
done < "${TMPDIR:-/tmp}/beeftv-public-audit-files-$$"
rm -f "${TMPDIR:-/tmp}/beeftv-public-audit-files-$$"

if grep -RIEIl \
    --exclude='bun.lock' \
    --exclude-dir='.git' \
    --exclude='*.png' --exclude='*.jpg' --exclude='*.jpeg' --exclude='*.gif' \
    --exclude='*.wasm' --exclude='*.mp4' \
    'BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}' \
    "$root" > "${TMPDIR:-/tmp}/beeftv-public-audit-secrets-$$" 2>/dev/null; then
    while IFS= read -r path; do
        report_forbidden "possible secret: ${path#"$root"/}"
    done < "${TMPDIR:-/tmp}/beeftv-public-audit-secrets-$$"
fi
rm -f "${TMPDIR:-/tmp}/beeftv-public-audit-secrets-$$"

if grep -RIEIl \
    --exclude-dir='.git' \
    --exclude='*.png' --exclude='*.jpg' --exclude='*.jpeg' --exclude='*.gif' \
    --exclude='*.wasm' --exclude='*.mp4' \
    '/Users/[A-Za-z0-9._-]+/|/home/[A-Za-z0-9._-]+/' \
    "$root" > "${TMPDIR:-/tmp}/beeftv-public-audit-paths-$$" 2>/dev/null; then
    while IFS= read -r path; do
        report_forbidden "absolute developer path: ${path#"$root"/}"
    done < "${TMPDIR:-/tmp}/beeftv-public-audit-paths-$$"
fi
rm -f "${TMPDIR:-/tmp}/beeftv-public-audit-paths-$$"

if [ "$failed" -ne 0 ]; then
    exit 1
fi

echo "public release audit passed: $root"
