# 外部 Agent 与豆包账号节点

通过 BeefTV MCP 连接的外部 Agent（Codex、Claude Code、Cursor 等，需选择「读写」模式）可以**创建和配置**画布里的「豆包账号」节点，但**不能触发生成**。生成始终由界面里的节点发起，和付费生成「只提议、由界面确认」的约定一致。

## 能做什么

- `canvas.nodes.create`：创建 `type: "doubao-account"` 的节点，`prompt` 作为节点提示词。新节点默认是对话模式、未选账号。
- `canvas.node.update`：修改节点设置。`patch` 支持：

  | 字段 | 类型 | 说明 |
  | --- | --- | --- |
  | `title` | 字符串 | 节点名称 |
  | `prompt` | 字符串 | 发给豆包的内容 |
  | `mode` | `chat` / `image` / `video` | 任务类型，其他值会被拒绝 |
  | `accountId` | 整数 | 豆包账号编号；不存在的账号会在界面运行时提示 |
  | `ratio` | 字符串 | 画幅比例，如 `16:9` |
  | `duration` | 数字 | 视频时长（秒） |
  | `videoModel` | 字符串 | 视频模型，如 `Seedance 2.0 Mini` |

- `canvas.edge.create`：文本节点、图片节点可连到豆包节点作为输入；豆包节点的文本结果可连到下游节点。视频节点不能作为豆包节点的输入。
- `canvas.get`：读取节点的 `doubaoAccountNode` 状态，包括 `status`、`resultText`、`progress`、`latestReply` 等运行结果。

## 不能做什么

- **不能触发运行**：需要在画布里点节点上的「发送 / 生成图片 / 生成视频」。
- **不能写运行状态**：`status`、`resultText`、`resultPreviewUrl`、`videoTaskId`、`latestReply`、`progress`、`error` 都由界面维护，写入会被拒绝，避免 Agent 伪造结果。
- 写操作每次都要带 `operationId`（幂等键），并提供 `expectedRevision`。

## 典型流程

1. Agent 用 `canvas.nodes.create` 建节点，再用 `canvas.node.update` 设置 `mode`、`accountId`、`ratio`、`duration`、`prompt`。
2. 你在画布里检查设置，点击生成。
3. Agent 用 `canvas.get` 轮询节点状态，生成完成后读取结果。

## 注意

- 豆包经常先回复「请确认参数」，此时节点状态是 `running`，需要在节点里回复确认。
- 这是网页自动化，消耗的是你豆包账号的额度；不要让 Agent 高频批量操作，避免触发豆包的风控或验证码。
- 外部 Agent 默认应使用**只读**模式；确认需要写入再改为读写。
