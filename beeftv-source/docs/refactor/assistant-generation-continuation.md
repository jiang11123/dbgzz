# 已确认生成后的制作计划接续

本地候选实现，基于 `e9520b4cf38c309512efa4103107fbd3ee7afd6e`。没有运行真实模型或媒体生成、打开浏览器、修改用户工作区、部署或推送。真实作品验收由集成任务另行进行。

## 产品入口与边界

画布内置助手有未完成制作计划时，点击其图片或视频提议的生成按钮，即沿原生成器提交本次已确认内容，并登记完成后继续原计划的授权。活动画布页面观察原任务；全部任务终态且成功媒体已落地后发起一轮标为「自动继续」的助手消息，只附本次真实结果节点。部分失败进入检查和解释，不自动补单。下一批收费生成仍提出新方案等待人工确认。

侧栏显示等待/继续状态及「停止自动继续」。关闭侧栏不卸载画布观察器；离开画布页面不会新触发模型轮次。重新进入原画布时读取原会话和 Go 回执。已经提交的模型轮次仍按现有 host 执行/恢复，不因关闭页面丢失；这不是关闭页面后持续编排新轮次的后台服务。

接续不读取、发送、拼接或清空未发送草稿、附件、技能选择、临时画布选择。手动检查结果入口保留。检查、剪辑和本地渲染无需再次提交媒体生成，但助手推理和媒体理解仍可能产生模型费用，不能宣传整轮免费。

自动消息展示「生成已结束，继续检查结果和制作。」及「自动继续」标记；完整内部消息仍原样提交和保存。展示依据是 Go claim 回执确定的 `continuationId`，随 host active、turn_end 和 history 投影保留，不依据消息文字或 requestId 前缀。普通用户发送相同文字、以及自动轮中的用户补充仍原样显示。旧版本已结算且没有保存该身份的历史记录保留原文，不从文字推断自动来源。

## 单一事实与执行链

1. `use-canvas-assistant-proposal.ts` 在现有确认快照验证后调用 Go arm。Go 从原业务回合核实所有者、同画布/会话、未撤销、已结算和权限，并固定当前技能 scope/revision。仅计划未完成的确认会登记接续。
2. 既有 image/video executor 决定真实输出节点后、任何付费提交前登记不可缩小的 manifest。原生多输出是一任务多个目标；拆单逐项冻结 operationId/输出集合。登记失败不启动本次生成。
3. Go 只按 owner+canvas+exact operationId 找回任务，复核 task type、原 sourceNodeId、原 outputNodeIds。缺提交回执不等于失败，也不授权重发。List 保存已观察 task IDs，前端复用任务中心的共享订阅，无新任务轮询器。
4. claim 等待所有冻结目标终态。成功结果必须匹配服务端 canonical generation output 的 index、resourceId、target node、媒体类型和 owned READY resource，并已真实保存到画布；取回中、缺节点、输出替换、未知终态保持等待或人工检查。
5. Go 同事务认领授权和创建轮前快照，固定 requestId/turnId，重复 claim 返回同一身份。`/assistant/chat` 对接续从服务端覆盖消息、结果引用和原权限，清空该内部请求的附件/skills/reference；从不采用客户端自报的业务回合。沿原 pi-durable 1.2 submit/observer/history 路径执行。
6. host 既有 per-canvas lock 内恢复/确认 current session，再在官方 submit 前回 Go 验证回执。迟到旧请求不能安装旧 session；请求重放用同一 request/turn pair。已提交输入恢复仍沿官方 durable 队列，没有另建模型 loop。

## 取消与失败

- Stop 先永久取消 Go 授权，再对该回执的固定 session/request 使用现有 targeted Stop；不会取消原收费媒体任务或不相干的新用户回合。已到供应商的在途调用仍遵循现有停止边界。
- 新用户消息 admission、显式新建/切换会话取消尚未运行的授权；已在执行的用户补充沿既有 steer 行为。新 scope 或技能 revision 改变使同会话接续失效。成功 Undo 在恢复画布的同事务取消源回合授权，Undo 拒绝则保留授权。
- 取消同时为已有源回合设置持久撤销标记（schema v19），即使旧确认仍在准备、尚无接续回执，也不能稍后绑定到新意图。旧提案不能在新消息后重新授权自动接续；应由当前任务产生新提案。普通回合保存不能清除标记。新用户回合自己的初始技能选择保留该新回合的提案资格。
- 宿主真实 `skill_load` 用 host-only 的 `origin: skill_load` 标记，要求绑定当前开放轮且操作为 activate；在同一事务验证身份、技能 CAS 和资源后同步同用户、画布、会话和原 scope/version 下仍有效回执的 scope revision。加载原 pin 或新 pin 都不会取消自己或同范围内等待的已确认提案；已取消、完成及旧范围的记录不恢复。用户显式技能选择、clear、new_scope 仍撤销旧自动授权，客户端不能借此标记绕过宿主身份。
- 每次 runtime/操作授权再验证原 scope、未撤销和未取消。Go 明确取消/范围改变时 host 将尚未提交的记录结算为停止，避免残留 active 锁住会话；数据库/网络等未知错误不当作取消成功。
- Go claim 后响应丢失可回读同一身份；官方提交后丢响应按既有 history 恢复。前端不会把自动消息暴露为「新用户请求重试」。手动重新读取只重新核对原回执。
- 如果 manifest 已登记但没有可靠任务回执，或只提交了部分原计划，授权保持未知，不自动补齐收费提交。用户可停止并请求新的明确方案。旧批次没有回执时仍走手动检查。

## 验证

Go SQLite fixture：单图/视频、原生多输出/拆单、缺任务、删除原目标、未落地/媒体被换、部分失败、固定身份重开、Stop/新消息/new_scope/clear/Undo、跨用户/会话；迁移 v17→v18保留历史并拒绝缺字段。

官方 pi-durable Node fixture：重复观察与重启不重复模型请求、旧会话恢复/提交拒绝、Go取消与scope失效、暂态校验失败保留原身份、submit前Stop。所有模型响应由本机受控 HTTP fixture 提供。

前端单元/真实执行器边界：空闲/同画布会话检查、claim期间卸载/换账号/停止/用户新消息、固定真实结果引用且不读草稿、登记失败不开始任务或写占位、既有生成/恢复回归。React 页面实际挂载与产品导航、真实模型计划/剪辑能力、真实收费生成和导出仍需集成验收，单元 fixture 不替代这些结论。

### 本地验证回执

以下命令在对应目录执行，均为本地 SQLite/受控 HTTP fixture，不访问模型供应商：

| 目录 | 命令 | 结果 |
| --- | --- | --- |
| `web` | `bun test test/canvas-assistant-continuation.test.ts test/canvas-image-save-barrier.test.ts test/canvas-assistant-proposal-execution.test.ts test/assistant-history-recovery.test.ts` | 56 pass，207 assertions |
| `web` | `bun run typecheck` | exit 0 |
| `agent-host` | `bun test durable-continuation.test.mjs durable-session-owner.test.mjs system-prompt.test.mjs` | 6 pass，30 assertions |
| `agent-host` | `bun test durable-continuation.test.mjs` | 最后新增取消恢复边界后再跑：1 wrapper pass，内部 6 个官方 Durable Node cases |
| `backend` | `go test ./internal/database ./internal/assistantturns ./internal/handler -run 'Test(Continuation\|V13Workspace\|V14\|V16\|Assistant\|RuntimeLifecycle\|SkillContextHTTP\|SkillContext)' -count=1` | 三包 pass |
| `backend` | `go test ./internal/assistantturns ./internal/handler -run 'Test(Continuation\|AssistantContinuation\|RuntimeLifecycle)' -count=1` | 最后修正暂态 admission 与取消回读后，两包 pass |
| `backend` | `go test ./internal/database -count=1` | 完整迁移包 pass |

最后的 HTTP fixture 还覆盖：客户端自报的更高权限、草稿与无关引用被服务端固定回执替换；首次 host 503 保留同一开放回合，重试不创建新回合；取消后的 runtime 回读允许宿主确认停止。原生三输出 fixture 使用真实 canonical task binding：所有 canonical output 的 binding 指向任务主节点，各输出按不可变 `input.metadata.outputNodeIds[index]` 分配。

本地 stdout 保存在 `/tmp/beeftv-auto-continuation-{web,go,final-admission,final-host,final-database,typecheck}.log`，不纳入源码。没有浏览器截图、真实模型质量、真实付费生成或完整作品导出的验证结论；这些由集成后的独立 review 和真实创作验收补齐。依赖复用隔离 worktree 外现有 `node_modules` 符号链接，未安装或修改依赖，符号链接不纳入提交。

### 独立审查后三项修复

基于 `42d688ab`，先补回归再修复：

- 实际 hook 源码加最小 hooks/timer 适配器，先观察到唯一终态事件后 `claimCount=1`、没有发送；加入 dirty 标记后，旧 waiting 响应返回会自动补查，恰好发送一次。适配器隔离在子进程，不能当作浏览器验收。
- 真实 Go 临时库先取消、再让未登记的旧确认 arm：Stop、新消息、换会话、new_scope/ack、clear、显式选择六种情况原来全部误授权。现在重开数据库仍拒绝，旧回合迟到保存不能抹掉撤销；新用户回合仍可授权新提案。
- 真实 host-only HTTP 路由加载合法安装技能：原实现第一次 activate 就取消自身，随后 404。现在加载新 pin、重复加载、请求重放后，自动轮仍 running/open，绑定上下文及后续操作授权可用；无宿主身份、无绑定轮或伪造 new_scope 均拒绝，显式用户选择仍撤销。

针对验证：前端原四文件 57 pass/208 assertions；typecheck exit 0。Go `go test ./internal/assistantturns ./internal/database ./internal/handler -run 'Test(Continuation\|AssistantContinuation\|SkillContext\|V14\|V16\|AssistantPermissions\|V13)' -count=1` 三包通过，最后另跑 `go test ./internal/database -count=1` 整包通过。`bun test durable-continuation.test.mjs durable-skills.test.mjs` 两个官方 Node wrapper 通过（接续 6 cases，技能 16 cases）；实际 skill_load 带 origin，用户重新选择不带 origin。日志为 `/tmp/beeftv-auto-review-{go-red,skill-red,hook-red,hook-green,final-go,final-host,final-web,final-typecheck,final-database}.log`，测试数据均为临时 SQLite 或本机假模型，无付费请求。

### 同范围多提案的补充回归

基于 `41b64ca3`，实际 Go HTTP fixture 同时建立 A/B 两份已确认回执：A running，B waiting。A 正常加载技能后，原实现只推进 A，B 留在旧 scope revision；回归先红。修复在技能 CAS 同事务推进所有同用户、画布、会话和原 scope/version 的 waiting/claimed/running 回执，不修改 cancelled/done 或已失效范围。B 在第一次加载后可以 claim，第二次加载后仍可用；已取消回执保持不变，用户显式选择仍撤销 A/B。

`continuation_intent_changed` 现在提示「要求已更新，请让助手重新提出生成方案。」；回归确认不提交媒体任务，普通连接错误仍保留原提示。

验证命令：`go test ./internal/assistantturns ./internal/handler -run 'Test(Continuation\|AssistantContinuation\|SkillContext)' -count=1` 两包通过；最后新增 B claimed 状态后再跑 `go test ./internal/handler -run TestAssistantContinuationSkillLoad -count=1`。前端 `bun test test/canvas-assistant-proposal-execution.test.ts test/canvas-assistant-continuation.test.ts` 为 38 pass/100 assertions，`bun run typecheck` exit 0。红绿日志在 `/tmp/beeftv-auto-companion-{red,copy-red,green,final,web,typecheck}.log`；无真实模型、收费生成或浏览器操作。

### 自动消息展示回归

Go HTTP fixture 验证真实 claim 身份转发、普通相同消息不获得自动身份、大小写重复 JSON 字段不能伪造该身份、无回执 ID 不转发。官方 Durable fixture 验证 active、结算和重启后 history 保留身份和完整消息；普通相同前缀消息仍无自动身份。真实 React 组件静态渲染验证自动短文案与普通用户消息、补充消息的区别；不是浏览器截图或真实模型验收。

验证：`go test ./internal/handler -run 'TestAssistantContinuation(HTTP|DisplayIdentity)' -count=1` 通过；`bun test test/canvas-assistant-interruption.test.tsx test/assistant-history-recovery.test.ts ../agent-host/durable-continuation.test.mjs` 为 19 pass/61 assertions（含 7 个官方 Durable Node cases）；`bun run typecheck` exit 0。Go 防伪和 React 展示新增用例均先失败再通过；类型检查首次发现开发面板 fixture 缺字段，补齐后通过。结果来自本次工具回执，未另存 stdout 日志。
