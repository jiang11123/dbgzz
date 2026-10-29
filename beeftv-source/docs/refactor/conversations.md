# 创作对话提交事实

状态：本切片把 `/create` 页的 `creation-conversations-v1` 从 IndexedDB 数组改成 SQLite 对话聚合。不改 `internal/app/creation.go`（CreationRun），也不改 pi AssistantTurn / 会话稿。

## 边界

- 领域：`backend/internal/conversation`。规则在领域内，handler 只做身份、协议和错误投影。
- 组合：`RegisterCreationConversationRoutes(api, svc, dependencies.Conversations)`。对话服务由组合根注入 `RuntimeDependencies.Conversations`；handler 不从 `svc.Database()` 构造。未注入时接口关闭。Lead 在 `backend/internal/bootstrap/runtime.go` 的 `RuntimeDependencies{...}` 增加一行：`Conversations: conversation.New(conversation.NewStore(repository.New(db))),`
- 前端：`web/src/services/creation-conversation-store.ts` 以后端为提交事实；IndexedDB 只作导入源和未确认草稿。

## 给后续任务绑定的接缝

`Service.AttachMessageResult` 只改已有消息的结果字段（`resultUrls`、`generationEffectKeys`、可选 `status`），不改提示词、标题或其他消息。

调用方必须：

1. 用 `WithTx` 或 `WithRepository(repo.WithTx(tx))` 进入**同一事务**。
2. 自行校验任务结果的准确归属（本方法只确认消息 `taskIds` 含该 `taskId`、对话未删除、身份匹配）。
3. 使用稳定的每任务/输出 `effectKey`（可复用文档里已有的 `generationEffectKeys`）做幂等。

本切片不实现任务绑定、materializer 或画布同步。
