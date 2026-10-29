#!/bin/sh

set -eu

if [ "$#" -ne 2 ]; then
    echo "usage: $0 SOURCE_DIRECTORY DESTINATION_DIRECTORY" >&2
    exit 64
fi

source_directory=${1%/}
destination_directory=${2%/}

if [ ! -d "$source_directory" ]; then
    echo "source directory does not exist: $source_directory" >&2
    exit 66
fi

if [ -e "$destination_directory" ]; then
    echo "destination already exists: $destination_directory" >&2
    exit 73
fi

for required_file in README.md LICENSE NOTICE backend/go.mod web/package.json; do
    if [ ! -f "$source_directory/$required_file" ]; then
        echo "source is missing required file: $required_file" >&2
        exit 65
    fi
done

mkdir -p "$destination_directory"

rsync -a \
    --exclude='.git/' \
    --exclude='.worktrees/' \
    --exclude='.playwright-mcp/' \
    --exclude='.superpowers/' \
    --exclude='.DS_Store' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='.libtv-*' \
    --exclude='artifacts/' \
    --exclude='test-evidence/' \
    --exclude='data/' \
    --exclude='backend/data/' \
    --exclude='backend/.local/' \
    --exclude='backend/server' \
    --exclude='backend/cmd/desktop/build/' \
    --include='backend/cmd/desktop/frontend/dist/' \
    --include='backend/cmd/desktop/frontend/dist/.gitkeep' \
    --exclude='backend/cmd/desktop/frontend/dist/***' \
    --exclude='backend/desktop' \
    --exclude='backend/desktop/' \
    --exclude='backend/frontend/dist/' \
    --exclude='web/node_modules/' \
    --exclude='web/dist/' \
    --exclude='web/.playwright/' \
    --exclude='web/.libtv-*' \
    --exclude='web/.round-*' \
    --exclude='web/.smoke-*' \
    --exclude='web/.probe-*' \
    --exclude='web/.gated-*' \
    --exclude='web/.path*' \
    --exclude='web/.selected*' \
    --exclude='web/.threshold*' \
    --exclude='web/.count-*' \
    --exclude='web/.dense-*' \
    --exclude='web/.directional-*' \
    --exclude='web/.director-*' \
    --exclude='web/.final-*' \
    --exclude='web/.oneendpoint-*' \
    --exclude='web/.panfix-*' \
    --exclude='web/.reference-*' \
    --exclude='web/.canvas-probe-*' \
    --exclude='web/test/.agent-reliability-*' \
    --include='web/scripts/beeftv-local-network-audit.mjs' \
    --exclude='web/scripts/*audit*' \
    --exclude='web/scripts/*probe*' \
    --exclude='web/scripts/*smoke*' \
    --exclude='web/scripts/*persistent-playwright*' \
    --exclude='docs/public-release/internal-backup-manifest.md' \
    --exclude='docs/superpowers/' \
    --exclude='docs/audits/' \
    --exclude='docs/plans/' \
    --exclude='docs/visual-regression/' \
    --exclude='plugin-packages/*.beeftv-plugin' \
    --exclude='plugin-packages/official-payment-*' \
    --exclude='*.db' \
    --exclude='*.db-*' \
    --exclude='*.sqlite' \
    --exclude='*.sqlite3' \
    --exclude='*.log' \
    --exclude='*.app' \
    --exclude='*.dmg' \
    --exclude='*.tmp' \
    --exclude='*.bak' \
    "$source_directory/" "$destination_directory/"

printf 'exported BeefTV public source to %s\n' "$destination_directory"
