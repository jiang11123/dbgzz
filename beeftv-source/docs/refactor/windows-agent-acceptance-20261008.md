# Windows Agent 与升级器隔离验收

2026-10-08，在 `DESKTOP-BUJ4549` (Windows amd64) 通过既有 SSH 路由执行。本次仅新增 本次独立临时验收目录；未更改现有安装、现有 Node/Bun 或用户数据。

## 环境与来源

现有工具：Node v24.13.0、Bun1.3.9、Go1.26.0。测试另行放置官方 Node v24.15.0 与 Bun1.4.2。Node 来源 `https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip`，SHA256 `cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62`，与官方同版本 SHASUMS256.txt 一致。Bun 来源官方 GitHub bun-v1.4.2 Windows release；用本次锁文件 `bun install --frozen-lockfile` exit0。现有 Bun1.3.9 无法解析新锁文件，未改用户工具。

源码只复制 Agent `.mjs` / package / lock 与 Go desktopupdate、desktopnet、buildinfo 包及 go.mod/go.sum。初始源码包 SHA256 `a1aa73b7aa8746fd21e6529bfa941e20ed3946b0b10f45db3ea9e7f83455065f`，已从远端读回一致。随后增量复制的 fixture/cases 有单独 SHA256 清单。隔离源码包内含仓库 AGENTS。未发现运行中的 BeefTV 或注册表安装项，仅发现 LocalAppData\BeefTV\updates；没有读取其中配置/凭据/用户资料。

## 命令与结果

工作目录为临时 source，不是任何既有 checkout。

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| 隔离 Node24.15.0 `--test durable-session-owner-cases.mjs skill-resource.test.mjs durable-turn-budget.test.mjs` | exit0，13/13，9.175 s | durable-final.log |
| 原生 Go `test ./internal/desktopupdate -count=1 -v -timeout 120s` | exit0，10.235 s | updater-full.log |
| Mac Node `--test agent-host/durable-session-owner-cases.mjs` | exit0，8/8，6.840 s | beeftv-checkpoint-mac.log |

Durable 测试使用官方 1.0.4 SDK + Node原生SQLite，loopback模型和业务API替身。强制结束前 fsync 写 phase 和业务回执 checkpoint；断言真实 SQLite 文件头。Windows forcekill 的退出信号为 null/code1，因此不能只用 Unix SIGKILL 判断；只有 checkpoint、真实回执与SQLite成立才认可中断，随后恢复断言要求节点/边无重复、完成不再次请求模型、未知付费写不重放、补充要求与pin恢复。其他用例覆盖断线只取消wait、显式stop、持久预算和固定Skill/包内辅助文件。

升级器用例在原生 Windows 执行：占用 helper 文件句柄后的清理失败保留备份/状态，关闭句柄再清理成功；新旧锁互斥；启动保留未确认/失败/外部目录；替换与rollback保留邻接文件、用户插件和独立 userdata；缺失Agentruntime不触碰旧安装；插件恢复失败可重试；连续无效安装包不累积staging。这些安装内容为测试布局和字节标记，不是发布版 EXE。`TestLiveSystemProxyUpdateDownload` 因未配置真实签名源 publickey 按现有契约 SKIP，没有去连接生产更新源。

首次验证的两种测试问题都已区分：Windows信号断言在跨平台cases中修复；把 Bun:test wrapper 当 Node测试执行导致的加载错误属于调用错误，最终使用独立 Node cases。未改生产 Durable runtime 来让测试过关。

## 验收范围

证明 Windows隔离运行、官方Node24.15SQLite能力、故障恢复协议与原生更新器文件操作。没有执行真实旧安装到新安装的升级、发布签名/下载、用户桌面交互或付费生成，不把本结果当 REL01真实发布验收。

完整 packet：Windows 2026-10-08 独立验收包（原始材料单独保留），包括源码包、增量hash、原始测试内容的UTF8日志及完整PowerShell命令。远端隔离目录保留以便审阅；没有删除非本次目录。

## 最终媒体短引用与新版恢复测试

在同一任务临时目录同步当前 42 个 JS / package / lock / packager 文件。新增量包 `beeftv-win-final-native.zip` SHA256 为 `7e294bc3c87c50c345e91f8e20e7961d7bd6cff741996ecad3d52379df619c27`；远端逐文件核对 `beeftv-win-final-native-manifest.json` 的 42 项摘要后运行。该包与前述初始包有独立来源记录，不能用初始 13 项测试代替本次结果。

Node24.15.0、Bun1.4.2 继续使用任务临时目录中的官方二进制。新锁文件 `bun install --frozen-lockfile` exit0。命令在临时 `source/agent-host` 下执行：

| 命令 | 结果 |
| --- | --- |
| Node24.15 `--test durable-session-owner-cases.mjs skill-resource.test.mjs durable-turn-budget-cases.mjs` | exit0，19/19，18.623 s：owner14、Skill4、预算1 |
| Bun1.4.2 `test native-part-store.test.mjs media-content.test.mjs` | exit0，5/5，77 ms |
| Node24.15 动态导入官方 pi-coding-agent / pi-ai / pi-durable / SQLite Node storage / OpenAI provider 及打包列表全部14个宿主模块；`verifyRuntime(..., 'windows/amd64')` | exit0 |

新增验证覆盖：实际默认 Durable 宿主接受纯附件补充，附件准备期间禁止提前改草稿；已有恢复、退出与SQLite回执继续通过。媒体短引用实际写入并在新 store 重开后恢复完整字节，720 KB 原生内容不进入官方文字 token 估算或 transcript；路径伪造、源/摘要/MIME篡改和缺少可信媒体工具来源均拒绝。媒体工具仍能转换受支持的原生内容，受限渠道与篡改内容拒绝。

此次未修改生产 runtime 来迁就 Windows。第一次调用把三个 `bun:test` 文件交给 Node，产生 loader 错误；最终已按测试框架分别执行 Node cases 和 Bun 单测。PowerShell 将 Bun 正常写到 stderr 的输出装饰为 `NativeCommandError`，实际 Bun exit0、5 pass/0 fail、完整脚本 exit0，不能将这一装饰当作产品失败。

准确命令、逐文件摘要与完整汇总日志在 packet 的 `beeftv-win-final-native.ps1`、`beeftv-win-final-native-manifest.json`、`beeftv-win-final-native-local.log`。本次没有再次执行升级器矩阵，升级器结果仍以前述原始包收据为准；也没有 Windows UI、真实旧安装升级、付费媒体理解或发布验收。

## 素材准备期间停止的最终补验

随后只同步冻结后的 `durable-session-owner.mjs`、`durable-owner-fixture.mjs`、`durable-session-owner-cases.mjs` 三个文件。独立增量包 `beeftv-win-stop-prep.zip` SHA256 为 `dc06f3cd40308b3a5c4b02940854a49f619079ce9ff30c742afffab3777fc7f8`，远端核对包和逐文件摘要后，在同一隔离目录用 Node24.15.0 执行 `--test durable-session-owner-cases.mjs`，exit0，15/15，19.151 s。

新增 `pending-stop` 用例证明：补充素材仍等待准备时，stop 能取消等待，不依赖准备任务最终返回；迟到的成功/失败与后续补充不会改写已取消的轮次。测试同时检查 cancelled、无 error、业务写入0次、模型调用1次和历史记录1条。其他恢复、已停止轮次不再发送、附件准备期间禁止写入等用例继续通过。

上一节 19/19 与媒体5/5是其独立42文件快照，本节没有重跑或冒充这些单测、升级器或安装验收。三文件清单、命令及 UTF8 日志分别保存为 packet 的 `beeftv-win-stop-prep-manifest.json`、`beeftv-win-stop-prep.ps1`、`beeftv-win-stop-prep-local.log`；未动现有应用或用户数据。

## 已保存补充、停止恢复与准备失败的最终增量

最后再次同步上述三个 owner/fixture/cases 文件，独立增量包 `beeftv-win-final-owner18.zip` SHA256 为 `1e235c10d50b65081efff012f3e128c0266d31a48080be19053172b953e3ffc8`。远端逐文件核对，并确认未改的 `durable-turn-budget-cases.mjs` 摘要仍与当前源码一致。在同一任务临时目录用 Node24.15.0 执行 `--test durable-session-owner-cases.mjs durable-turn-budget-cases.mjs`，exit0，19/19，23.298 s：owner18、预算1。

本次新增证明：用户补充已持久保存而官方会话尚未接纳时停止，历史仍保存原补充与本轮已有内容；素材准备失败仍保存真实 SSE 输出；同一状态中停止并关闭 Go 轮次后强制结束进程，fresh recovery 不再补接纳或发模型请求，同时保留原补充和已有内容。预算重开不能重置的用例也再次通过。

该19项与前述owner14+Skill4+预算1的19项是不同快照及组成；本次未重跑 Skill、媒体短引用、升级器、UI或安装升级。准确命令、三文件增量和预算摘要、UTF8日志分别为 packet 的 `beeftv-win-final-owner18.ps1`、`beeftv-win-final-owner18-manifest.json`、`beeftv-win-final-owner18-local.log`。现有应用和用户数据均未修改。
