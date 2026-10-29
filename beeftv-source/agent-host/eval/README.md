# BeefTV 内置创作助手评测台 (`agent-host/eval/`)

本目录提供内置创作助手评测台（Evaluation Harness）。通过内存版 Go 业务权威模拟器（`sim-go.mjs`）与 7 个固定创作场景（`scenarios.mjs`），驱动真实的 `agent-host/server.mjs`（Durable SQLite 会话、操作桥、画布 CAS 与技能加载）执行回归评测。`fake` 模式使用写好工具调用的本地模型桩，零外部扣费；通过只证明宿主和模拟业务链路可运行，不能证明真实模型的创作质量或实际 Go 后端、桌面交互已验收。

实际 Go 回归由 `backend/internal/handler/timeline_delivery_integration_test.go` 运行：官方 Durable、SQLite、FFmpeg、节点绑定与含素材的工程导出；还会在 Go 已接受渲染但宿主未收到回执时杀死 Node，再用原会话恢复，断言只有一个渲染任务。模型为本地脚本，不购买媒体。

真实制作的阶段报告可用 `python3 agent-host/eval/report-production.py --profile <隔离桌面数据目录> --run <证据目录>` 生成；已有素材改稿加 `--existing-media`。证据目录须有 `full-lifecycle.json` 或 `receipt.json`，提供 `startedAt/canvasId/sessionId`。脚本只读实际数据库，输出 `performance.json`，区分主模型、压缩等辅助响应、素材等待、渲染、文件可用和最后说明；并发区间取并集。视频传输的开始/结束沿用任务日志记录，旧记录和内联媒体无法细拆的阶段保持未知。费用只读已核账回执的 `actualCNY`，不采用 SDK 的默认零单价；它不替代账单核对。

---

## 1. 目录结构

- `sim-go.mjs`：内存版 Go 业务权威模拟器（`createSimGo`）。加载真实的 `operation-descriptors.fixture.json`，支持 `/api/ops`、`/api/ops/:id`、`/api/canvas`、`/api/canvas/operations`、`/api/assistant/runtime/turns/:id`、`/api/assistant/turns`、`/api/assistant/skills`、`/api/assistant/skills/active`、`/api/assistant/runtime/canvases/:id/skill-context` 与 `/api/generation-tasks`。
- `scenarios.mjs`（及 `scenarios/index.mjs`）：7 个固定评测场景定义、确定性检查项（`checks`）与本地 Fake OpenAI Chat Completions SSE 模型桩（`createFakeModelServer`）。
- `run-eval.mjs`：CLI 评测运行器、预算门禁与成本计量器（`createCostMeter`）、密钥脱敏器（`redactSecrets`）与 JSON/Markdown 报告生成器。
- `sim-go.test.mjs`：针对 `sim-go`、CAS 冲突、分镜行产出连线绑定、生成提议与撤销、预算熔断及脱敏的单测与端到端套件。

---

## 2. 快速运行

### 运行模拟器与评测核心单测
```bash
cd agent-host
bun test eval/sim-go.test.mjs
```

### 运行全量 7 场景确定性评测（默认 `--model fake`，零付费调用）
```bash
cd agent-host
bun eval/run-eval.mjs --model fake
```

### 指定单场景与自定义输出目录
```bash
cd agent-host
bun eval/run-eval.mjs --scenario S1,S2 --model fake --runs 1 --out /tmp/beeftv-eval-report
```

### 运行真实模型评测（需显式配置非零单价与预算上限）
```bash
cd agent-host
BEEFTV_AGENT_BASE_URL="https://your-provider.example.com/v1" \
BEEFTV_AGENT_API_KEY="sk-..." \
BEEFTV_AGENT_MODEL="your-model-id" \
BEEFTV_EVAL_PRICE_IN="2.0" \
BEEFTV_EVAL_PRICE_OUT="8.0" \
bun eval/run-eval.mjs --model real --scenario all --runs 3 --max-requests 25 --budget-cny 25 --out /tmp/beeftv-real-eval
```

---

## 3. CLI 参数与环境变量

### CLI 参数
| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--scenario <id\|all>` | `all` | 场景标识（支持 `S1`..`S7` 或 `shortdrama-2shot` 等名称，支持逗号分隔） |
| `--model <fake\|real>` | `fake` | `fake` 使用本地确定性 SSE 模型服务；`real` 连接真实模型并启用本地计量代理 |
| `--runs <N>` | `1` | 每个场景重复运行次数（`1..50`） |
| `--max-requests <N>` | `25` | 注入 `BEEFTV_AGENT_MAX_REQUESTS_PER_TURN` 的单轮最大模型请求上限 |
| `--budget-cny <number>` | `25` | 按返回的 usage 累计费用，达到阈值后停止后续请求并标记 `aborted_budget`；当前请求可能使费用超过阈值 |
| `--out <dir>` | 临时目录 | 输出 `report.json`、`report.md` 与 `ledger.jsonl` 的目录路径 |

### 环境变量（`--model real` 必填）
- `BEEFTV_EVAL_PRICE_IN`：输入价格（人民币元 / 百万 token，必须 `> 0`）
- `BEEFTV_EVAL_PRICE_OUT`：输出价格（人民币元 / 百万 token，必须 `> 0`）
- `BEEFTV_AGENT_BASE_URL`：模型服务 Base URL
- `BEEFTV_AGENT_API_KEY`：模型 API Key（写入报告与账本前自动脱敏为 `[REDACTED]`）
- `BEEFTV_AGENT_MODEL`：模型 ID
- `BEEFTV_AGENT_API`：协议类型（默认 `openai-completions`）

---

## 4. 固定评测场景一览（S1–S7）

| 编号 | 场景 ID | 核心验证目标 | 基线预期 |
| :--- | :--- | :--- | :--- |
| **S1** | `shortdrama-2shot` | 空画布创建 2 镜短剧开场：分镜脚本节点、2 行完整分镜、2 首帧图节点、2 视频节点、`image->video` 连线、零悬空媒体节点 | `PASS` |
| **S2** | `storyboard-8shot` | 写满 8 镜分镜表，只为前 2 镜创建首帧图节点并回填 `imageNodeId`，第 3–8 镜不越界建节点 | `PASS` |
| **S3** | `local-edit` | 预置 4 镜画布，只改第 3 镜描述与第 3 首帧图提示词，断言第 1/2/4 镜与其余节点、连线 100% 未动 | `PASS` |
| **S4** | `mid-turn-steer` | 首轮模型请求期间通过 `/steer` 注入改向（古风武侠 4 镜 -> 赛博朋克霓虹夜市 2 镜），同轮收敛完成 | `PASS` |
| **S5** | `post-generation-review` | 提交生成提议后模拟器交付带六指缺陷的图片，检验自动唤醒复查能力（标注 `wake-on-generation` 能力缺口） | `GAP (expected)` |
| **S6** | `skill-across-turns` | 仅首轮激活「短剧分镜到首帧」技能；后续自然补充和确认，检查每次请求仍带活动技能、首帧命名与画幅、有效 `imageNodeId` 回填和提议门禁；不触发压缩 | `PASS` |
| **S7** | `user-requested-generation-review` | 首轮提议经用户确认并交付后，用户主动发起第二轮复查，助手检查产物、在原节点修正提示词并重提；重提仍等待确认 | `PASS` |

---

## 5. 核心守护指标说明

1. **结构完整率 (`structuralCompletenessRate`)**：场景内通过的结构化断言数 / 总断言数。
2. **生成门禁合规 (`unconfirmedGenerationCount` / `duplicateNodeCount` / `duplicateProposalCount`)**：
   - 未经用户确认直接触发付费生成的任务数必须为 `0`。
   - 同一画布重复创建同名节点数、同一未失败节点重复提议次数。
3. **效率与成本 (`efficiency`)**：回合数、模型请求次数、读写操作数、输入/输出 Token、人民币花费与耗时。
4. **CAS 冲突恢复率 (`conflictRecoveryRate`)**：遭遇 `revision_conflict` 后通过重读最新画布恢复成功的比例。
5. **多轮技能保持率 (`skillRetentionRate`)**：在 S6 仅首轮选择技能的 4 轮对话后，活动技能请求上下文与产物约束的保持率；不是压缩后保持率。

---

## 6. 已知限制与扩展方式

- **费用阈值不是支付硬限额**：费用在请求返回 usage 后计算，未预留当前请求的最大成本。真实模型验收前仍需授权预算，并结合请求数量及模型输出上限控制支出，不能把 `--budget-cny` 当作绝不会超出的扣费上限。
- **S5 自动唤醒缺口 (`wake-on-generation`)**：模拟器完成任务后，只向 `/events` 投递完成通知并观察 1 秒，不主动调用 `/chat`。接受事件且没有自动复查时标记 `baseline_gap`，整体报告也显示 `baseline_gap`；事件投递失败则属于测试失败。观察窗口内通过只能证明测试注入的事件能触发宿主，生产任务完成事件的实际投递还需单独验收。
- **S7 是用户主动复查**：用户再发一条消息发起检查，与 S5 自动唤醒分别计分，不能用 S7 通过宣称自动续做已实现。图片和缺陷说明由模拟器提供；真实模型模式也使用模拟产物及缺陷说明，不是对真实图片视觉判断准确率的测量。
- **S6 不测试压缩**：场景已从 `skill-after-compaction` 更名为 `skill-across-turns`。真实调用 Durable 压缩、故意使用有损摘要并验证技能重新注入的测试在 `../durable-skills-cases.mjs`，由 `bun test durable-skills.test.mjs` 运行；这份评测报告不继承其结论。
- **新增场景**：在 `scenarios.mjs` 的 `SCENARIOS` 数组中追加包含 `id`、`code`、`setup`、`turns` 与 `evaluate` 的场景定义即可自动纳入 `--scenario all`。
