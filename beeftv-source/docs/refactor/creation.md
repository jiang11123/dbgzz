# 创作执行领域

状态：结构化 CreationRun 执行算法已迁入 `internal/creation`。pi 会话、AssistantTurn、`/create` 对话存储仍由其他切片拥有。本文记录当前真实依赖，不是完整重构完成证明。

## 边界

- 新包：`backend/internal/creation`
- 拥有：创作租约/代次/动作状态机、方案快照与 hash 校验、quote/confirm/submit 幂等、画布 mutation-diff 与受控写入事务
- 不拥有：pi Session、SQLite 业务轮次、`/create` 对话 CAS、任务准入/生命周期、画布规范事务协议、handler 路由
- 现行 UI `ApprovedToolExecution` 与分镜路径继续走本领域；它们不是已退场的旧 Agent
- 本包不得 import `internal/app`

## 实际依赖图

```
HTTP handler
  └─ app.Service 兼容方法（JSON 载荷暂留）
        └─ app.creationDomain() → internal/creation.Service

internal/creation.Service
  ├─ repository.Repository（CreationRun 行锁事务、submission、canvas、config signature）
  ├─ canvas.SaveDocumentWithHistory / ValidateSyncedPayload / capability.BuiltinRegistry
  ├─ modelcatalog.DecodeModelCapabilityConfig（文本参考图容量）
  ├─ assets.DocumentReferences（结果回写素材归属）
  └─ typed ports（app 适配，无 Service 回调方法袋）
        ├─ Tasks.Prepare  CreateLocalTask(task.CreateRequest{PrepareOnly:true})
        ├─ Tasks.Admit    同一 MutateCreationRun 事务内的本地 SQLite 插入
        ├─ Secrets.Protect
        ├─ Quota.ValidateRun / ValidateCanvas
        ├─ Media.ValidateDocument(tx repo)
        └─ TaskKinds.UsesWorkflow / UsesTextReplay
```

禁止方向：`internal/creation` 不得 import `internal/app`。

## 领域已拥有的行为

- 按 `clientKey` 幂等创建 CreationRun，内容 hash 冲突拒绝
- claim / heartbeat / release：45 秒租约，epoch CAS。活跃租约上其他 owner 不能接管；同一 owner 可续约（升 epoch 并延长 TTL）；过期或释放后才能被其他 owner 接管。JSON `owner` 是租约身份，不是调用方角色
- save：revision CAS；`state.approved` 不能当作方案确认
- proposal-approve / invalidate：方案 hash、操作白名单、画布基线快照；同版本同 hash 重放不升 revision
- HTTP 写路径：外层启动令牌仍覆盖 `/creation-runs`（Agent 凭据只豁免 `/api/ops`）。handler 再拒绝 `X-Beeftv-Client`，并在组合根提供 DesktopTrust 时要求桌面 UI 引导密钥
- Prepare（quote）：创作任务约束、受管模型、协议占位校验；不落生成任务
- Approve：确认前再次核对执行配置指纹；lease + 方案 hash 保护
- Execute：同一 submission 回放同一 task。Protect 后序列化失败或 Admit 返回空任务时失败关闭，事务回滚，不留 task 行。未知上游回执属于任务提交账本，创作层不再复制一份
- 画布创建稳定幂等；提交按 snapshot hash 与批准 diff 校验；媒体校验在 MutateCreationRun 事务仓储上执行（含 asset identity）；手工后续编辑不被批准补丁覆盖
- 结果回写只允许绑定到本 run 已成功任务的真实资源

## 任务准备缝

`creation_domain.go` Prepare 已改为直接构造 `task.CreateRequest{PrepareOnly: true}` 并调用 `CreateLocalTask`。本树的 `CreateLocalTask` 仍把 `PrepareOnly` / `AdmissionID` 映射到现存 `creationPrepare` / `admission` 兼容字段，因为 `task_creation.go` 不在本切片写入范围。Lead 删除这些字段后只改 bridge。

## 仍留在 app 的残余

| 残余 | 位置 | 原因 |
| --- | --- | --- |
| `CreationRequest` + `CreateTaskRequest` | `app/creation.go` | handler JSON 仍绑定 app 类型 |
| `creationTaskPreparation` | `app/creation.go` + `service.go` | 现有 CreateTask 私有 quote 标记；`service.go` 不在本切片写入范围 |
| Tasks/Secrets/Quota/Media/Kinds 适配 | `app/creation_domain.go` | 跨域组合：目录选型、密钥、配额、画布媒体、工作流识别 |
| `resolveAgentResourcePlaceholders` 包装 | `app/creation_agent_references.go` | `provider.go` 出站水合仍调用 app 函数 |
| `taskForOutput` | Execute 返回路径 | 任务读模型投影仍在 app |

## 未改

- schema / 数据历史
- bootstrap / runtime / local_kernel / `app/service.go` / `task_creation.go`
- handler 只窄改 `creation.go`：绑定已有 DesktopTrust / 拒绝 Agent 客户端头
- canvas service 与 operations 公共协议（只调用既有 `SaveDocumentWithHistory`）
- 前端、`ApprovedToolExecution`、分镜 UI

## 验证

领域与 app 创作测试使用临时 SQLite，不打真实上游。Execute 失败关闭与租约互斥用真实事务证明。完整重构未完成。
