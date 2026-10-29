# Agent 媒体草稿参数配置验收

新增 `canvas.node.configure`，让 Agent 设置已有图片、视频、音频节点下一次生成使用的参数。该操作不创建生成任务，不调用付费模型。

## 参数合同

请求包含 `canvasId`, `nodeId`, `kind`, `expectedRevision`, `patch`。目标必须是当前用户画布内、类型一致的媒体节点。

| 类型 | 允许参数 |
| --- | --- |
| image | model, size, quality, count, transparentBackground |
| video | model, size, seconds, vquality, generateAudio, watermark |
| audio | model, audioVoice, audioFormat, audioSpeed, audioPitch, audioVolume, audioInstructions |

参数保持现有界面的 metadata 表示：count 是整数，其他参数是字符串，包括布尔字符串。数量 1–8，时长 >0 且 ≤600 秒，语速 0.25–4，音高 -12–12，音量 0–1；数值拒绝 NaN/Infinity，其他文本有长度限制。设置 model 时通过实际模型目录校验可用性和媒体类型，并存储 canonical model key。生成提交仍按当时模型能力和渠道规则复核，这里的草稿参数范围不承诺任意模型都支持所有值。

不允许写 taskId、status、结果、任意 metadata 或已提交提示词；现有 `canvas.node.update` 桥仍保持其原有有限参数。操作复用 `UpdateUserCanvasNodeFields` 和现有 Descriptor 字段应用；公共能力版本为 `canvas-capabilities/v5`，三个媒体 Descriptor 版本为 3。

## 验证证据

- 单元验证三类参数写入、模型 canonical key、既有 prompt/composerContent/task/status/custom 保留；错误类型、未知字段、异常值、不可用模型和节点类型不一致均无写入。
- 真实 SQLite + Go HTTP operation handler：重复相同 operation ID 只写一次；不同 operation ID 使用旧版本得到 409；访问非当前画布得到 403；完成业务回合后真正 Undo 恢复原节点。
- `go test -p 1 ./internal/operations ./internal/assistantturns ./internal/agentops ./internal/canvas -timeout 180s` 全通过（35.042s / 2.814s / 28.990s / 3.839s）。
- 真实幂等验证完成后，Durable 的明确可重放白名单增加 `canvas.node.configure`。未来新增写操作继续默认不可安全重放，不能由模型标记为安全。

验收范围是本地代码和真实业务存储路径，未执行付费生成、部署或 GUI 用户体验验收。
