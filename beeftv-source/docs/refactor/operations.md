# 操作层切片：产品中立 operations API

Agent 操作层抽成工作区共用的 `operations` 核：注册表、幂等键、调用方身份和事务回执。当前已接入内置助手、CLI/MCP，以及桌面手工 UI 的正常保存（`canvas.document.commit`）。初次创建/导入仍走独立 PUT；媒体生成结果按 `canvas.task.bind` 绑定到画布节点，续跑标记走 `canvas.document.commit`。`agentops` 只保留本机凭据与助手范围适配。

## 依赖方向

`handler` / `cmd/beeftv` → `agentops`（鉴权适配）→ `operations`（核）→ `canvas` / `model`

`app.Service` 通过 `BindDomain` 实现 `operations.DomainBinder`，是薄适配，操作核不再 import `internal/app`。

`Domain` 方法不接受 `*gorm.DB`。事务绑定只出现在 `DomainBinder.BindDomain(tx)` 与 `Store` 内部。

## 公共 API

```go
registry := operations.NewRegistry(binder, store) // binder 通常是 *app.Service
operations.RegisterDefaultOps(registry)

result, err := registry.Execute(operations.Request{
    Context: ctx,
    Op:      "canvas.nodes.create",
    OpID:    operationID, // 写操作必填；只读操作禁止
    UserID:  userID,
    Caller:  operations.ManualCaller(false), // 或 AssistantCaller / ExternalCaller
    Params:  params,                         // JSON；也可把 operationId 放在 params 里
    TurnID:  "",                             // 仅内置助手回合填写
})

receipt := result.Receipt(turnID)
listed := registry.List(operations.ManualCaller(false))
```

### 调用方

| 构造 | Kind | 能力发现 |
| --- | --- | --- |
| `ManualCaller(readOnly)` | `manual` | 27 项（未启用只读过滤时），写操作 schema 带必填 `operationId` |
| `ExternalCaller(readOnly)` | `external` | 同上 |
| `AssistantCaller(scope, readOnly)` | `assistant` | 按回合权限分别为13/23/26项（只读/当前画布/完全访问）；写操作 schema 不暴露 `operationId` |

`Caller.Scope` 是 `Authorizer`（`Visible` / `Allows`）。空指针不能赋给该接口，否则会变成带类型的 nil。手工/外部调用方遇到带类型的空范围时仍发现完整27项。显式 `assistant` 且没有活范围时，能力发现为空、执行拒绝；宿主在回合外应传入空的 `AssistantScope` 适配器，才能按缺省当前画布模式发现23项且执行全部拒绝。未知 `Kind` 失败关闭。桌面 React 没有 owner token：操作入口用 `RuntimeDependencies.DesktopTrust` 加 loopback/同源识别受信任手工 UI，记为 `caller=manual`。未授信的 loopback 客户端没有整页写权限。

### 结果信封

`Result`：`op`、`opId`、`replayed`、`result`、`revision`、`caller`。

`Receipt()` 给手工 UI / 助手结算用。存储仍写既有 `agent_op_records`，不另起一份。

### 操作目录

共享目录的只读操作：`canvas.get`、`canvas.search`、`asset.list`、`asset.get`、`task.get`、`model.catalog`、`media.overview`、`media.inspect`、`media.check`、`skill.catalog`、`skill.get`、`skill.file`、`project.media.search`、`project.canvas.search`、`canvas.generation.propose`。生成提议虽不直接生成或扣费，仍不向内置只读模式开放。

写入：`canvas.node.update`、`canvas.node.configure`、`canvas.node.bind_asset`、`canvas.node.move`、`canvas.node.delete`、`canvas.nodes.create`、`canvas.edge.create`、`canvas.edge.delete`、`canvas.document.commit`、`canvas.task.bind`、`conversation.message.attach`、`canvas.timeline.update`、`canvas.timeline.render`

`canvas.script.prepare` 为已有分镜的 1..8 行一次准备首帧及/或视频草稿：采用分镜原提示词和时长，校验明确模型及参数，创建节点、绑定分镜、连接参考图与各镜头首帧，并按镜头排布。视频须显式选择 `generateAudio`。同画布图片参考只连接首帧图片，各视频只连接自己的首帧。已有目标绑定拒绝覆盖；任何行、参数或版本无效则整批不写。使用同一操作事务、CAS、稳定回执和撤销；不是付费任务或额外工作流引擎。`image`/`video` 中省略的类型不创建，已有首帧可直接用于本次新视频。真实 SQLite 重放与撤销见 `backend/internal/agentops/storyboard_prepare_test.go`。

`canvas.document.commit` 是顶层文档覆盖，必须带 `expectedRevision` 与稳定 `operationId`，在回执事务里校验并应用到当前画布。不创建画布，不接受任意数据库补丁语言。未触及的顶层字段、ID、资源引用校验、CAS 与回执原子性保持不变。内置当前画布与只读模式拒绝该操作；完全访问模式允许，但仍校验归属与 CAS，并保存跨画布撤销快照。

`canvas.generation.propose` 只登记提议，不生成、不扣费；禁止携带 `opId`。确认用的模型是目标节点当前有效的选用：节点显式设置优先于全局默认，并按模型目录校验 kind。只有没有节点模型时使用默认；无法解析显式模型时要求重新选择，不替换为另一个付费模型。一批节点若有效模型不同，操作拒绝，由调用方按模型分开提议。同一批节点解析到不同 `modelConfigRevision` 时按配置已变动拒绝，请再提出一次。客户端仍检查最终执行模型与提议一致；规格兼容解析若需要换模型，则拒绝该提议，不带着旧确认发送。

提议还检查当前画布的媒体依赖：沿直接参考输入、配置输入优先级、显式引用与视频帧参数验证；脚本输出边只提供文本，不算未就绪媒体。缺产物、仍在生成/提交状态的引用，以及同批其他目标将重生成的引用，整体返回 `generation_dependencies_not_ready`（412），`details.unreadyNodeIds` 指明先完成的素材，`details.blockedNodeIds` 指明依赖它们的目标。调用方先提出前置素材，产物就绪后再提出下游；不会过滤目标或自动调度。本检查不下载媒体或替代客户端既有素材水合/转换有效性校验，确认仍绑定画布版本。

### HTTP

`GET /api/ops` 与 `POST /api/ops/:op` 仍是本机入口。响应多一个 `caller` 字段（`manual` / `assistant` / `external`）。外部 CLI/MCP 的 operationId 语义不变：写操作必须提供稳定幂等键，重试复用，不同 payload 冲突。授权发生在回放之前。

## 仍由其他切片拥有

任务 worker/provider、数据库迁移、model schema、Agent 宿主生命周期、画布 UI 页面（`project.tsx`）、助手侧栏、时间线/合并/导出库。

媒体生成结果通过 `canvas.task.bind` 绑定到画布节点，续跑标记通过 `canvas.document.commit` 提交；不再有整份画布加素材的专用 PUT。`project.tsx` / 媒体工具仍通过 `syncLocalCanvasSnapshot` 调仓库；该桥接把文档字段合成一次 `canvas.document.commit`，viewport 只留在本地，页面文件本身未改。

手工 UI 提交日记按 `userScope + canvasId` 隔离，同一把钥匙上的读改写排队。损坏、无法解析或越权的日记 fail-closed，不发明空操作；离线仍可打开本地草稿。内存与基线只在 IndexedDB 写入成功后发布。回执按 `operationId` 精确确认；刷新 keep-local 不得把远端读成功当成可编辑基线，只保留候选并暂停自动保存，直到用户显式采用或三路 rebase。在途操作允许原样回放，但回执不得把基线回退到更旧文档，也不得用旧整份快照覆盖外部已确认内容。`confirmedRevision` 只前进。派发、冲突草稿、同步进度和删除都捕获用户作用域：排队中的旧账号工作在发出前若已切换，返回过期作用域错误而不是成功；进行中的请求把 ack 写回原作用域，不改新账号的 live store。删除与未完成提交串行，发出前核对作用域，失败时保留后续编辑。

本轮仍保留：初次创建/导入 PUT。仓库暴露 `adoptServerConfirmedGenerationPatch` 给交付切片：干净缓存整份采纳，草稿按节点/连线 id 合并。

## 回合与写入事务

`internal/assistantturns` 的 schema v10 保存业务轮次；旧 JSON 只作为历史导入来源。官方 pi 的模型会话仍由 SDK `SessionManager` 保存。

`operations.Store.Run` 在插入回执后、执行业务写入前调用 `TurnGuard.VerifyOpenAssistantTurnInTx(tx, userID, turnID, canvasID)`，在同一事务验证轮次归属、画布和开放状态。非空 `TurnID` 缺少 guard 时失败关闭；校验失败同时回滚回执和业务写入。手工 UI / CLI / MCP 的空 `TurnID` 不归入助手轮次。授权先于回执重放；重放不会把已提交操作重新归入另一个轮次。
