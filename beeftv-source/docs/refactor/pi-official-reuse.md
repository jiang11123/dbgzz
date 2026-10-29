# 官方 Pi SDK 复用矩阵（钉选 1.3.0）

本页记录 BeefTV 内置助手宿主对官方 Pi 1.3.0 的复用。执行运行时只有 `@earendil-works/pi-durable` 一套：新会话走 Durable，已有 JSONL 会话只保留只读历史，不再在其上执行新回合。在旧会话里发新消息会为该画布新建一条 Durable 会话，并用旧会话最后的 user/assistant 文本作为交接说明开头。实现以本仓库 `agent-host/` 与钉选包内声明、示例、文档为准；`pi.dev` 最新文档可能对应更高版本。

宿主启动环境复用 `desktopnet` 的代理选择：非空 HTTP/HTTPS 环境配置优先，否则读取 Windows/macOS 静态系统代理。Go 在启动时覆盖去重大小写代理变量，并默认启用 Node 24 的公开 [`NODE_USE_ENV_PROXY=1`](https://nodejs.org/download/release/v24.15.0/docs/api/cli.html#node_use_env_proxy1)；显式 `NODE_USE_ENV_PROXY=0` 和 `NO_PROXY=*` 保留。`localhost`、`127.0.0.1`、`::1` 始终直连，避免宿主业务凭据进入外部代理。坏代理报连接错误，不自动改走直连；没有新网络执行器、SDK 内部 dispatcher 或重试循环。

Pi SDK 的静态导入会经设置模块加载 npm undici，安装直接连接的全局 dispatcher，覆盖 Node 的初始环境代理。`server.mjs` 因此在全部导入完成、首个请求和 fetch 包装之前，仅对 `NODE_USE_ENV_PROXY=1` 调用 Node 24.14 起公开的 [`http.setGlobalProxyFromEnv()`](https://nodejs.org/download/release/v24.15.0/docs/api/http.html#httpsetglobalproxyfromenvproxyenv)；正式 runtime 为 24.15.0，不调用 SDK 私有 CLI 初始化。`model-proxy-cases.mjs` 启动真实宿主与官方 Durable/ModelRuntime，以本地 HTTP/HTTPS 模型替身、CONNECT 代理和独立 ops 替身验证请求路由、显式禁用、全局 bypass 与代理失败；原生 fetch 单独通过不能替代此消费者验证。

Node fetch 的 bypass 规则与 Go 不完全相同。对固定模型 `BaseURL`，启动器另用既有 Go 选择器判断直连，把该目标主机加入 Node bypass；这保留当前模型的 CIDR、系统 `<local>` 排除以及只设置 HTTP 代理时 HTTPS 应直连的选择。普通重定向继续使用 Node 原生域名/IP/端口规则，不承诺任意新重定向目标也支持 Go 的 CIDR 或系统本地域名规则；不执行 PAC/WPAD。代理设置在宿主启动时取快照，修改代理后需重启宿主。模型 BaseURL 已在供应商指纹内，空闲时更换地址会重启并重新投影；忙时保留原轮模型，不能在原进程内切换目标后沿用旧 bypass。

历史原生音视频的来源由官方已提交工具结果和同会话的准确 submission 身份确定。`done` 与 `unanswered` 都是已结束的轮次：后续模型失败或预算耗尽不抹去此前成功读取的媒体。历史重放仍由 Go 校验原轮次、撤销状态、资源归属和版本，不能由模型文字或本地媒体文件单独授予权限。`TestNativeHistoryRealDefaultHostRestartsAfterBudgetFailure` 覆盖真实 Go 与默认宿主进程重启后的同会话恢复，并保留资源失效时零模型请求的拒绝验证。

媒体检查事实沿既有工具日志、`beeftv.host` 文档和回合历史保存，不新建质量状态库。操作桥只有在 Go 读取成功且媒体内容转换成功后才记录成功与安全摘要；模型文本、工具参数和计划状态不提供检查事实。静态图片的零时长概览不生成影音检查记录，视频抽帧也不计为连续视频读取。用户界面分开显示步骤进度与各资源版本的实际读取、检测区间，整段静音是测量结果，不自动判定创作失败。原记录没有摘要时不猜测补齐；自然语言要求是否满足、角色一致性与语义质量的自动验收不在此合同内。

本地钉选版本：`pi-durable`、`pi-coding-agent`、`pi-ai` 与 chord 1.3.0。配套 agent-core、codemode、mcp、tui、telemetry 通过 overrides 同钉 1.3.0，避免上游范围依赖自动选择未经验证的版本。锁文件由 Bun 生成；没有修改官方包或另建模型执行循环。Durable 接入验证见 [持久宿主验收](durable-host-verification-20261008.md)。

从 1.0.4 升到 1.2.0 时已适配破坏性改动：业务工具的结果改用 `output` 字段返回；已有会话的磁盘格式标记仍是 1.0.4，旧会话照常打开。

## 新会话的官方 Durable 路径

- `durable-session-owner.mjs` 使用 `Harness.open`、`openNodeSqliteStorage`、`defineDoc`、`defineExtension`、`defineTool` 与 `watchEvents` 管理会话、提交、工具与持久事件；不在 AgentSession 外再套 Harness。
- 旧 JSONL 会话退役交接：每个画布内的旧会话固定对应一条 Durable 接续会话，身份写入清单，交接完成状态写入官方 SQLite；`handoffSession` 仅首次用官方 `root.reset(handoffNote)` 写入旧文本，再发布当前指针。失败、断线或重启后的旧 ID 重试复用该会话，不重置已有上下文；显式新建仍创建独立会话，切换旧会话仍可只读历史。NDJSON 在首轮开始时发送 `session` 行，让界面及断流恢复立即使用实际会话 ID；未收到此行也不影响服务端幂等。不调用模型生成摘要，也不把旧 JSONL 导入 Durable。
- Go 拥有业务回合、素材归属、权限、付费批准、操作去重与撤销。宿主开始或恢复执行前读取 Go 回合记录；HTTP 客户端离开不自动结算持久执行。
- 完整应用退出时，先让 Durable 宿主释放活动调用，期间保留业务 HTTP 服务；随后取消 HTTP 请求上下文，让事件流退出，再停止工作器与关闭数据库。单独关闭面板或断开浏览器流不触发这条应用退出流程，也不取消已受理业务任务。
- 每轮工具通过官方 `registry.install` 和 `root.configure` 配置。内置“只读 / 当前画布 / 完全访问”由 Go 持久记录决定，补充消息和恢复不能升权；具体合同见 [Agent 权限与外部工具](agent-access-20261008.md)。
- 媒体短引用保存在会话中，实际发出模型请求前读取已校验的文件并重新核对当前业务归属。技能目录使用官方 section，常驻显示名称、说明和 id（每页最多 50 个、说明最多约 300 字）；更多技能通过 `skill_catalog` 搜索或翻页。每次新的明确选择都按固定版本展开到用户消息，模型调用 `skill_load` 时正文进入工具结果；相同请求的网络重试由 Durable 提交回执去重。`loadedSkills` 只记录历史读取，Go 的 `AssistantSkillContext` 单独保存活动版本、scope 和 revision。活动规则通过官方 section 从 Go 重建，压缩和进程重启不会依赖摘要保留原文；每次真正发出模型请求前重新验证权限、版本和正文。Durable 会容纳 section/hook 异常并保留旧段落，因此硬性拒绝由 Pi Models 的 provider 准入适配执行，不仅靠 hook 抛错。清除活动技能保留当前对话历史；独立任务调用官方 reset 切断旧的模型可见上下文，界面历史仍保留。具体 HTTP、幂等与预算合同见 [技能上下文](./assistant-skill-context.md)。
- 以下 SDK 矩阵和 JSONL 所有权规则仅说明已有 JSONL 会话的只读读取，不是新 Durable 会话的数据格式。

## 官方来源

| 来源 | URL / 路径 |
| --- | --- |
| 公开 SDK 文档（可能新于钉选） | https://pi.dev/docs/latest/sdk |
| 公开事件流说明 | https://pi.dev/docs/latest/json |
| 公开设置参考 | https://pi.dev/docs/latest/settings |
| 仓库 | https://github.com/earendil-works/pi |
| 钉选 Durable 文档 | `node_modules/@earendil-works/pi-durable/README.md` |
| 钉选 Durable 类型（`Conversation.reset` / `Harness.root` / `settings.stream`） | `node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts` |
| 钉选 SDK 文档（旧 JSONL 只读路径） | `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` |
| 钉选事件语义 | `node_modules/@earendil-works/pi-coding-agent/docs/json.md` |
| 钉选设置默认值（旧运行时，仅参考） | `node_modules/@earendil-works/pi-coding-agent/docs/settings.md` |
| 旧 JSONL 示例（只读参考） | `examples/sdk/10-settings.ts`、`11-sessions.ts`、`12-full-control.ts`、`13-session-runtime.ts` |

## 复用矩阵

| 官方能力 | 决定 | 说明 |
| --- | --- | --- |
| `SessionManager` JSONL v3 | 只读 | 旧会话历史与画布轮次（`beeftv.canvas.turn` / `.started` custom entry）按官方 JSONL 读取；新回合不再写入。新会话的 transcript 在 Durable SQLite。 |
| `createAgentSession` | 不采用 | 旧 JSONL 会话执行运行时已退役；新会话由 Durable Harness 装配。 |
| `AgentSession.prompt` / `abort` / `subscribe` / `dispose` | 不采用 | 旧运行时的 create / prompt / replace / abort 执行路径已删除。 |
| `AgentSessionRuntime` | 不采用 | 画布级装配与替换由 Durable Harness 负责。 |
| `SettingsManager.inMemory` | 不采用 | 旧运行时设置已删除；Durable 的 `settings.stream` / `retry` / `toolExecution` 在 `durable-session-owner.mjs` 显式钉值。 |
| 全控 `DefaultResourceLoader` | 不采用 | 旧运行时 loader 已删除；Durable 把产品 `SYSTEM_PROMPT` 作为 instructions，工具由 `registry.install` 显式装配，不发现宿主机资源。 |
| `Harness.open` / `openNodeSqliteStorage` / `defineDoc` / `defineExtension` / `defineTool` / `watchEvents` | 采用 | 新会话唯一的执行装配与持久事件来源。 |
| `root.reset(handoff)` | 采用 | 旧会话退役交接：把旧会话文本写成新上下文开头的官方 reset 条目。 |
| `root.submit` / `submission.wait` / `root.abort` | 采用 | 回合提交、终态结算与停止；`whenBusy: "steer"` 用于运行中补充。 |
| pi-coding-agent 技能（`formatSkillsForPrompt` / `/skill:name` 展开） | 照样实现 | Durable 没有技能组件。目录按 `<available_skills>` 的格式写成常驻系统提示段，正文按官方 `<skill name=…>` 块写进用户消息或 `skill_load` 工具结果；目录函数要求本机文件路径，不直接复用。 |
| `thinkingLevel`（根会话） | 采用 | 默认 `low`（约 2048 个思考 token），可用 `BEEFTV_AGENT_THINKING` 改为 off、minimal、low、medium 或 high；已有对话在下一轮开始时跟上。只对 Anthropic 协议的模型打开思考，思考和回答共用 `BEEFTV_AGENT_MAX_TOKENS`（默认 16384）。 |
| `GenerationTask.beforeRequest` hook | 采用 | 准备请求前重读 Go 授权、历史素材归属与补充输入，并在实际 HTTP dispatch 前转换已验证的媒体结果。 |
| pi 的字节级空闲超时（undici `bodyTimeout` / `httpIdleTimeoutMs`） | 不采用 | 只按“收到任意字节”重置，SSE 心跳会把它续上；且不在 Durable 路径安装。宿主保留按实际文本/工具进展计时的空闲上限，见 `model-stream-idle.mjs`。 |
| `auto_retry_start` / `auto_retry_end` | 采用（只读进度） | 重试仍由官方任务按 `settings.retry` 执行，宿主不另做重试。事件映射为已有的 `lifecycle` 行 `retry`（`attempt` 与归类后的 `reason`：`rate_limited`、`timeout`、`provider_unavailable`、`network`、`model_error`）和 `retry_end`；上游错误原文不进入 NDJSON 或历史。映射在 `durable-session-owner.mjs` 的 `durableStreamEvents`。 |
| `watchEvents` 完整文字事件 / `watchDoc` 制作计划 | 采用（只读投影） | `durable-stream-text.mjs` 按本次 submission 的用户 entry 限定范围，处理初始/溢出 snapshot、message_start、text_start/delta、block/message 替换及 message_end；向页面发送可替换的 `text_snapshot`，不把初始块和最终尾部当作空增量丢掉。制作计划订阅已提交的 `beeftv.host` 文档，变化时发 `plan`，不等待整轮结束。观察者关闭时释放两项订阅。 |
| `compaction_*` | 不映射到面板 | Durable 的压缩在官方任务内部完成。 |
| 官方 TUI / RPC 实验服务器 | 不采用 | 产品 UI 是 React + Go 代理。 |
| `@earendil-works/pi-web-ui` | 不采用 | 钉选时代的包是过期 Lit + IndexedDB，且会在浏览器里跑 Agent。 |

## 宿主内部分工

| 模块 | 责任 |
| --- | --- |
| `durable-session-owner.mjs` | 官方 Durable 会话装配、按画布预约队列、提交/恢复/停止、原子指针、官方 SQLite 持久事件。 |
| `session-owner.mjs` | 旧 JSONL 会话只读历史、`current.json` 指针读取，以及旧会话 → Durable 的交接说明提取。 |
| `operation-bridge.mjs` | 已鉴权 `/api/ops`、scope 注入、`customTools`。 |
| `server.mjs` | 本机 HTTP、鉴权、预算 fetch 包装、NDJSON、SIGTERM/SIGINT 释放会话。 |

## 会话所有权

- 预约按 `canvasId`：`createSession` / `handoffSession` / `activateSession` / `ensureSession` / `submit` 共享一条队列；不同画布并行。
- `submit` 在同一把锁里恢复或新建 active，并把 `busy` 交给官方 generation；忙碌会话的 `createSession` 在发布指针前拒绝（409 `session_busy`）。
- 候选先 `prepareSession`（写清单、开 Harness），指针 `current.*.tmp` + `rename` 成功后才写入 Map；指针失败则关闭候选 Harness、保留旧活动会话。
- `ensureSession` 只把缺失指针（`ENOENT`）当成可回退：没有会话就新建。EISDIR、损坏 JSON、SDK 装配失败原样抛出。
- 交接 `handoffSession` 先 `root.reset(handoffNote)` 再发布指针；reset 失败则关闭候选 Harness，不安装。
- 读取不重放恢复：`recover` 在该会话已有官方 `wait` 观察时直接返回，不再 hydrate、不重读 Go 授权、不重新提交；并发读取共用同一次恢复。`/history` 读取当前会话的活动 owner 时不重写 `current.json`。
- 运行中进度：宿主把最近一条重试或工具进度投影到 `/history` 的 `active.lifecycle`，回合结束或观察结束即清空。重复的 `/chat` 接到运行中的回合时先补发这条进度。业务工具用官方 `api.details` 保存阶段；重开后的官方 snapshot 可以恢复正在执行的阶段，不新增进度数据库。
- 观察断开：`/chat` 已开始输出后宿主观察失败时发 `observer_error`；界面不报失败，改为读取历史，直到读到最终回执。
- 按请求停止：界面每次发送生成一个 `requestId`（`[A-Za-z0-9_-]{1,128}`），随 `/assistant/chat` 转给宿主，作为官方 `submit` 的 `requestId`。Go 只校验格式，回合 ID 与授权仍由 Go 生成，`requestId` 不能代替它。停止带 `{canvasId, sessionId, requestId}`：Go 校验两者成对、格式有效、画布归属，只转发这三个字段；宿主核对会话属于该画布（Durable 清单所在目录，或该画布的旧会话），否则 404。不带这两个字段的旧调用仍按画布停止当前回合。
- 停止意图沿 STATE 文档与官方提交记录：`cancelRequest` 先按画布、会话、请求身份同步记入内存（同一进程里正持有画布锁的 `submit` 也能读到，同画布其他会话的同名请求不受影响），再一次提交写入 `STATE.stopRequests`（有上限）；该请求已是 `active` 时同时置 `active.stopped`。会话还没打开（如重启后）就在画布锁内临时打开它写入再关闭，不调度任何官方工作。返回 `stopped`（正在执行：沿用原有的标记停止、结算 Go 回合、官方 `abort`）、`finished`（已有记录）或 `pending`（这里还没开始执行它）。别的请求不受影响。
- `submit` 在三处读停止意图：已有记录时不再执行（同一请求重发、换了 Go 回合 ID 时，结算这个新回合并返回原记录）；准备前（停止早于 `/chat` 到达）；写入 `active` 之后、调用官方 `root.submit` 之前同步再读一次（停止发生在准备期间）。命中时如果官方队列里还没有它，先把停下结果存为 `active.result`（`cancelled: true`，`status: unanswered`，没有 `submissionId`，`change: null`），撤下它本要载入的技能记录；Go 确认结束后才移入历史并清空 `active`。确认失败或进程退出后，恢复只补确认；Go 已关闭时直接完成本地历史，不要求存在官方提交。这个路径没有模型请求、工具或画布写入。已在官方队列里则按该请求身份标记停止并 `abort`，按官方结算记录。
- 停止与后续请求竞争：HTTP handler 固定原 `requestId`，从停止标记提交取得原 `turnId`，不在等待 Go 后重新读可变的当前回合。`stop` 在画布预约锁内再核验原请求，持锁完成官方会话级 `abort`，防止期间新请求被接受后遭误停。观察旧提交的 `wait` 也只结算该提交的请求，不能用旧结果结束新回合。
- 崩溃窗口：停止已提交、官方 `submit` 还没发生时进程退出，或停止与官方入队之间进程退出，重启后的 `recover` 读到停止意图就走 `stop`：先查 `active.submissionId`，再按 `requestId` 查官方提交；都没有时在画布锁内记为已停下，有则 `abort` 后等官方结算。不会重新提交。
- 界面在消息发出前（就绪检查、读取对话阶段）停下时，清掉待发送内容，提示“已停下，这条消息没有发出。”，可用“重试”原样再发。发出后停下：停止返回 `pending` 且历史里既没有进行中的回合也没有它的记录时，提示“已停下，这条消息没有被处理。”，结束等待、不再轮询，可重试（新的 `requestId`）。其余按历史里的停下记录收尾。
- Go 转发 `/assistant/chat` 不设整体超时，只限制等宿主回应头的时间（10 分钟）；NDJSON 持续到官方回合结束，包括模型重试与退避。
- 进程 `SIGTERM`/`SIGINT` 先把 store 标为关闭，排空该画布预约队列，再 `disposeAll`（关闭官方 Harness）。关闭后新的预约直接失败。`SIGKILL` 仍无法拦截，中断回执语义不变。

## 仍由本产品持有

- 制作现场摘要与未绑定媒体检查读取 `canvas.get` 的完整 `result.canvas`，保留本轮身份与后端读取范围校验；只读模式不需要写操作能力。分页只用于模型工具返回。读取失败或返回结构未知时撤下当前摘要，不把未知状态当作空画布，也不覆盖最后成功快照；恢复后再比较真实状态。差异基准记录成功读取的版本，旧宿主未记录版本的缓存首次读取只重建基准，不宣称节点新增或删除。
- 画布 scope、operationId、用户确认后的生成、单轮/总预算、中断回执、按画布身份。
- React 只消费 `/api/assistant/*` 流，不在浏览器建 Agent 或 SessionManager。

## 已验证（钉选 1.2.0，本地替身，无付费模型）

- `session-owner.test.mjs`：旧 JSONL v3 历史（用户消息、BeefTV 轮次）仍可读取；`handoffNote` 只取最近 20 条、总长截断到约 8000 字符；`readHandoffNote` 含旧会话文本，找不到会话时返回空说明。
- `session-identity.test.mjs`：同一 toolCallId 在两条会话不撞 operationId；旧 JSONL 会话仍能按 id 找回。
- `session-lifecycle-host.test.mjs`：真实宿主 HTTP 新建/并发替换、忙碌 409、指针目录失败、SIGTERM 释放；旧 JSONL 会话发新消息会新建 Durable 会话，模型请求带上交接说明，后续回合走新会话（本地替身模型）。
- `durable-session-owner-cases.mjs`：官方 Durable SQLite 崩溃/重放/steering/stop/history；`handoffSession` 用 `root.reset` 写入交接说明，模型请求带上旧会话文本。
- `durable-request-budget.test.mjs`：总预算跨真实宿主崩溃与文件系统故障。
- `host-runtime-probe.test.mjs`：预算耗尽、素材参数、引用画布读取。
- `system-prompt.test.mjs`：媒体策略与产品 system prompt 约束。
- `durable-recovery-cases.mjs`：延迟停止旧请求不能中止新请求；观察旧提交不能结算新回合；停止意图不能跨会话影响同名请求；提前停止的 Go 确认失败后，重开可补确认或按 Go 已关闭状态完成历史，始终零模型请求。官方 `wait` 进行中反复 `recover` 零提交、零写入、零授权，且不覆盖内存中的本轮改动；并发 `recover` 只提交一次。停止已写入、官方 `submit` 前崩溃，重启后记为已停下、零提交、同一请求重发也不执行；崩溃后按 `requestId` 停止，`recover` 不重新提交，下一条请求照常执行；已进官方队列的停下请求崩溃后被 `abort`，零模型请求。
- `durable-stream-events.test.mjs`：官方事件到 NDJSON 的映射、重试原因归类，以及历史进度的设置与清空。
- `model-stream-idle-cases.mjs`：官方空闲重试产生 `retry`（`timeout`）与 `retry_end`，不带上游原文。
- `session-lifecycle-host.test.mjs`：真实宿主运行中反复读取历史不再请求 Go 回合接口、不重写指针；503 首轮经官方重试后，流与历史都显示归类后的重试进度，结束后 `active` 为空；在 `/chat` 读取 Go 回合时、以及 `submit` 自己的授权读取时按请求停止，都零模型请求、零画布操作，历史记为已停下，Go 只结算这两条回合，之后的新请求照常执行；停止早于 `/chat` 到达时只停这一条，同一请求换 Go 回合重发、重启后都不执行且各自的 Go 回合被结算，重启后没有活动会话的停止返回 `pending` 而不是 404，未知会话或别的画布 404；运行中指向别的请求的停止不影响当前回合。
- React：`lifecycle` 与 `agent_end` 都不结算回合；压缩/重试文案不出现内部事件名；`observer_error` 后改为读取结果并显示历史里的进度（`assistant-stop.browser.test.ts`）；停下前已改动画布的回合提供“继续处理”，没有改动的停下回合不提供；发出前停下不留待发送内容，不发聊天或取消请求；发出后、助手还没处理就停下时，停止带这次发送的会话与请求标识，结束等待、不再轮询，重试用新的请求标识。
- Go：`assistant_request_stop_test.go` 覆盖 `requestId` 格式校验（不合格 400 且未进入回合）、不替代 Go 回合 ID、旧调用不带它；停止只转发校验过的目标，成对缺失或格式不对 400，别人的画布 404。

2026-10-11 退役验证：`bun install --frozen-lockfile` 通过；完整 `agent-host` suite 119 项通过、0 失败（约 220 秒）。真实媒体/steer 探针仍为本机替身、没有付费模型调用。

## 宿主扩展装配

`createDurableSessionStore` 接受可选 `extensions(entry)`；当前只安装产品技能扩展 `createDurableSkillExtension`（按 Go 记录的 skill pins 展开正文）。Durable 的 instructions 直接使用 `system-prompt.mjs` 的 `SYSTEM_PROMPT`，工具由 `registry.install` 显式装配；媒体转换在宿主 HTTP dispatch 执行，同一会话只保留官方执行循环。

## 本地补丁候选的工具与模型修复

以下为本地候选实现，正式发布与原生验收状态以对应版本回执为准。

- 成功的 `canvas_generation_propose` 在本次有效提案已进入 effects 后返回官方 `control.terminate`；`finally persistEffects`、官方终态、Go complete 确认和 UI `turn_end` 的顺序不变。仅当本次响应所有工具都请求 terminate，Durable 才正常结束并省去总结模型请求；失败或混合工具回合仍继续，Stop 与已接受补充消息保持原语义。先完成 `plan_update` 再提案，宿主不替模型改计划。官方 SQLite fixture `durable-proposal-yield-cases.mjs` 覆盖工具独立结束、混合/失败、补充消息、Stop、完成确认失败后重开及同请求回放；空回复的历史确认卡另由前端组件回归覆盖。

- `canvas_get` 的模型读取采用有界分页，完整字段读取和 revision 校验见 [`canvas-read-view.md`](../../agent-host/canvas-read-view.md)。Go 原始画布内容与授权校验不变。
- `canvas_node_update`、`canvas_node_configure`、`canvas_node_bind_asset` 的模型回执只保留节点身份、本次修改字段的实际值和业务成功回执（含 revision、素材引用）；不会重复回送完整节点。长字段返回明确的 preview 与 `readView`，可经 `canvas_get` 按版本读取原文，防止官方 50KB 工具输出上限截掉回执末尾。Go 原始结果、宿主 effects、幂等与撤销存储不变；HTTP bridge 回归见 `agent-host/operation-bridge-write-view.test.mjs`。
- 参数已知且不依赖其他结果的只读查询，可在同次响应提出多个调用，仍逐个执行。已知节点 ID 且参数互不依赖时，助手也可在同次响应提出多个 `canvas_edge_create` / `canvas_node_configure`。执行仍由官方 Durable 串行调度，bridge 只续接本轮自己的写入版本；外部变更继续由 Go CAS 拒绝。这不是整批事务或遇错自动停止，依赖新 ID / 返回结果的调用须等待，收到冲突后须重读。`agent-host/durable-write-batch-cases.mjs` 用真实官方运行时、同一假模型响应的三个工具调用和本地 CAS 服务验证串行、版本续接及外部冲突；不代替真实模型行为验收。
- 新轮次通过官方 Durable 根 Agent 的 `configure` 同步宿主选定模型；未完成轮次按活动轮次中固定的模型恢复。原模型不可用时拒绝调度，不切换模型或假称完成。
- 内置 `canvas_search` 的可选 `projectId` 表示项目过滤条件，省略时搜索本账号全部画布；宿主转为现有公开操作的 `canvasId` 项目过滤字段，且不注入当前画布 ID。公开 MCP/CLI 参数保持原样。`project_canvas_search` 的 `canvasId` 仍表示用于确定项目的真实画布。
- 搜索回归覆盖内置工具实际 HTTP 参数、同账号未归项目的两张画布、显式项目过滤、跨账号隔离和原有 scope/CAS。测试路径为 `agent-host/operation-bridge-search.test.mjs` 与 `backend/internal/app/operations_workspace_canvas_search_test.go`；替身测试不能代替原生助手验收。

## 限制

2026-10-19 本地候选：已确认生成的接续不再依赖当前画布的 React effect。Go 复用既有 generation recovery worker，分页读取 `assistant_continuations`，在任务终态、素材保存及节点绑定完整后认领原 receipt；后台与前端提交相同 `requestId/turnId`，由官方 Durable 去重。断流或未知受理只重观察原身份，只有目标回合终态或既有 host completion 回调结算；Stop、新意图和关闭 scope 继续通过持久状态阻止接续。应用退出时取消观察，重开重新认领，不在退出期间运行本地制作。没有新增队列服务、数据库或 Agent 循环。

接续支持图片、视频和音频。整片提案先保存全部有限素材草稿，界面确认后在既有 `AssistantTurn` 保存精确授权。既有 continuation 扫描在认领模型轮次前，按该授权提交依赖已保存的剩余素材；独立旁白可与首帧并行，参考图的 canonical output、资源与实际节点绑定均一致后才提交视频。事务提交这些业务任务后仍保留同一 waiting receipt；全部素材保存后再认领原模型轮次，不需要模型逐批催做。失败回到原任务检查，不重买；Stop/scope 校验先于任何新准入，已有任务键仍是 `proposal:<proposalId>:<nodeId>`。`canvas.generation.submit` 保留原任务恢复入口。新增素材或改变模型、提示词、数量与参数仍须重新确认。它是有限素材授权，不代表人民币预算硬封顶已实现。回归见 `assistant_production_progress_test.go`；真实新片的性能须另看冻结版本记录。

`await-business-tasks.mjs` 只在官方 Durable 工具内部观察 Go 已受理的任务，等待任务成功、输出资源保存及目标节点实际绑定；它不请求模型、不提交替代任务、不创建队列。提交操作标记可重放的依据是 Go 原子操作回执及稳定 `proposal:<proposalId>:<nodeId>` 任务键，而非供应商生成可任意重试。Stop 沿官方工具 signal 结束观察，未知状态仍保留原身份。后台首批接续继续使用既有 worker。工程交付采用原生 v4 ZIP 与已有资源下载，不引入第二种工程格式或渲染器。测试见 `assistant_production_test.go`、`await-business-tasks.test.mjs`、既有后台接续及 Durable 测试；真实整片与 GUI 改稿另记验收回执。

Pi 1.3.0 候选沿用磁盘布局标记 `1.0.4` 与官方 SQLite schema 1；包版本不作为数据格式版本，升级不重置旧会话。业务进度只接受 `processing/downloading/saving/saved/binding/rendering/exporting/checking/observation_unavailable`，来自本地任务的真实传输状态、已保存资源与确定性操作。`task.get.delivery` 复用既有下载进度；面板不显示供应商原文、临时 URL 或估计百分比。相互独立的原任务查询并行读取；失败任务不会使仍在保存的成功同批素材提前结束等待，明确的保存错误则返回原任务及不完整状态，不能自动再买。

减少机械模型往返：`model.catalog` 可用 `capabilities` 一次读取所需类型；`canvas.script.prepare` 可直接传 `script:{title,rows}` 创建新分镜及生成草稿，复用节点默认值和分镜行构造，在一次 revision 保存，回执、回放、撤销仍属于原操作。`canvas.generation.submit` 省略 `kind` 时按节点实际类型执行已确认、相互独立且参考已就绪的混合批次；确认的输入与稳定任务键不变。内置 `canvas.timeline.render` 在事务提交后复用同一工具等待器，成功与文件保存后才返回模型；观察失败返回原任务及 pending，Stop 继续中断。公开渲染操作仍返回受理回执，不在数据库事务中等待 FFmpeg。

`media.overview.evidence` 合并同一媒体快照的确定性读取：已知区间不超过15秒时，一次返回所选静态帧、连续视频、音频及客观检测；共享归属、版本、源字节和总内容上限。宿主逐项记录实际成功证据，不做自动质量判断；官方 Durable 仍决定后续操作，生成授权、画布 CAS 和工程导出保持原责任。单次工具减少不等于真实模型耗时已经降低，需另做真实运行验证。

`canvas_timeline_deliver` 是宿主内的确定性组合工具：按需保存时间线，然后渲染、等待文件、创建空成片节点、绑定原任务、导出工程。各阶段通过官方 `api.executeTool` 调用已有 Go 操作，使用固定 nested key；恢复沿用官方子任务和业务回执，不新建模型循环或执行状态库。创建节点仍使用渲染前的精确 revision，外部修改会返回冲突；失败返回原任务和已完成阶段，只继续失败步骤。媒体检查仍另用实际成片的 `media_overview`，交付回执不等于创作质量通过。绑定的模型回执省略整份画布，保留当前状态/身份/版本与按需读取入口，Go 原始回执和撤销数据不变。

字幕可用 `lines` 数组逐行输入，宿主转换成现有 Go 工程格式的真实换行，优先于旧 text，不修改原调用参数。该组合已通过官方 SDK 加本地业务替身的正常、大回执、版本冲突、导出失败后仅补导出回归；真实 Go/SQLite/FFmpeg 回归还在渲染受理后杀死 Node，重开原会话完成绑定和工程，断言只有一个渲染任务、工程字幕一致且实际媒体非空。模型为本地脚本替身。另有冻结版本的真实模型改稿与新片记录；测试通过本身不证明创作质量或普遍性能。

当前 `gemini-3.8-flash` 的 OpenAI 兼容通路曾在原始响应中将多个函数参数拼接为一个字符串，`parallel_tool_calls=false` 也未阻止该错误。宿主给此模型增加每次响应只调用一个工具的说明，业务工具内部批量不受影响，不猜测恢复已经丢失的调用名与编号。其他模型保留多工具建议。需在该通路多工具原始响应与完整工具结果回传验证通过后再移除此限制；这是一条兼容提示，不是对任意供应商响应正确性的保证。

制作技能也按当前业务工具执行：系统提示不再要求每个技能步骤都等待确认；内置技能 `14811816970252` 改用 BeefTV 分镜、节点、生成提案、媒体检查与时间线工具，去掉外部 CLI、固定模型和虚构文件操作。技能包仍按内容版本保存，既有安装版本与活动任务 pin 不自动改写；只有加载新版技能的任务才使用新版方法。

- 未接官方 web-ui / TUI / 实验服务器。
- 旧 JSONL 会话只读：不自动迁入 Durable；发新消息时以交接说明开一条新 Durable 会话，旧文件保留。交接前按请求停止写入同一确定身份接续会话的官方状态文档，不切换当前指针或调模型；重开并交接后，该请求仍保持停止。
- 压缩依赖官方内部路径，其内部事件名不映射到面板。自动重试只以归类后的进度显示，次数与退避仍由官方策略决定。
- 官方 `SessionManager` 在出现 assistant 消息前延迟落 jsonl；宿主读取历史时只认已落盘的会话文件。
- Go 媒体操作、时间线修改、事务内本地渲染接入见 `agent-media-harness-integration.md`；没有改付费生成协议或默认主模型。

新用户输入或切换会话时，先在现有 continuation receipt 保存 `stopping` 并撤销业务写权限，再用原 canvas/session/request 调用官方 host 的 targeted cancel。host 会先回调 Go complete、再 await Durable stop，因此 complete 不能擦掉待确认的停止身份；只有 host 明确确认后才标 cancelled 并接纳新输入。HTTP 未知保留 stopping 供原请求重试，显式 steer 保持原执行。
