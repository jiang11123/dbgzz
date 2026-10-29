# 画布页面组合重构

本切片只拆 `InfiniteCanvasPage` 的页面私有职责。不是整仓 full-refactor 验收。基线 `15266ba`（v1.6.21 正式修复 + Agent 候选）。官方 pi SDK 仍在服务端；前端是 React。

## 责任边界

| 所有者 | 文件 | 职责 |
| --- | --- | --- |
| 页面 | `web/src/pages/canvas/project.tsx` | 组合与渲染入口、节点点击按类型路由、`retryCanvasNode` 装配、文件夹插入与预览、Ark 上传确认、Lighting `AppModal`、世界层/浮层 props、键盘与选择控制器的接线 |
| 提案执行 | `use-canvas-assistant-proposal.ts` + `canvas-assistant-proposal-source.ts` | 人工确认后执行提案；冻结快照；确认时捕获本次 `generate`；画布/账号变化则拒绝，不自动生成 |
| 生成编排 | `use-canvas-generation-orchestration.ts` + `canvas-generation-orchestration.ts` | 生成查询/执行/批次/分镜/重试/历史插入/从文本建图；历史插入在提交前 rebase，持久化走原画布 |
| 资源转入 | `use-canvas-resource-handoff.ts` + `canvas-resource-handoff-plan.ts` + `canvas-resource-handoff-commit.ts` | 关联项目查询、角色刷新、项目画风节点、文件夹样式同步、handoff 提交、资源重载、归档；提交走 `persistCanvasDocument` |
| 弹窗状态 | `use-canvas-project-dialogs.ts` | 编辑类弹窗开关；删除清理不含 `timelineNodeId`；清空画布不重置角色/导演/分镜/版本/时间线/超分 |
| 弹窗宿主 | `canvas-project-editor-dialogs.tsx` | 按分组 props 挂载搜索/历史/导入/画风/导演模板/信息/字幕/抽帧/时间线/角色/文本/绘图/审美/全景/分镜/导演台/版本对比/素材选择；不持有业务状态 |
| 视口安全区 | `canvas-viewport-safe-area.ts` + `use-canvas-connected-node-visibility.ts` | 新连接节点只平移视口，不改节点世界坐标 |
| 指针铬 | `canvas-pointer-chrome.ts` + `use-canvas-pointer-chrome.ts` | 框选/拖拽结束/取消选中；节点工具条悬停显隐。不包裹已有 `useCanvasKeyboard` / `useCanvasSelectionController` |
| 节点内容 | `use-canvas-node-content.ts` | 内容更新绕过 stamp、媒体 120ms 合成节流 |
| mention 规范化 | `use-canvas-mention-normalize.ts` | 与 render model 并列，按 mention 映射改写已保存的 `@[node:]` |
| 剪贴板 | `canvas-project-clipboard.ts` | 系统剪贴板写 PNG |
| 归属纪元 | `canvas-owner-epoch.ts` | 画布 id + 用户 scope；异步提交前读取当前同画布状态 |

分组 props 是显式类型，不是巨型 untyped context，也不是把整页改名为 hook。

## 调用顺序

页面内 hook 顺序（必须稳定）：

```text
lifecycle
  -> versions / assistant（只读边界，本切片不改）
  -> viewport
  -> connected-node visibility
  -> generation orchestration（含 executor / batches / storyboard / retry / history）
  -> assistant proposal（确认时捕获 handleGenerateNode，不再用 live ref 授权）
  -> upload
  -> resource handoff（需要 handleProjectAssetsInsert）
  -> timeline insert（需要 refetchLinkedProject）
  -> media tools（需要 startGenerationRequest / bindGenerationTask / setRunningNodeId）
  -> node ops
  -> pointer selection chrome
  -> selection
  -> node toolbar hover
  -> node editor
  -> render model
  -> mention normalize
  -> node content
```

循环切断：

- `retryCanvasNode` 留在页面：需要 media tools 的 `retryDepthCaptureNode`，以及编排层的 `handleRetryNode` / `retryImageBatchChildren` / `generateScriptRows`。
- `handleSelectedNodeClick` 留在页面：按节点类型路由弹窗/面板，属于组合而不是指针铬。
- 提案 hook 放在生成编排之后、上传之前：确认瞬间捕获本次 executor；prepare 之后若画布/账号已变则拒绝生成。

## 项目 ID

| 用途 | 值 |
| --- | --- |
| 生成任务查询 / live 绑定 | `linkedProjectId` = `shortDramaEnabled ? currentProject?.projectId \|\| "" : ""`，传入 `useCanvasGeneration({ domainProjectId: linkedProjectId })` |
| 执行器 / 重试 / 历史插入素材归属 | `domainProjectId: currentProject?.projectId` |

handoff 查询参数是 `asset`（单数，可重复），不是 `assets`。

## 异步归属

- 历史插入：apply/ensure 只处理新节点；提交前 `rebaseInsertedCanvasNode` 接到当前同画布节点上；`persistCanvasDocument(owner.canvasId)`；画布已切换则仍持久化原画布，不 `setNodes`、不关新画布的历史弹窗。
- 归档 / 资源重载：IO 之后用画布+用户纪元决定是否写页面状态。复制节点可以有相同 id，只比对节点 id 不够。
- 素材转入：成功路径必须 `await persistCanvasDocument`（SQLite/后端已有实现）。并发草稿通过 rebase 保留。持久化失败则复位 attempt、不消费 URL，以便重试。不要做第二套操作日志。
- 提案：确认时捕获 executor；prepare 期间切画布/账号则提示「画布或账号已切换，未提交生成。请重新确认提案。」，不把这句话映射成通用核对失败。快照仍是人工确认时的不可变副本。

## 只读边界（本切片不改）

- `use-canvas-assistant.ts`、`canvas-assistant-sidebar` / turn / composer、`services/api/agent-assistant.ts`
- `web/src/lib/timeline`、canvas-video-merge、export-integrity、zip helpers
- stores、services、APIs、backend、generation executor 内部、timeline 渲染、lockfile
- `persistCanvasDocument` / `lib/canvas/canvas-asset-handoff.ts` 只调用，不改实现
- 任务投递 worker（后续替换素材落地/挂接归属）

## 页面仍持有的职责

这些留在页面，因为是组合入口或仍会形成环：

- 生命周期、版本、助手接线（助手实现只读）
- 视口控制器接线、世界层 props、空状态与顶栏
- `handleSelectedNodeClick` 按类型路由
- `handleProjectFolderInsert`、`linkedFolderPreviewNodesById`
- Ark 私有素材上传确认
- 角度 / 灯光 / 情绪 / 提示词 / 选择工具条等画布浮层；灯光仍用页面上的 `AppModal`
- `dialogNodeId`（提示词面板，不是编辑弹窗簇）
- `retryCanvasNode` 装配（跨 media tools 与 generation orchestration）
- `useCanvasKeyboard` / `useCanvasSelectionController` 的页面接线（共享 hook 未改）
- 复制媒体节点（`VIDEO_NODE_MAX_SIZE` 720 在 `canvas-node-size.ts`，复制隔离在 `isolateCopiedNodeMetadata`）
- 时间线状态仍由页面经 `updateProject({ timeline })` 写入，本切片不改时间线模型

## 行为锁

- Agent 提案必须显式人工确认；快照不可变；不自动生成。`generateImageFromTextNode` 只建连接后的图片节点，不提交任务。
- 批次重试：先 `setNodes` 标记，等全部 child retry，再 reconcile 一次 root。
- 历史插入：`persist` 完成后且仍是同一画布/用户才关弹窗；重叠插入由 `createInsertingHistoryGate` 挡住。
- 删除节点不关时间线弹窗；清空画布不重置角色参考 / 导演台 / 分镜编辑器 / 版本对比 / 时间线 / 超分。
- 修订冲突 UX 仍走顶栏 `CanvasSyncStatus`，助手侧栏不重复。

## 剩余缺口

- `retryCanvasNode` 跨 media tools 与 generation orchestration，下一切片若要下沉需要先把 depth retry 从 media tools 拆出。
- `handleSelectedNodeClick`、文件夹插入、Ark 确认、Lighting `AppModal`、世界层 props 仍是页面组合。
- `applyGenerationTaskResult` 内部在 reload 成功路径里仍可能在 await 之后 `setNodes`；本切片只在调用前做画布/用户纪元守卫。
- 生成投递 worker 之后才会接手素材落地/挂接归属；不要在页面再做一套 backend apply。
- `CanvasProjectEditorDialogs` 是宿主而不是控制器；状态仍在 `useCanvasProjectDialogs` + 页面。

## 验证

`cd web && bun install --frozen-lockfile && bun run typecheck`，再跑本切片相关 `bun test`。不跑 GUI / 全量 build / 付费上游 / 真实 DB。
