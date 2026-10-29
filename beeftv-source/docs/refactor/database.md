# 本地数据库迁移切片

状态：Grok 工作树 `codex/refactor-db-20261002` 已实现统一迁移合同；未改 model/app，未触达真实数据库。

## 合同

- 迁移身份是 `local_schema_migrations` 中的 `(version, name, applied_at)`，只追加、不改写。
- 新库使用正式身份：v3 为 `task-failure-diagnostics`，并保留 Agent 的 v8 `reconcile-product-agent-schema` 与 v9 `repair-product-agent-contracts`。
- 已被占用的版本号不再执行，即使历史名称不同。预览 v3 `agent-operation-records` / `image-submission-recovery` 保持原行，缺失结构由 v8/v9 补齐。
- Ready 由结构校验证明，不由版本号单独证明。同为 v9 但缺表、列、主键或唯一索引时拒绝；高于当前程序的版本拒绝任何 DDL。
- v3 至 v9 只做可加变更：`ALTER TABLE ... ADD COLUMN`、`CREATE TABLE`、`CREATE INDEX`。已有表不重建。缺主键拒绝自动修复。错误唯一索引只在 v9 显式修复，失败则保留全部行并回滚。

## 已覆盖的历史布局

夹具用历史 DDL 建表，再追加未知列，不再从当前 `LocalModels()` 删列。

| 布局 | ledger | 保留内容 |
| --- | --- | --- |
| 正式 v2 | v1–v2 | 任务正文、未知列、资源 |
| 正式 v3 | v3=`task-failure-diagnostics` | 诊断列可为空；身份不改写 |
| 预览 v3 | v3=`agent-operation-records` 或 `image-submission-recovery` | 原名称、Agent 回执或恢复行、未知列 |
| 预览 v6 | v3–v6 Agent 名称 | `turn_id`、客户端操作身份、未知回执列 |
| 预览 v8/v9 | 已标 v8/v9 | 缺列时由 v9 修复；完整 v9 不再迁移 |

中断与重试：单步事务，失败不前进版本；进程在未提交事务中被杀死后可重试。未来版本比较 `sqlite_master`，结构不变。

破坏性 v2 仍在删除托管表前用 `VACUUM INTO` 备份；Windows 验收关闭临时连接后再清理。

## 给 Lead 的跨切片说明

- 本切片未改 `model` / `app`。v4/v5 不再对整张 `tasks` 做 GORM `AutoMigrate`。正式 v3 之后若再给 Task 加列，需要在 `backend/internal/database` 增加新的可加迁移，不能指望 AutoMigrate 顺手补列。
- 公开文档 `docs/content/docs/backend/backend-database.mdx` 仍写夹具“由当前模型删减”。本工作树不能改共享文档，需要 Lead 改成“按历史 DDL 建表并保留未知列”。
- `RequireLocalSchema` 校验统一合同列、恢复表、Agent 表、主键和幂等索引。正式旧库上其余 Task 列仍来自当时 v1 AutoMigrate；无版本的旧文件若直接走 v1，GORM 仍可能因改列而重建表。

## 验证

```sh
cd backend
go test ./internal/database -count=1
```

未打开正式应用，未读取真实工作区，未做付费调用。
