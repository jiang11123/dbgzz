#!/bin/sh
# 内置创作助手宿主启动器（应用包内）。
#
# 发行形态把 Node 运行时放在本目录的 runtime/ 下，因此不依赖用户机器上的全局 Node。
# 没有随包运行时（例如开发构建）时才回退到 PATH 上的 node，并在缺失时明确报错。
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -x "$HERE/runtime/bin/node" ]; then
  NODE_BIN="$HERE/runtime/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
else
  echo "agent-host: 未找到 Node 运行时（包内 runtime/bin/node 与 PATH 都没有）" >&2
  exit 2
fi

exec "$NODE_BIN" "$HERE/server.mjs"
