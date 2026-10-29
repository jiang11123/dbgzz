# 豆奶画布源码构建

宿主源码在 `src/`，画布和后端在 `beeftv-source/`。`BEEFTV_SOURCE_DIR` 可指定另一份对应源码；本地兼容已有的同级 `doubao3.0` 开发目录。发布者应显式指定所用源码，避免构建其他目录的旧产物。

## 准备依赖

- Node.js 22、npm、Bun。
- Go 1.25+，以及支持 CGO 的 gcc/clang；`go-sqlite3` 需要 C 编译器。
- 用 `npm ci` 安装宿主依赖；在 `beeftv-source/web` 用 `bun install --frozen-lockfile` 安装前端依赖，不用 npm 改写其 Bun 锁文件。
- Agent 源码和锁文件在 `beeftv-source/agent-host`。打包工具见 `beeftv-source/scripts/package-agent-host.mjs`，其 Windows Node 运行时由 `BEEFTV_NODE_RUNTIME` 指定，版本须符合脚本钉选值。媒体运行时按 `beeftv-source/licenses/ffmpeg-windows.json` 准备并保留许可。
- 宿主要求 `build/agent-host/runtime/node.exe`、`server.mjs` 和依赖目录，以及对应媒体运行时。构建脚本可复用本机已准备的 BeefTV Agent 运行时；首次从源码构建需先按上述脚本准备。仓库不携带作者机器的运行环境或数据。

## 构建

```powershell
$env:BEEFTV_SOURCE_DIR = (Resolve-Path .\beeftv-source).Path
npm run build:beeftv
npm run build
npm run typecheck
npm test
```

`build:beeftv` 生成 Go 后端、CLI、协议包、Agent 依赖压缩包与 `build/beeftv-web` 前端。缺少 Go、Agent 或前端依赖时请先补齐，不能把缺组件产物作为完整安装包发布。

Windows 上可通过 `BEEFTV_7ZA` 指定已安装的 7-Zip 命令行程序，加快 Agent 依赖压缩；未指定时使用 PowerShell `Compress-Archive`。

```powershell
npm run package:win
```

安装包及更新文件输出到 `release/`。上传前按 [发布说明](automatic-updates.md) 核对版本、哈希和安装升级行为。发布记录应区分单元测试、构建成功、真实账号生成和跨版本安装验收。
