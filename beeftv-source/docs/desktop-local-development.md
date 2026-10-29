# BeefTV 本地桌面开发与验收

BeefTV 的桌面版是 Wails 应用：前端运行在 WebView，Go 后端在同一进程内启动一个仅监听 `127.0.0.1` 的 loopback API。桌面 profile 不注册交互式登录路由，首次启动通过 `/api/workspace/bootstrap` 创建或读取本地工作区。

## 数据位置

默认数据目录由 Go 的 `os.UserConfigDir()` 决定，最终目录为 `<系统用户配置目录>/BeefTV`。Windows 上是 `%AppData%\BeefTV`，macOS 上是 `~/Library/Application Support/BeefTV`。

其中包含本地 SQLite 数据库、资源文件和迁移备份。验收或调试时可通过环境变量指定隔离目录：

```bash
CANVAS_DESKTOP_DATA_DIR="$(mktemp -d /tmp/beeftv-data.XXXXXX)" \
  backend/cmd/desktop/build/bin/BeefTV.app/Contents/MacOS/BeefTV
```

Windows：

```powershell
$env:CANVAS_DESKTOP_DATA_DIR = Join-Path $env:TEMP "beeftv-data"
backend\cmd\desktop\build\bin\BeefTV.exe
```

这个变量只改变数据目录，不改变应用的本地工作区和无登录行为。官方插件仍然从可执行文件旁边的 `plugin-packages\` 加载，不跟数据目录走。

## 开发与构建

统一浏览器预览与 Wails dev（共用 `web/src`、Vite `3000` 和本地 Go API `8080`）：

```bash
./scripts/beeftv-shared-dev.sh
```

脚本会为本次开发会话生成一个临时桌面令牌，并让 Vite 代理自动转发到同一个 Go 后端；生产包仍使用随机令牌和动态 loopback 端口。

前端检查：

```bash
cd web
bun test test/local-workspace-bootstrap.test.ts test/local-project-library.test.ts test/local-generation-pipeline.test.ts
bun run build
```

后端检查：

```bash
cd backend
go test ./internal/bootstrap ./internal/handler ./cmd/desktop -count=1
```

构建 macOS 桌面包：

```bash
cd backend/cmd/desktop
go run github.com/wailsapp/wails/v2/cmd/wails@v2.16.0 build -clean -m -nosyncgomod
```

产物位于：

```text
backend/cmd/desktop/build/bin/BeefTV.app
```

## 手工验收清单

1. 启动新数据目录，首页直接进入本地工作区，不出现登录/注册页面。
2. 创建画布，添加节点并保存；退出后使用同一数据目录重启，项目和节点仍存在。
3. 打开项目库，验证搜索、文件夹、重命名、移动、回收站恢复、ZIP 导入导出。
4. 打开“创作历史”，确认 `/tasks` 请求在无登录 Cookie 下返回成功。
5. 配置一个可用模型后，再验证生成任务的提交、轮询、结果写回画布和重启恢复。

桌面 profile 还会对共享画布和 Agent 入口做本地模式适配：共享画布返回本地工作区，Agent 不把登录 Cookie 当作本地工作区的启动条件。

## 原生窗口路由

Wails 2.16 生产包只把 `/` 和 `index.html` 交给前端运行时；深路径（例如 `/canvas/:id`）会落到资源 handler 并返回 404。原生窗口因此使用 hash 路由：刷新仍请求 `/`，画布地址形如 `/#/canvas/<id>`。浏览器部署继续使用 History 路径，`/api` 与媒体地址不进入 hash。

## 最近一次验收

- 统一开发脚本已验证：Wails 日志显示 `Frontend DevServer URL: http://127.0.0.1:3000`；浏览器代理和后端直连的 `/api/health/live` 返回相同 `dev` 构建信息；`/api/workspace/bootstrap` 经浏览器代理返回 HTTP 200。

- Wails 2.16.0 生产包已重新构建并自签名，产物为 `backend/cmd/desktop/build/bin/BeefTV.app`。
- `go test ./internal/handler ./internal/bootstrap ./cmd/desktop -count=1` 通过。
- 协议定向测试通过。
- 重新打开 `.app` 后，桌面进程正常运行并进入本地工作区；手工创建“本地验收画布”、退出并重启后，项目库仍显示该画布，且显示“已加载全部 2 个画布”。

模型 API Key 只在本地工作区配置中使用；当前仓库不提供默认 Key，也不会把 Key 写入代码或测试夹具。
