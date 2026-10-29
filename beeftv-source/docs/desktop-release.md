# BeefTV 桌面发布

公开发布还须核对[媒体组件的许可与源码交付](media-source-distribution.md)。流水线会附带许可文件和 macOS ffprobe 源码包；预构建组件的完整源码材料仍需分发者落实，不能把构建成功视为已完成全部许可义务。

生产桌面包使用仓库根目录的 `VERSION` 作为唯一版本源。发布脚本会把版本号、当前 Git 提交和 UTC 构建时间同时注入前端与 Go 后端，并生成不依赖 Vite 开发服务器的 Wails 应用包。

带自动更新的生产包还要注入更新源地址和 Ed25519 公钥。密钥、草稿发布、签名清单和回滚语义见下方「桌面自动更新」。`v1.5.2` 及以前的安装包不含更新器，不能靠补发清单给已经装好的二进制补上自动更新。

本地合同检查仍由 `scripts/verify-beeftv-local-release.sh` 负责。macOS 发布脚本会先跑该门禁；Windows 发布脚本只做本机打包，不重复整套门禁。

前端未压缩产物的默认体积上限为 105 MiB，可通过 `BEEFTV_WEB_BUDGET_MIB` 调整。包含 FFmpeg、MediaPipe 和预设资源的主线基线约为 99.24 MiB；自动更新增量约 25 KiB。此上限不是 zip 下载大小。

## macOS

```bash
./scripts/build-beeftv-release.sh
```

如果系统没有全局 Go，可通过 `BEEFTV_GO_DIR` 指定本地工具链目录：

```bash
BEEFTV_GO_DIR=/tmp/beeftv-go.rpIfVN/go ./scripts/build-beeftv-release.sh
```

生产自动更新包需要额外环境变量：

| 变量 | 作用 |
| --- | --- |
| `BEEFTV_UPDATER_PUBLIC_KEY` | 注入更新源公钥；缺省则更新器保持关闭 |
| `BEEFTV_UPDATER_FEED_URL` | 可选，默认官方 `desktop-update.json` 地址 |
| `BEEFTV_WAILS_PLATFORM` | 可选，例如 `darwin/arm64` 或 `darwin/amd64` |
| `BEEFTV_SKIP_LOCAL_VERIFY` | 设为 `1` 时跳过本地门禁；发布流水线的校验作业会跑门禁 |
| `BEEFTV_EXTRA_LDFLAGS` | 追加到 Wails `-ldflags` |

产物：

```text
backend/cmd/desktop/build/bin/BeefTV.app
backend/cmd/desktop/build/bin/BeefTV.app/Contents/Resources/plugin-packages/*.beeftv-plugin
```

验收重点：

- `backend/cmd/desktop/build/bin/BeefTV.app` 存在；
- Wails 将 `frontend/dist` 编译进应用二进制；应用包内应存在 `Contents/MacOS/BeefTV`，并由构建日志确认完成 `Compiling frontend` 与 `Packaging application`；
- macOS `Info.plist` 的 `CFBundleShortVersionString` 和 `CFBundleVersion` 与根目录 `VERSION`（去掉 `v` 前缀）一致；
- `/api/health/live` 与 `/api/system/version` 返回的版本信息来自同一份发布元数据；
- 发布启动不需要 `127.0.0.1:3000` 的 Vite 开发服务器。

## Windows（amd64，必须在 Windows 本机执行）

在仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-beeftv-windows-release.ps1
```

产物：

```text
backend\cmd\desktop\build\bin\BeefTV.exe
backend\cmd\desktop\build\bin\plugin-packages\*.beeftv-plugin
```

官方插件必须和 `BeefTV.exe` 放在同一目录下的 `plugin-packages\`。从开始菜单、快捷方式或资源管理器启动时，工作目录不一定是仓库或 exe 所在目录；应用按可执行文件位置查找官方插件，不依赖当前工作目录。

### 本机前提

脚本发现缺工具就退出，不会安装全局工具，也不会改用户 PATH。

| 前提 | 用途 | 依据 |
| --- | --- | --- |
| Windows 10/11 amd64 | Wails Windows 目标 | [Wails CLI platforms](https://wails.io/docs/reference/cli) |
| Go 1.25 或更新，且在 PATH（或 `BEEFTV_GO_DIR\bin\go.exe`） | 编译桌面后端；`backend/go.mod` 要求 1.25 | 仓库 `backend/go.mod` |
| Bun 在 PATH | `wails.json` 的 `bun install --frozen-lockfile` 与 `bun run build:desktop` | 仓库 `backend/cmd/desktop/wails.json` |
| `CGO_ENABLED` 不能是 `0` | `gorm.io/driver/sqlite` 依赖 `github.com/mattn/go-sqlite3` | [go-sqlite3 README](https://github.com/mattn/go-sqlite3#windows) |
| PATH 中的 `gcc`/`clang`，或可执行的 `CC` | 编译 go-sqlite3。Go 1.25 起 Windows CGO 需要支持 DWARF 5 的 GCC（binutils 2.37 或更新） | [go-sqlite3 Windows](https://github.com/mattn/go-sqlite3#windows)、[Go Minimum Requirements · cgo](https://go.dev/wiki/MinimumRequirements#cgo) |
| 已有 `plugin-packages/*.beeftv-plugin`，或能现场打包 | 官方协议包是运行时依赖 | 仓库 `plugin-packages/build-packages.sh` |
| Microsoft WebView2 Runtime | 运行 Wails 窗口。Windows 11 通常已安装 | [Wails Windows](https://wails.io/docs/guides/windows)、[Wails installation](https://wails.io/docs/gettingstarted/installation) |

现场打包官方插件时的顺序：

1. 若已有 `plugin-packages/*.beeftv-plugin`，直接使用；
2. 否则若本机有 `bash`、`zip` 和 `node`，调用现有 `plugin-packages/build-packages.sh`；
3. 否则用 Bun 或 Node 运行 `plugin-packages/embed-documentation.mjs`，再用 PowerShell 写出带正斜杠路径的 zip。反斜杠路径会被插件校验拒绝。

构建使用与 macOS 相同的 Wails 模块 `github.com/wailsapp/wails/v2/cmd/wails@v2.16.0`，并显式传入 `-platform windows/amd64`、`-webview2 download`。Wails 把生产二进制写到 `build/bin`。缺少 WebView2 时，下载策略会提示安装官方 bootstrapper。

本脚本不生成 NSIS 安装包。Wails 的 `-nsis` 需要另装 NSIS，且默认安装脚本是否包含 `plugin-packages\` 未经本仓库验证。当前支持的发布形态是：把 `BeefTV.exe` 和旁边的 `plugin-packages\` 一起分发。

### NSIS 安装包

`scripts/package-desktop-installer.py --platform windows-amd64` 调用 `scripts/installers/windows.nsi`，把 `BeefTV.exe`、`plugin-packages\`、`agent-host\`、`cli\`、`media-runtime\` 等载荷打成 `BeefTV-vX.Y.Z-windows-amd64-setup.exe`。

- 安装位置可选。默认 `%LOCALAPPDATA%\Programs\BeefTV`；覆盖安装默认沿用上一次的安装位置（读取注册表 `InstallLocation`），用户仍可另选。静默安装用 `/D=<目录>` 指定。
- 无论选择哪个文件夹，安装包都装入其下名为 `BeefTV` 的子目录：选择 `D:\Apps` 会安装到 `D:\Apps\BeefTV`。
- 安装器以当前用户权限运行（`RequestExecutionLevel user`）。它会拒绝盘符根目录、非空的非 BeefTV 目录（避免覆盖用户数据）以及当前用户无写权限的目录（例如 `Program Files`，需改用其他文件夹），并在目录页给出提示。
- 卸载只删除随包文件、`agent-host`、`plugin-packages`、`cli`、`media-runtime` 和根目录清单内的文件；未知用户文件保留。安装位置的临时暂存和备份目录与被替换目录同卷，替换完成前不删除旧程序。

在非 Windows 主机交叉编译出来的 exe，不能当作 Windows 验收通过。

## 启动目录与数据目录

桌面进程默认数据目录来自 Go 的 `os.UserConfigDir()`，再拼 `BeefTV`：

| 系统 | 默认数据目录 |
| --- | --- |
| Windows | `%AppData%\BeefTV`（Roaming） |
| macOS | `~/Library/Application Support/BeefTV` |

其中包含 SQLite、本地资源和迁移备份。隔离调试时设置 `CANVAS_DESKTOP_DATA_DIR`，或启动桌面程序时传入 `--data-dir=/绝对路径/独立测试目录`；启动参数优先于环境变量，拒绝相对路径和文件系统根目录。`CANVAS_BACKEND_DATA_DIR` 只作用于 `cmd/server`，不会改桌面数据目录。

官方插件源目录是安装包内的只读输入；启动后会复制到数据目录下的 `plugin-packages\`。源目录找不到时，桌面后端无法完成启动。

需要知道的限制：

- 未签名的 `BeefTV.exe` 可能被 SmartScreen 拦截；本脚本不签名。
- 构建机没有 C 编译器时，脚本会失败。常见 MSYS2/MinGW 路径若存在但不在 PATH，脚本会指出路径，不会自动加入 PATH。
- 数据库连接串目前把数据目录与 `/open_ai_canvas.db` 直接拼接。Windows 一般接受正斜杠；数据目录名里如果出现 `?` 或 `#`，可能被当成 DSN 参数。

发布前先停止 Wails/Vite 开发进程，避免开发输出与生产构建并发写入同一目录。

## 桌面自动更新

自动更新只服务于已经装过「带更新器的生产包」的用户。检查、下载、安装都在应用内完成；安装并重启前，正在运行的版本不会被替换。

### 现有安装

`v1.5.2` 及以前的安装包里没有更新器。给仓库补上更新源或签名清单，不会让这些已经装好的版本自己升级。

用户需要先手动下载并安装第一个带更新器的版本。之后就可以在应用里检查更新。项目、素材、设置、BeefAPI 登录和自定义插件会留在原来的数据目录，不会跟着安装包走。

### 会保留的数据

更新包只替换应用本身：

| 系统 | 被替换 | 不会进更新包、也不会被替换 |
| --- | --- | --- |
| macOS | `BeefTV.app` | `~/Library/Application Support/BeefTV` |
| Windows | `BeefTV.exe` 和旁边的 `plugin-packages\*.beeftv-plugin` | `%AppData%\BeefTV` |

应用包身份和可执行文件路径保持不变，所以前端 IndexedDB 会继续可用。官方插件随应用包更新；用户自己装的插件如果放在数据目录里，会留下来。

程序与数据必须使用独立目录。尤其不要把 Windows zip 解压到 `%AppData%\BeefTV`，也不要将 `CANVAS_DESKTOP_DATA_DIR` 指向 exe 所在目录。更新器会在退出前拒绝这类目录重叠。

更新包禁止带上 `.env`、SQLite 数据库和 `.settings-key`。打包工具遇到用户数据目录会直接拒绝。

### 更新签名和 Apple 签名

这是两件独立的事。

- **更新签名**：Ed25519 签的是 `desktop-update.json` 里的清单。清单写明每个系统包的下载地址、SHA-256 和大小。应用用编译进去的公钥验签，再核对 zip 哈希。不依赖 Apple 证书，也不走业务云接口。
- **Apple 签名 / 公证**：决定下载后的 `.app` 能否通过 Gatekeeper 的默认信任检查。现有 macOS 脚本仍使用 ad hoc `codesign --sign -`，没有 Developer ID 身份或 Apple 公证；首次手动安装可能被拦截。更新器本身不依赖 Apple 证书，但要让用户无需手动放行，需要 Developer ID Application 签名及 Apple 公证。首次安装指引见 [快速开始](../QUICKSTART.md#下载与首次打开)。

发布验收必须分别记录安装包哈希、`codesign --verify --deep --strict` 和 `spctl --assess --type execute --verbose=4` 的结果。前两项通过不代表 Gatekeeper 放行；还需在没有历史放行记录的 Mac 上，通过浏览器下载、解压并从 Finder 首次打开验收。GitHub 与 Cloudflare 提供相同字节的包时，不会改变 Apple 对应用签名的判断。

Windows 目前也不做 Authenticode 签名。SmartScreen 可能拦截首次手动安装。

### 密钥

在本机生成，不要写进仓库，也不要在终端打印私钥：

```bash
cd backend
go run ./cmd/update-release gen-key \
  --private-key /path/to/beeftv-updater.private \
  --public-key /path/to/beeftv-updater.public
```

私钥文件权限是 `0600`，内容是 64 字节 Ed25519 私钥的标准 Base64。公钥是 32 字节公钥的标准 Base64。

GitHub 仓库配置：

| 位置 | 名称 | 内容 |
| --- | --- | --- |
| Actions secret | `BEEFTV_UPDATER_PRIVATE_KEY` | 私钥文件全文 |
| Actions variable | `BEEFTV_UPDATER_PUBLIC_KEY` | 公钥文件全文 |

发布流水线会用私钥推导公钥，必须和变量一致，否则失败，不会发布未签名更新源。

本地要打带更新器的包时，导出公钥即可：

```bash
export BEEFTV_UPDATER_PUBLIC_KEY="$(tr -d '[:space:]' < /path/to/beeftv-updater.public)"
./scripts/build-beeftv-release.sh
```

脚本会把下面两个链接期变量写进二进制：

- `infinite-canvas/backend/internal/desktopupdate.FeedURL` = `https://updates.beefapi.com/beeftv/desktop-update.json`
- `infinite-canvas/backend/internal/desktopupdate.PublicKey` = 公钥 Base64

两个都为空时，应用里的更新器保持关闭，但仍显示当前版本。

**丢失私钥**：已经发出去的包只认当时编进去的公钥。新密钥签的清单，旧包验不过。换密钥等于重新发一个需要用户手动安装的引导包。不要轮换生产密钥，除非旧私钥已经泄露或确认丢失。

**泄露私钥**：立刻停用自动更新源（不要再发布用该密钥签的清单），换新密钥，并让用户手动安装新引导包。

### 发布

版本号只来自仓库根目录 `VERSION`，必须是稳定的 `vMAJOR.MINOR.PATCH`。不要用预发布号，也不要按 `main` 的 commit SHA 轮询。

正式文件名固定为：

```text
BeefTV-vX.Y.Z-darwin-arm64.zip
BeefTV-vX.Y.Z-darwin-amd64.zip
BeefTV-vX.Y.Z-windows-amd64.zip
BeefTV-vX.Y.Z-linux-amd64.zip
desktop-update.json
```

Actions 中的 `desktop-*` 临时安装包保留 7 天，用于发布任务之间传递文件及短期排查。正式 GitHub Release 和 R2 下载文件不受此期限影响。清理历史临时包前，应确认对应发布任务成功，且对应版本的平台安装包和更新清单齐全；未确认发布成功的包和升级验证报告保留。

zip 里的布局：

- macOS：`BeefTV.app/...`，保留可执行权限；内部安全符号链接会被解成普通文件，不会写成 zip 符号链接项。
- Windows：根目录的 `BeefTV.exe` 和 `plugin-packages/*.beeftv-plugin`。
- Linux x64：`BeefTV-linux/` 内包含 `BeefTV`、`cli/beeftv`、`agent-host/` 和 `plugin-packages/`。在 Ubuntu 24.04 原生构建，使用 GTK3 和 WebKitGTK 4.1；安装依赖和启动方法见 [Linux 安装说明](linux-install.md)。更新和回滚替换整个程序目录，用户数据留在配置目录。

新版本更新清单和安装包使用 Cloudflare R2：

```text
https://updates.beefapi.com/beeftv/desktop-update.json
```

流水线先验证 R2 和遗留 COS 清单入口的条件写能力，再建 draft，四个平台构建任务把包保存为 Actions 产物。收齐后生成签名清单，先将版本包和版本清单写入 R2 不可变路径并从公开地址完整读回校验。之后发布 GitHub Release，按旧 ETag 条件替换 R2 最新清单，最后将已激活的原始签名信封同步到遗留 COS 清单入口。失败或缺包不会激活 R2 更新源。COS 同步失败会使发布作业失败，但不会回滚已生效的 R2 清单或删除正式 GitHub Release。

Linux 发布任务会从最终 ZIP 解压执行随包 CLI，并在 Xvfb 中启动桌面程序，确认本地后端和可见窗口。PR 的 `Linux desktop package checks` 提前执行同一构建与启动检查，不发布版本，也不调用付费模型。

v1.5.6 及以前的更新器仍内置 GitHub 清单地址。如果旧客户端无法连接 GitHub，需要先手动安装新版；远端清单无法改写尚未更新的程序。后续历史客户端内置 `updates.beefapi.com` 或 COS 清单地址，因此迁移必须保留这两类入口，不能只修改新包里的 FeedURL。旧签名信封、版本对象和内含的下载地址保持原样；原有 COS 包仍可读取。迁移前已签名的清单即使放到 R2，也不会自动将其内部 COS 地址改成 R2；通过下一次正常发布的新签名清单切换下载地址，不重建或重签同一版本。

### R2 发布配置

使用原有 `beeftv-releases` 桶及自定义域名 `updates.beefapi.com`，只存放公开发行文件。Actions 使用原有 Secret `BEEFTV_R2_ACCESS_KEY_ID`、`BEEFTV_R2_SECRET_ACCESS_KEY` 和 Variable `BEEFTV_R2_ENDPOINT`，region 为 `auto`。更新签名密钥保持不变。版本对象长期缓存且不可变，最新清单禁止缓存；生产下载不使用限流的 `r2.dev` 开发域名。

`scripts/publish-desktop-r2.py` 默认使用 R2。`stage` 执行存储端完整读回及公网完整大小/SHA256 校验；`activate` 仍要求 GitHub 最新正式版本和原始签名信封一致。正式作业在两个步骤之间共享 `--verification-receipt "$RUNNER_TEMP/release-public-verification.json"`，保留两轮完整读取，激活时对有有效回执的包执行条件 Range 检查。回执不上传、不跨作业复用，清单始终完整读取和验签。

`bridge-cos` 只用于已内置 COS 更新地址的客户端。它固定从 `https://updates.beefapi.com/beeftv` 验证四个平台 ZIP、版本清单、已激活的最新清单及 GitHub 最新正式版本，随后通过下面的 COS 锁和 claim 协议备份、条件更新并完整读回原 COS 最新清单。只写小型清单和备份，不向 COS 复制新安装包；它不接受安装器 staging 或跨存储回执快捷检查。更新源中的包地址继续指向 R2。失败后保留 R2 正式发布状态，按 COS 恢复说明处理遗留锁，不能无条件覆盖旧入口。

切换自定义域名的原 COS 重定向规则前，先核对原 R2 域名绑定、历史文件清单和新增版本的原始文件大小/SHA256；只补齐缺失对象，已有内容不同时停止。保留原重定向规则作为回滚资料。源码合并、R2 文件准备、公开域名切换和下一次桌面发版分别记录验收，不能将合并当成已切换。

### 遗留 COS 清单入口和人工恢复

保留广州公开桶 `beeftv-components-1481187348` 的原 `beeftv/` 文件和 `beeftv/desktop-update.json` 更新入口。这里只为历史客户端同步小型清单；新包由 R2 提供。旧更新域名迁移与官网发布分开验证，不改变更新签名密钥。

仓库 Actions 需要以下配置：

- Secret `BEEFTV_COS_ACCESS_KEY_ID`、`BEEFTV_COS_SECRET_ACCESS_KEY`：仅对发行前缀拥有所需对象读写权限，不使用账户管理员令牌。只允许删除 `beeftv/.publication-probes/` 的测试对象和 `beeftv/.publication-locks/` 的发布锁；发行文件及 `beeftv/.publication-claims/` 不应授予删除权限。锁和 claim 不配置生命周期或自动清理，存储桶版本控制必须保持关闭；开启或暂停版本控制都会使禁止覆盖的保证失效。
- 遗留入口固定 endpoint `https://cos.ap-guangzhou.myqcloud.com`、region `ap-guangzhou`、bucket `beeftv-components-1481187348`，使用虚拟主机寻址。
- 原有 `BEEFTV_UPDATER_PRIVATE_KEY` 和 `BEEFTV_UPDATER_PUBLIC_KEY` 保持不变。

`scripts/publish-desktop-r2.py` 保留历史文件名，支持 `--provider cos|r2`，复用 `update-release verify` 验签。COS 使用 Python 标准库和 SigV4 签名的单次 HTTP 请求，原子创建依赖 `x-cos-forbid-overwrite: true`；R2 保留 AWS CLI v2 的原生 `IfMatch`、`IfNoneMatch`。COS 的 S3 兼容接口可能忽略这些 S3 条件头，不能用它们保护 COS 最新清单。每次操作先在目标桶的随机对象上验证原生禁止覆盖及原始字节不变；检测到失效立即停发。

COS 发布使用以下对象，公开下载文件与内部发布对象各有固定前缀：

- 不可变版本文件：`beeftv/vX.Y.Z/<文件名>`，使用原生禁止覆盖创建，已有内容逐字节核验。
- 发布锁：`beeftv/.publication-locks/<SHA256(目标key)>.json`，按目标固定命名，包含随机 nonce、GitHub 仓库/run/attempt/job 和创建时间。时间仅供排障，不是自动接管期限。创建回执丢失时只读回同一 nonce，不盲重发创建。
- ETag 消费记录：`beeftv/.publication-claims/<SHA256(JSON([目标key,预期ETag]))>.json`，原子创建后永久保留，记录预期 ETag、下一份完整字节的大小/SHA256 和持锁者。同一预期 ETag 只能消费一次。首次清单不存在时使用 JSON `null`，不使用随机值或字符串 `"null"`；另一目标使用不同标识。
- 测试对象及其 claim：`beeftv/.publication-probes/`，与正式 claim 隔离，成功后清理。真云双客户端探针需要显式运行 `python3 scripts/probe-desktop-cos.py --run`，不在普通本地单测中请求云端。

最新清单在持锁期间读取并核对预期 ETag，再原子创建消费记录，最后上传并完整读回核验。消费记录存在即拒写，避免 COS 源站短暂读到旧 ETag 时重复执行同一替换。预期不存在时，目标 PUT 同时带原生禁止覆盖，防止历史清单的短暂 404 在尚无 null claim 时被误当成首次发布；目标已存在返回 409 时拒写并保留 claim。消费记录或目标写入的回执不确定、读回失败时保留锁与已写入的 claim，停止后续发布。解锁前只确认自己的 nonce，DELETE 只发送一次；只有 HTTP 200/204 算释放确认。非成功状态或丢失回执始终报“解锁未确认”，后续 GET 404 不能证明删除成功，也不能据此重删，以免删除下一位持锁者的锁。

所有写最新清单的工具、初次迁移和人工操作都必须遵守同一锁及 claim 协议。不能用 COSCMD、通用复制脚本或另一套发布器无条件覆盖最新清单。迁移前确认旧发行作业已结束，发布凭据不得修改桶版本控制或生命周期。

`stage` 只准备版本对象；`activate` 确认 GitHub 最新正式版本及公开清单与本次签名清单一致、全部公开对象可校验后，备份上一份清单，再执行上述条件更新。公网检查使用该版本客户端的请求标识。重复执行已成功的同一版本是幂等的，已有对象内容不同或试图降级会失败。历史 R2 操作必须显式指定 `--provider r2 --region auto --bucket beeftv-releases --endpoint-url <原账户端点> --public-base https://updates.beefapi.com/beeftv`。

`stage` 和 `activate` 的本地回执绑定签名信封、存储配置和 GitHub 仓库/run/attempt/job，不上传为产物，也不跨作业或跨次发布复用。遗留 COS 人工操作必须显式指定 `--provider cos`；桥接命令不借用 R2 的存储回执。

仅 COS 的 `activate` 使用回执快捷检查：先用随机错误 ETag 确认该对象拒绝请求并返回 412，再发送带原强 ETag 的 `If-Match` 和前 1024 字节 Range 请求，核对 206、ETag、Content-Range、大小及该片段哈希。文件变化、缺失、条件请求失效、不支持所需 Range 或返回不同片段都会阻止激活。没有回执或完整校验时缺少强 ETag 的文件仍执行完整校验；存在但不匹配当前发布或作业的回执直接报错。清单始终完整读取、验签和核对，锁及 claim 协议不变；`resume` 不使用回执快捷检查。COS 大包传输从三轮降为两轮，激活仅增加每包 1 KiB 和一次拒绝探测。

R2 自定义域名的 CF 缓存命中可能忽略 `If-Match`，不能复用上述 HTTP 证明。R2 的 `stage`、`activate` 和 COS 桥接中的 R2 来源检查都完整读取公开文件并核对 SHA256；R2 回执仍验证作业绑定，但不记录或复用包的 HTTP 证明。完整校验不产生 R2 外网下行流量费，存储和请求仍按实际使用计费。R2 存储端的条件 PUT 与公开缓存读取分开验证，最新清单继续使用条件激活和完整读回。

#### 遗留锁与未完成 claim 的人工恢复

锁不会自动过期，也不能靠删除 claim 重试另一份清单。`resume` 只处理未解锁的同一次故障写入，执行前必须取得以下现场证据：

1. 人工冻结全部最新清单 writer，包括 Actions、初次迁移和人工发布；查明没有后继发布。按原锁的仓库、run、attempt、job 保存 GitHub Actions 状态及原日志，确认整个原 attempt 已终态、进程已停止。
2. 确认所有在途 COS PUT 已结束。作业终态本身不能证明一次丢回执的远端 PUT 已结束，必要时用 COS 请求日志核查。原发布日志还必须证明**从未发送释放锁的 DELETE**。如果 DELETE 已发送、回执未知、日志不完整或无法确认，禁止使用 `resume`；旧锁 GET 可能是陈旧值，不能代替这些证据。
3. 从 COS 读取并保存原锁和对应 claim 的完整原始字节，不重新排版 JSON。核对固定目标 `beeftv/desktop-update.json`、原 nonce、claim 的 publisher、预期 ETag 和下一份大小/SHA256，并取回原始签名信封。claim 不存在或其回执未知时，不能根据一次 GET 404 生成另一份 claim；先查清原请求结果。

在已配置发行 COS 凭据、官方更新公钥 `BEEFTV_UPDATER_PUBLIC_KEY` 和 `gh` 认证的受控环境中，从仓库根目录执行：

```bash
go -C backend build -o /tmp/beeftv-update-release ./cmd/update-release
python3 scripts/publish-desktop-r2.py resume \
  --provider cos --endpoint-url https://cos.ap-guangzhou.myqcloud.com \
  --region ap-guangzhou --bucket beeftv-components-1481187348 \
  --public-base https://beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com/beeftv \
  --manifest /path/to/original-desktop-update.json \
  --verifier /tmp/beeftv-update-release \
  --lock-document /path/to/original-lock.json \
  --claim-document /path/to/original-claim.json \
  --confirm-writers-frozen --confirm-no-inflight-put --confirm-no-unlock-attempt
```

三个确认参数分别表示操作员已取得上述冻结、在途 PUT 结束、从未解锁的证据；不能取得时不执行。入口会自行检查官方 `glanderness/BeefTV` 原 run/attempt 的 GitHub API 状态，重新验签、检查四平台公开文件及 GitHub 最新正式版本的精确清单字节，再逐字节匹配当前锁/claim。它只接受原 claim 大小/SHA256 对应的同一信封，不新建 nonce 或 claim，也不删除 claim。目标已经是这份清单时只核验并释放原锁；目标仍为原 ETag 时才续写同一份清单，首次不存在仍使用原生禁止覆盖。其他状态、不同 nonce/目标/字节一律停发。仅在完整读回匹配后发送一次解锁 DELETE，非 HTTP 200/204 仍报未确认。

如果原故障来自 `bridge-cos`，使用完全相同的参数和证据，把命令换为 `resume-cos-bridge`。它固定从 R2 核对包、版本清单和已激活的最新清单，随后恢复原 COS claim，并从 COS 完整读回最新清单；不接受安装器 staging 或校验回执。普通 `resume` 仍用于包地址属于 COS 的历史发行。

已尝试 DELETE 的故障不属于这个恢复入口。先保持全部 writer 冻结，核验最终公开 feed 和原请求日志，再由操作员单独处置遗留锁；不得借恢复重发 PUT 或盲重删。记录恢复证据后才恢复正常发行。

切换公开入口前，要复制并核验所有保留历史版本的包及原始签名信封，逐项记录大小和完整 SHA256，验证匿名下载、Range 续传，以及已安装旧版读取原 feed 后的真实更新。COS 当前源站若未通过条件写自检，允许准备历史副本与兼容读取，但不能激活新的最新清单。

如果 GitHub 发布成功而存储激活失败，保留正式版本及所有不可变对象。先核查存储与公开入口；没有遗留锁和未完成 claim 时才用同一版本原始清单重跑原命令（R2 为 `activate`，旧入口为 `bridge-cos`），否则遵守上述恢复条件。不要删除正式 tag 或重建不同内容的同版本包。条件写成功但最终回读失败时，新清单可能已经生效，不能把它当作未发布。已经安装新版本的客户端不自动降级。

在 `glanderness/BeefTV` 的 `main` 上手动运行 `.github/workflows/release-desktop.yml`。输入的 `confirm_version` 必须和 `VERSION` 一致。`CHANGELOG.md` 必须有对应的 `## vX.Y.Z` 段落，这段文字会同时成为 GitHub Release 说明和清单里的 `notes`。

工作流会拒绝：

- 在非 `main`、非官方仓库上发布
- 缺少密钥或公私钥不匹配
- 标签或 Release 已经存在（包括 draft）
- 新版本不高于已经发布的稳定版本
- 四个平台包还没齐就签名

Apple 公证不在这条工作流里。macOS 作业沿用现有脚本的 ad hoc 签名。Windows 作业安装 MSYS2 UCRT64 GCC，并核对 binutils ≥ 2.37，以符合 Go 1.25 的 DWARF 5 要求；不要用 Chocolatey mingw 或旧版 TDM-GCC。

同一版本的资源是不可变的。不要覆盖已发布的 tag、zip 或 `desktop-update.json`。

本地打包和签名（用测试密钥，不要用生产私钥做实验）：

```bash
cd backend
go run ./cmd/update-release package \
  --platform darwin-arm64 \
  --input cmd/desktop/build/bin/BeefTV.app \
  --output /tmp/BeefTV-vX.Y.Z-darwin-arm64.zip
go run ./cmd/update-release sign \
  --version vX.Y.Z \
  --commit "$(git rev-parse HEAD)" \
  --changelog ../CHANGELOG.md \
  --private-key /path/to/beeftv-updater.private \
  --expect-public-key "$(tr -d '[:space:]' < /path/to/beeftv-updater.public)" \
  --require-platforms darwin-arm64,darwin-amd64,windows-amd64,linux-amd64 \
  --asset darwin-arm64=/tmp/BeefTV-vX.Y.Z-darwin-arm64.zip \
  --asset darwin-amd64=/tmp/BeefTV-vX.Y.Z-darwin-amd64.zip \
  --asset windows-amd64=/tmp/BeefTV-vX.Y.Z-windows-amd64.zip \
  --asset linux-amd64=/tmp/BeefTV-vX.Y.Z-linux-amd64.zip \
  --output /tmp/desktop-update.json
```

### 回滚

客户端在退出前校验并把更新准备到程序所在磁盘；无写入权限、磁盘空间不足或签名错误时保留当前运行的应用。替换/启动失败会尝试恢复旧程序。程序旁的 `.beeftv-update-*` 目录暂存旧程序和恢复记录；本地后端启动、界面挂载、素材与画布缓存成功加载，且本地工作区与两类资源列表读取成功后，客户端自动清理同一安装位置已成功升级的目录（包括旧版本遗留目录）。失败、回滚、记录不完整或含额外文件的目录继续保留。Windows 升级锁随句柄关闭删除；macOS 保留零字节 `.BeefTV.update.lock`，防止仍使用旧版锁协议的助手并发替换应用，它不存储升级包或旧程序。清理失败不阻塞使用，下次启动重试。已启动的新进程不会自动降级，以免把迁移后的数据库交给旧程序；恢复旧程序时需另行确认数据库兼容或还原匹配的数据备份。

已经发布的版本不能收回。已经更新成功的用户，不会因为删除 GitHub Release 而回到旧包。

发现新版本有问题：

1. 不要改写或删除该版本的 zip 和 `desktop-update.json`，可能还有人正在下载。
2. 在 `CHANGELOG.md` 写清问题，把 `VERSION` 升到更高的稳定号。
3. 从修复后的 `main` 再跑一次发布工作流。
4. 已安装更新器的用户检查更新后会拿到更高版本。

如果某个 draft 失败且从未公开：确认没有用户能下到它之后，可以删除该 draft 和对应 tag，再对同一 `VERSION` 重试。已经公开的 tag 不要复用。

`/releases/latest` 指向最近一次发布的正式版，按发布时间而不是按最大版本号。只按时间顺序发布递增的稳定版本。
# 真实生成门禁

每次发版先完成 [六路径、两轮真实客户端测试](./real-generation-release.md)，提交对应版本的脱敏验收记录。发布工作流在创建 draft 前检查记录与当前源码绑定，不允许只凭单元测试或健康检查发布。
