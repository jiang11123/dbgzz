# 助手业务回合

状态：Grok 工作树 `codex/refactor-assistant-turns-20261002` 把 `app/assistant_turns.go` 的进程级互斥与 JSON 文件换成 SQLite 领域 `internal/assistantturns`。不实现 pi 会话、不存第二份对话稿。

## 边界

- pi 拥有模型会话、历史与上下文。
- Go 拥有业务回合：范围、确认、操作回执归属、按轮撤销。
- 领域可依赖 `canvas` / `model` / `repository` 或窄端口，禁止 import `internal/app`。
- 包名必须是 `internal/assistantturns`。`internal/assistant` 留给 runtime 的中立 provider 合同。

## 持久化

v10 `assistant-business-turns` 新增表 `assistant_turns`。身份是 `(turn_id)`。用户、画布、轮前 revision、状态、显式引用、关联素材/任务、撤销标记、变更摘要和轮前文档都在这一行里。

旧文件 `assistant-turns/<hexID>.json` 是只读迁移输入，按字节保留，生产路径从不写入或改写。访问某个 ID 且库中没有该行（含墓碑）时，才导入该文件；校验文件名与记录 ID、用户/画布身份。损坏或归属不一致会返回可观察错误，源文件保持不变。库中已有行之后，JSON 不再作为竞争事实。新回合只写入 SQLite。不会在无关读取上扫描整个目录。

同一 ID 的 Begin 先解析库中行再解析旧文件，然后才插入。用户、画布和显式范围相同则返回原 snapshot revision，不覆盖轮前文档。范围或身份不同则拒绝。损坏的旧文件会暴露错误并保持原样。创建新行时，画布快照与插入在同一事务里读取。

保留策略最多保留 64 份已结算且无回执引用的大快照；超出的只清空 `document`，留下身份墓碑（turn_id、用户、画布、状态、undone、revision_before），避免旧 JSON 被再次导入。进行中的 open 回合、仍被 `agent_op_records` 引用的回合不压缩。不删除身份行，也不删除回执。存储的范围或变更 JSON 损坏时失败关闭，不编造空范围，也不从损坏记录重建另一份撤销。

## 原子撤销

撤销把轮前文档作为**新 revision** 写回，并在同一事务里打上 undone。画布写入通过注入的事务绑定 `CanvasFactory.BoundTo(tx)`，避免再开根连接导致 SQLite 死锁。标记写入失败会回滚画布。

## Finalize 与写入竞态

`ScopeForHost` 只是宿主预检，不能单独关闭「结算 vs 操作提交」竞态。操作层必须在**写入 canvas 与 AgentOpRecord 的同一事务内**调用：

```go
func (s *assistantturns.Service) VerifyOpenTurnInTx(tx *gorm.DB, userID, turnID, canvasID string) error
```

app 别名：

```go
func (s *app.Service) VerifyOpenAssistantTurnInTx(tx *gorm.DB, userID, turnID, canvasID string) error
```

`turnID` 为空表示这次写入不属于助手回合，直接通过。非空时对回合行加写锁，拒绝已结算、已撤销、外用户或画布不匹配的回合。

本切片不改 `internal/agentops`。在 Lead/common-ops 把该调用接到操作事务之前，外部预检仍可能与 Finalize 交错。

## 验证

```sh
cd backend
go test ./internal/database ./internal/assistantturns -count=1
go test ./internal/app -count=1 -run 'AssistantTurn|UndoAssistant|Finalize'
```
