# Durable 正式宿主验收（2026-10-08）

本地实现，未发布。新会话由官方 `@earendil-works/pi-durable` 1.0.4 独占模型、工具调度、SQLite transcript 和恢复；旧 SDK JSONL 会话保持原路径。没有在 AgentSession 外套第二个运行循环。

## 接入合同

`agent-host/durable-session-owner.mjs` 导出 `createDurableSessionStore`。依赖 Go 提供 `authorizeTurn({canvasId,turnId,sessionId})` 和 `completeTurn(...)`：每次模型请求和工具执行都重新验证回合；读取身份匹配且 open=false 的终态只补本地历史，绝不重新 submit 或恢复模型。

公开方法：createSession、activateSession、ensureSession、submit、recover、supplement、beginPendingInput、fenceStop、wait、stop、history、status、listCanvasSessions、disposeAll。`wait` 取消只解绑等待，`stop` 才调用官方 abort。宿主 HTTP 连接不拥有模型任务的生存期。

动作身份使用持久会话 ID + 官方 `ToolExecutionApi.taskId`，现有 Go ops 仍负责原子回执。已验证的本地写操作允许 safe replay；未知写操作默认 unsafe。补充输入、选定技能 pin、用途 metadata 在同一官方 SQLite session document 保存；官方 steer 队列按固定 requestId 去重。请求准备已 checkpoint 时，官方 beforeRequest hook 补入尚未出现在请求中的持久补充内容，旧要求不会在恢复时重新生效。

history/status 严格投影业务字段；不发送 native image base64、内部 content、log、effects 或 result。完成记录按官方 settlement.answer 精确读取对应 assistant；失败或没有对应答案不会挪用上一轮答案。

`durable-turn-budget.mjs` 兼容现有同步 spendModelRequest/spendToolStep，以 fsync + 原子 rename 在调用前持久请求数、工具数和预算失败原因。重启不重获完整预算；损坏或身份不符拒绝继续。

## 证据

- 随包 Node **24.15.0**：`node --test durable-session-owner-cases.mjs durable-turn-budget-cases.mjs`，9 项通过（4.910 秒）。覆盖写后 SIGKILL safe 重放不重复、未知写 unsafe 不重放、closed 授权拒绝、complete 后崩溃只重建历史、取消等待、官方停止、补充输入跨崩溃顺序、pin 保存、媒体数据投影、失败不假成功和持久预算。Bun 测试入口通过独立 Node runner 执行这些 case，避免混用 Bun 与 node:test 的清理语义。
- **真实 server.mjs + Go HTTP + SQLite**：`go test ./internal/handler -run TestDurableActualHost -count=1 -timeout 65s`，通过（6.990 秒）。实际创建两视频草案，SIGKILL 后同一 Go turn 仍 open，重启默认 Durable 宿主恢复两参考线，完成后 Go turn 关闭，实际 Undo 恢复原节点。关闭新 Durable 创建后，已有 Durable 历史仍可读，旧 SDK 空会话可创建与读取；来回激活不重跑已完成任务。
- **实际锁依赖与随包 runtime**：`BEEFTV_NODE_RUNTIME=/Applications/BeefTV.app/Contents/Resources/agent-host/runtime bun test scripts/package-agent-host.test.mjs`，3 项通过（38.43 秒）。干净目录从 frozen lock 安装并验证官方包/本地模块导入，路径含空格，正式 server 启动零模型调用。
- `bun install --frozen-lockfile` 通过；未请求真实付费模型。

测试中的 Go 业务、回执和撤销是真实实现；模型是隔离本地脚本供应商。本报告不声称桌面交互、真实模型理解、Windows runtime 或生产发布已完成。

## 独立审查后的追加验证

- 素材准备前同步 `beginPendingInput`，立即将旧模型 epoch 置为 -1。准备期间官方 beforeRequest 等待 promise，旧工具拒绝执行；成功补充输入持久化并入官方队列后解除，准备失败明确记录错误并 abort 旧请求。beforeRequest 的 modelEpoch 来自读取补充内容时的同一 active.intentEpoch 快照，持久化期间意图变化会重新准备。
- `wait` 等待原输入和本业务回合已持久补充 ID 对应的**所有官方 submission**。等待媒体准备和官方生成时不持 admission lock；终态提交时在同一画布锁内再次核对补充集合，变化就退出锁继续等待。稳定时进入 completing，拒绝新补充，才保存结果、请求 Go 完成并记录历史。最新正文来自最后完成的补充 answer，不借前轮回复。
- `fenceStop` 先持久 stopped，再由宿主请求 Go 完成并官方 abort。SIGKILL 位于 fence/Go完成之后、abort之前，恢复仍只取消和重建历史，模型与工具调用均为 0。正常停止把官方本 submission 用户 entry 之后的 aborted assistant 正文保留到 history。
- 连续两次补充的官方 fixture 验证：原输入先完成，第一补充仍运行时再补第二条，Go 仍未结算；最终只有一条业务历史，正文属于最后补充，complete 一次。
- 实际 `server.mjs` 默认 Durable 的 HTTP 附件 only fixture：原消息请求在跑，`/steer` message 为空、附带图片；媒体准备期间旧工具不能写，新模型不能提前请求；附件准备完成后每个请求都包含 native image。第三个官方生成被暂停时 Go 保持 open、history 仍 active；该生成写动作成功一次，第四个请求给出最终正文后才 Go 完成，复读历史不重跑。这项 HTTP fixture 使用本地脚本业务 API；真实 Go/SQLite 生命周期另由上面的独立集成测试证明。
- media.overview/inspect/check 官方 tool outputLimits 提高为 64 MiB，覆盖现有媒体请求上限，避免官方默认 50 KiB 把带媒体 marker 的大行丢弃；大媒体端到端验收由 media worker 的独立测试负责。
- 代码冻结后的 `bun test durable-session-owner.test.mjs durable-turn-budget.test.mjs` 通过（12.64 秒）；两个隔离 Node runner 执行 14 项 owner case 和 1 项持久预算 case。

### 素材准备期间停止

新增真实官方 owner 回归：模型请求仍在运行、图片准备 barrier 尚未完成时调用 Stop。修复前实际 RED：Stop 等待未完成的媒体准备，超过测试 1200ms 限制。修复后 fenceStop 同步释放该 barrier 为 cancelled，再持久 stopped 并官方 abort；迟到 resolve/reject 不产生补充或准备错误，迟到 supplement 拒绝，history 保持 cancelled、error=null、无补充，画布操作为 0，也没有新模型请求。hydrate 保持已发生的停止，不会被较旧 active 快照重新打开。target 四项（pending stop/prep failure/partial stop/multi steer）通过，2.72 秒。

### 输入持久化与官方提交之间停止

另两项真实 RED 均已修复：在 supplementIds 已写入官方 document、官方 input 尚未 admit 时，故意暂停 snapshot/hydrate 并 Stop，原实现报 supplement_submission_missing；实际 SSE 已输出当前部分正文后素材准备失败，原实现把 reply 清空。

只有已 stopped/aborted 的业务回合可以跳过未 admit 的补充输入，取消及恢复不会为它补 submit 或请求模型。正常未停止回合仍把缺失 submission 视为错误。停止/准备失败时的正文仅从原业务 submission.entry 之后的官方 aborted assistant 读取，不取上一轮文字；准备失败同时保留正文与明确错误。三个 target case 已通过（2.62 秒），包括同一持久化缺口在 stopped + Go 已关闭后 SIGKILL、fresh 官方 SQLite 恢复：模型与画布操作为 0，缺失 input 仍未 admit，history cancelled 并保留当前 partial。
