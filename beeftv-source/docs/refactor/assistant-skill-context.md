# 内置助手的活动技能上下文

Go `assistantturns` 管理当前正在使用的固定技能版本；Pi Durable 1.2.0 继续拥有对话、提交、压缩和恢复。活动选择不复制技能正文。宿主的历史 `loadedSkills` 只描述曾经读过什么，不用于决定当前选择。

## 数据与请求

`assistant_skill_contexts` 以 `(user_id, canvas_id, durable_session_id)` 定位，保存 `scope_id`、`revision`、`active_pins_json`、`lifecycle`。`assistant_skill_context_mutations` 保存请求摘要和原结果，使旧请求即使在后续修改以后重试，也只能读取原回执，不能覆盖新状态。每次更新按 revision 比较写入。

用户界面入口（经过既有本机同源、身份和画布归属检查）：

- `GET /api/assistant/canvases/:canvasId/skill-context?sessionId=...`
- `POST /api/assistant/canvases/:canvasId/skill-context`

GET 返回 `{canvasId, sessionId, scopeId, revision, activePins, lifecycle}`。省略 sessionId 时宿主使用当前 Durable 会话，没有会话则新建一个空会话。旧 JSONL 会话只读，需先发消息交接为 Durable 才能使用活动技能控制。

POST 参数为 `{sessionId?, action, expectedRevision, requestId, pins?}`，使用相同响应信封。`activePins` 是原有 `{skillId, versionId, contentHash, skillName?, version?}`。`requestId` 必须在客户端保存用于重试，同请求标识不能复用于不同的 action/pins。陈旧 revision 返回 409 `skill_context_revision_conflict`，同标识不同内容返回 `skill_context_request_conflict`；宿主正在执行时拒绝手工修改并返回 `session_busy`。

已提交的同内容请求优先返回原回执，不因技能包后来被移除而失效；新写入只有确认单个技能资源不可用时才返回 `skill_context_pin_unavailable` 和 `details.skillId`，结构、正文总量、网络与数据库错误不使用此原因。

| 操作 | 行为 |
| --- | --- |
| `activate` | 使用完整 pins 替换活动集合，最多四个固定版本；先验证当前安装资格和文件内容 |
| `refresh` | 重新读取当前固定版本；不切换到市场或本地最新版本，不接收 pins |
| `clear` | 清除活动集合；不接收 pins；旧指令仍可存在于本次对话历史 |
| `new_scope` | 将显式提供的 pins 用于独立任务；省略即不保留技能；官方 reset 排除旧的模型上下文，界面历史保留 |

`new_scope` 先在 Go 保存 `reset_pending`，宿主调用官方 `root.reset` 后确认同一 scope/revision，才恢复 `active`。在 reset 后、确认前终止进程时可以安全重复 reset；在确认后重试原请求只读当前状态，不再清空后续任务。新的模型请求在待重置状态下被拒绝。

宿主内部通过 `/api/assistant/runtime/canvases/:canvasId/skill-context` 读取和更新，使用已有 loopback + host capability 校验。带 turnId 时必须是当前用户、当前画布、同一 Durable 会话的开放回合。`ack_reset` 只存在于宿主内部入口。模型不能发现这些生命周期操作，也不能选择其他作者身份。

## 上下文和版本恢复

明确选择的新请求重新读包并展开到本条用户消息；相同 requestId 的已提交/活动请求复用提交回执与已展开正文。普通继续沿用 Go 的活动 pins；技能更新不改变这些 pins。`skill_load` 对已活动技能优先读取其固定版本；尚未活动的技能从当前安装目录读取。辅助文件继续走 Go 的只读资源操作，不提供脚本执行。

官方 `beeftv_active_skills` section 每次准备模型请求时从 Go 的活动 pins 和包服务重建完整必要规则。压缩摘要即使漏掉规则，下一次 section 仍能恢复。section/hook 异常在 Durable 中会被报告并容纳，旧段落可能继续保留，因此宿主还在 Pi Models provider 适配器执行准入：重新检查开放回合、当前 scope/revision、包身份和正文，并校验已准备的 section 是当前内容。失败返回本地错误流，provider 尚未运行，不能靠旧缓存继续。

每份正文保留 256 KiB、合计 512 KiB 的读入限制。模型上下文准入另按所选模型的 contextWindow 和 maxTokens 计算：技能 section 的 UTF-8 字节数作为保守 token 上界，不超过 `min(contextWindow/4, contextWindow-maxTokens)`；SDK 不提供精确 tokenizer。超出时返回 `skill_context_budget_exceeded`，不截断关键规则。这项容量检查不代表模型一定遵守规则；付费和业务权限仍由 Go 检查。

技能目录最多在 system 段显示 50 个项目，`skill.catalog` 接受 `id` 精确查询、`q` 名称/说明搜索及 `offset/limit` 翻页（limit 最大 50），过滤发生在截页前，始终不返回正文。宿主 `skill_load` 对未显示的 id 使用精确查询，避免第 51 个以后无法加载。

## 验证范围

- 宿主本地假模型用例：显式重选、同 requestId 重试、继续、恢复、工具加载、压缩后规则恢复、clear 与独立 scope、旧 reset 回执重试、包停用后的零 provider 请求。
- Go 服务/HTTP：归属、会话绑定、CAS、旧请求回执、重开服务后的活动 pins、reset_pending/ack、超过 50 项的搜索和精确查询。
- 真实 Go HTTP/SQLite 到独立 `server.mjs` 进程：选择固定包、读辅助文件、写画布草稿、SIGKILL 后新 PID 继续、同 pin 重新选择、独立 reset 后无旧指令且保留界面历史。

这些验证不调用付费模型；模型实际服从与作品质量属于另外的验收。进程终止测试不证明在途上游付费调用可以任意重试。
