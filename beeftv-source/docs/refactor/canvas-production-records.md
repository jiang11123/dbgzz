# 普通画布接入制作记录

普通画布可以显式把已经完成的生成产物登记到现有项目、章节、镜头和制作阶段。登记复用 `CanvasUnitLink`、`WorkflowInstance`、`WorkflowStepTask`、`ProductionTaskLink`、`AssetRepresentation`、`ShotArtifact`，没有新增制作状态机或数据表。

## 入口与契约

`GET /api/projects/:projectId/canvases/:canvasId/production-context?unitId=...&shotId=...&stepKey=video`

读取候选关联，返回 `data.context`。包含项目、画布、章节、镜头、当前 `shotRevisionId`、阶段、产物类型、`linked`、`workflowAvailable`、`workflowStepId`。GET 不写画布归属，不创建工作流。不存在章节工作流时 `workflowAvailable=false`，`workflowStepId` 为空。

`POST /api/projects/:projectId/canvases/:canvasId/production-context`

```json
{
  "unitId": "chapter-id",
  "shotId": "shot-id",
  "shotRevisionId": "revision-returned-by-GET",
  "stepKey": "video",
  "taskId": "existing-task-id",
  "resourceId": "existing-resource-id"
}
```

`stepKey` 为 `storyboard`、`previz`、`video`、`delivery`。前两项接收图片，后两项接收视频。`resourceId` 在单产物任务中可以省略；多产物任务必须传入原任务结果中的一个资源 ID。响应为 `data.{context,step,taskId,resourceId}`。

客户端先读取候选关联，再把看到的镜头版本提交。登记不会自动确认阶段完成；阶段完成继续经过既有工作流的内容门禁。

## 写入与恢复

写入前核对用户拥有项目、画布、镜头、任务和素材。画布已归属其他项目时拒绝隐式移动。任务必须属于当前画布、已经成功，所选素材必须属于任务的规范化输出且在本地 `ready`。仍在生成、下载或恢复中的结果不能登记为完成。

关联画布、补建缺少的章节工作流、登记项目素材、工作流任务和镜头产物位于同一个数据库事务。中途失败回滚全部关联，原任务和原素材不变。相同任务、镜头和产物重试复用既有记录；不允许重试时换成同一批次的另一份产物。已经登记到其他镜头或阶段的任务返回冲突。

这条路径只处理既有产物，不调用生成、付费、任务重试或媒体下载端口。原结果恢复和画布绑定仍走已有任务/资源路径，沿用 `taskId`、`resourceId` 和绑定 effect key；登记不会重新生成。相同绑定再次执行不会重复修改画布。

## 内容修改与确认失效

章节正文、镜头版本或引用素材变更，继续调用现有 `invalidateUnitWorkflowTx`。本次补齐项目汇总工作流也一起失效：变更起点重开，后续阶段退回待处理、清除完成时间并提高版本。其他章节自己的工作流保持原状态。

例如镜头 A 改为 B，原镜头产物保留但标为 `stale` 且取消选中；章节和项目汇总的分镜阶段重开，预演、视频、交付需重新确认。旧请求的 `shotRevisionId` 返回 `production_revision_conflict`。即使改成当前版本重新提交，旧版本已经登记的同一任务也返回 `production_output_revision_mismatch`，不会将旧记录冒充为新版本审核结果。

## 前端复用

`web/src/services/api/projects.ts` 提供 `getCanvasProductionContext`、`registerCanvasProductionTask`。项目、章节、镜头选择复用 `listProjects`、`listProjectUnits`、`getProjectUnitWorkspace`。普通画布节点菜单使用 `node.metadata.taskId` 获取已有任务，批量产物需要同时传节点对应的 `resourceId`。

## 验证

- 普通画布读取不产生关联；首次登记创建关联和缺失工作流，重复登记只有一套记录。
- 真实画布绑定重复执行不增加画布修订；任务、素材数量和上游任务 ID 保持不变。
- 镜头 A→B 后项目汇总与当前章节确认失效、其他章节不变、旧产物保留为 stale。
- 待恢复资源、跨用户、旧版本请求、多产物未选定/试图换产物均拒绝。
- 注入镜头产物写入失败，关联和素材记录全部回滚。
- 真实 HTTP 入口验证读取、严格解码、幂等登记、版本冲突。

测试位于 `backend/internal/project/canvas_production_test.go` 和 `backend/internal/handler/canvas_production_test.go`。未调用付费模型或生产服务。
