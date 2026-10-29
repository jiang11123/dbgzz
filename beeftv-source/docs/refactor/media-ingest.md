# 生成结果第一段入库

状态：`persistGeneratedMediaResultMode` 的实际入库与 ResultJSON 改写已迁入 `internal/taskdelivery.Ingestor`。本文记录当前真实边界，不是完整重构完成证明。

## 边界

- 新实现：`backend/internal/taskdelivery/ingest.go`
- 拥有：生成结果里 image/video/audio 的 dataURL/字节第一段入库、ResultJSON 改写为本地 resource URL、严格路径与旧迁移 skip 语义、同身份恢复
- 不拥有：任务终态提交、画布/消息绑定、付费上游重试、远程 URL 下载、素材库第二段 materialize
- `app` 的 `persistGeneratedMediaResult` / `persistLegacyGeneratedMediaResult` 只做窄适配
- 本包不得 import `internal/app`

## 两段互补

```
executeClaimed / QueryFailedVideoTask
  └─ persistGeneratedMediaResult          第一段：dataURL → 本地 Resource，改写 ResultJSON
        └─ taskdelivery.Ingestor
              └─ asset.StoreGenerated 或 RecoverOwned
  └─ saveTaskCompletion / RegisterTaskOutput
  └─ taskdelivery.Deliverer               第二段：已成功任务的 Result → Asset/Version/Representation
```

第一段发生在任务耐久完成之前。失败不得把任务写成 succeeded/bound，也不得发起上游 POST。第二段只处理已经 succeeded 且 ResultJSON 已有 resourceId 或可持久化远程 URL 的产物。两段不会为同一产物写两行生成资源。

## 身份与额度

- Worker 和人工视频回查通过 `persistTaskGeneratedMediaResult` 传入稳定任务身份；`taskId:inline` 加转义 JSON 路径走 `RecoverOwned`，重启与同身份重放复用 READY 行。JSON 键内的斜线和空白不会与其他字段碰撞。
- 没有任务身份的独立调用仍走 `StoreGenerated`；旧迁移不伪造任务身份。
- 现行严格路径执行 GeneratedFileMB 与账号存储额度；旧迁移 `SkipInvalidDataURL + EnforceQuota=false` 跳过坏 dataURL 且不预留生成额度。
- 上传见证 READY/FAILED 结算仍由 asset 域拥有（基线已含 `359e835` / `d480a1e`），入库只调用 Store / StoreGenerated / RecoverOwned。

## 仍留在 app 的残余

| 残余 | 位置 | 原因 |
| --- | --- | --- |
| `persistGeneratedMediaResult` | `app/generated_media_ingest.go` | `task_worker` / 人工视频恢复仍调用现有方法名 |
| `decodeDataURL` | 同上 | 第二段 `PersistRemoteArtifact` 仍解码 data URL |

## 未改

- `provider.go`
- Seedance 视频回查、完成排序、绑定投影
- schema / 插件包 / 真实上游

## 验证

领域与 app 专项使用临时 SQLite 与文件目录、确定字节。覆盖嵌套 image/video/audio、坏 dataURL、旧迁移 skip、额度拒绝、同身份重启、已有资源复用、入库失败不完成/不绑定/不 POST。完整重构未完成。
