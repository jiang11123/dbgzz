# LibTV 导演台画布阶段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 BeefTV 导演节点的空态、封面、悬停打开、独立场景描述与关闭后封面更新，对齐已观察的 LibTV 画布流程，并逐步验证。

**Architecture:** 保留现有 `workflowKind: "shot"`、模板创建、`DirectorScene` 保存和显式 `applyDirectorOutput`。导演节点增加独立持久化封面字段，关闭工作台时在视口卸载前截图；场景保存确认后仅更新原节点封面，不走通用视频生成或额外输出节点路径。

**Tech Stack:** React/TypeScript、Bun test、Three.js 视口、现有 BeefTV 本地资源服务、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-29-libtv-director-canvas-stage-design.md`

## Global Constraints

- 本阶段不调用 Seedance、付费生成服务、LibTV 私有接口或新的远端 3D 生成接口。
- 保留五种模板入口、现有 3D/保存内核、旧项目读取和显式“应用到镜头”输出合同。
- 封面不是独立画布节点，不建立连线，不写入 `referenceAssetNodeIds`；项目元数据不存临时 blob URL 或机器绝对路径。
- `viewportRef.capture("beauty")` 必须发生在 3D 视口卸载前；保存失败的“仍然离开”不产生看似已保存的新封面。
- 用户已有未提交改动保持原样；只暂存并提交本阶段文件。

## Review Focus

- 旧项目只有 `directorPreviewNodeId`：仍能显示旧预览，且首次自动封面不破坏旧显式输出。
- 资源服务不可用、图片 URL 失效：保留旧封面或解释性空态，不出现永久黑块；测试在 Task 2/3。
- 关闭时切换项目、删除节点或连续关闭：过期截图不写回，也不创建重复资源；测试在 Task 3。
- 编辑场景描述时按 Enter、拖动或缩放：不触发 Seedance/通用生成，也不误拖画布；测试在 Task 1/4。
- 工作台保存失败且用户选择“仍然离开”：保持原封面，已存本地草稿仍可恢复；测试在 Task 3。

---

### Task 1: 节点结构与独立场景描述

**Files:**
- Modify: `web/src/components/canvas/director/canvas-director-node-panel.tsx`
- Modify: `web/src/pages/canvas/project.tsx`（导演面板 props 接线）
- Modify: `web/src/pages/canvas/use-canvas-director.ts`（新节点尺寸）
- Test: `web/test/director-canvas-node-panel.test.tsx`

**Interfaces:**
- `CanvasDirectorNodePanel` 新增 `onPromptChange: (value: string) => void`，只更新本节点 `metadata.composerContent`。
- 继续使用 `onOpen: () => void`；不向通用 `handleGenerateNode` 传导演输入。

- [ ] 写失败测试：外置标题只出现一次；空态/有封面都能点击或键盘打开；输入保存后重载回显；输入事件不触发节点拖拽或视频生成。
- [ ] 运行 `cd web && bun test test/director-canvas-node-panel.test.tsx`，确认测试因缺少交互而失败。
- [ ] 实现导演面板布局：标题交给既有 `NodeExternalHeader`，卡片内仅封面/空态/悬停打开；独立 textarea 置于卡片下方，调用 `onPromptChange`。调整新建节点尺寸以容纳卡片和输入区，但保持旧节点可缩放、可读。
- [ ] 运行同一测试及 `bun test test/director-template-mode-wiring.test.ts`，确认通过；仅提交本任务文件。

### Task 2: 持久化封面读取与失败状态

**Files:**
- Modify: `web/src/types/canvas.ts`（`directorCoverStorageKey?: string`、`directorCoverUrl?: string`、`directorCoverSceneUpdatedAt?: string`）
- Modify: `web/src/lib/canvas/director/director-preview.ts`
- Modify: `web/src/components/canvas/director/canvas-director-node-panel.tsx`
- Test: `web/test/director-node-preview.test.ts`
- Test: `web/test/director-canvas-node-panel.test.tsx`

**Interfaces:**
- `resolveDirectorPreviewSource` 优先接受已解析的 `coverUrl?: string`，然后按原有 `directorPreviewNodeId` / `shot.previewNodeId` 回落。
- `resolveImageUrl(storageKey, fallback, { cacheMiss: true })` 负责跨重载恢复资源地址；UI 只消费解析后的地址。

- [ ] 写失败测试：新封面优先；旧项目回落；空白/坏 URL 回到可操作空态；更换封面后可重试。
- [ ] 运行 `cd web && bun test test/director-node-preview.test.ts test/director-canvas-node-panel.test.tsx`，确认新断言失败。
- [ ] 加入封面元数据和异步资源解析；同一 URL 图片失败不无限重试，新 URL 能显示；不改旧显式输出路径。
- [ ] 运行上述测试与 `bun run typecheck`，确认通过；仅提交本任务文件。

### Task 3: 关闭工作台时安全采集并回写同节点

**Files:**
- Modify: `web/src/components/canvas/director/canvas-director-workbench.tsx`
- Modify: `web/src/pages/canvas/use-canvas-director.ts`
- Modify: `web/src/pages/canvas/project.tsx`
- Create: `web/src/lib/canvas/director/director-cover-write.ts`（幂等/过期判定）
- Test: `web/test/director-cover-write.test.ts`
- Test: `web/test/director-save-wiring.test.ts`

**Interfaces:**
- 工作台新增 `onCaptureCover: (input: { scene: DirectorScene; shotId: string; beauty: Blob }) => Promise<void>`；只在 `prepareClose()` 返回可正常关闭且视口仍有效时调用。
- `useCanvasDirector` 新增 `captureDirectorCover(input)`，经 `uploadImage(beauty)` 获取持久化资源，将 `directorCoverStorageKey`、`directorCoverSceneUpdatedAt` 写到同一源节点；`directorCoverUrl` 仅在地址可持久化时写入，资源服务回落至浏览器缓存时依靠 storage key 恢复，绝不落盘 object URL。
- `director-cover-write.ts` 导出 `shouldCommitDirectorCover(input: { projectId: string; currentProjectId: string | null; node: CanvasNodeData | undefined; scene: DirectorScene | undefined; shotId: string; expectedSceneUpdatedAt: string; requestId: string; latestRequestId: string }): boolean`。

- [ ] 写失败测试：保存成功后只更新源节点；无场景变化且封面有效时不再上传；项目切换/节点删除/场景变更/新请求覆盖旧请求时拒绝写回；保存失败与“仍然离开”都不更新封面。
- [ ] 运行 `cd web && bun test test/director-cover-write.test.ts test/director-save-wiring.test.ts`，确认新增断言失败。
- [ ] 在现有关闭状态机的成功路径、卸载前采集；复用 `uploadImage` 的本地持久资源；捕获/上传失败保留旧封面并提示，不能阻止已确认的场景保存。保留 `applyDirectorOutput` 的额外节点行为供显式操作使用。
- [ ] 运行上述测试、`bun run typecheck` 和相关 director 单测，确认通过；仅提交本任务文件。

### Task 4: 真实画布与视觉验收

**Files:**
- Modify: 前三任务中实际发现缺陷的文件及对应测试；不为截图修改无关模块。
- Test: `web/test/director-canvas-node-panel.test.tsx`、`web/test/director-cover-write.test.ts`

**Interfaces:**
- 使用现有 `web/.playwright/libtv-director/` 参考截图及 `/dev/director-repro`/真实画布；复用已登录的 LibTV 持久浏览器，不重复登录或操作参考项目数据。

- [ ] 运行 `cd web && bun test test/director-node-preview.test.ts test/director-canvas-node-panel.test.tsx test/director-cover-write.test.ts test/director-save-wiring.test.ts test/director-template-mode-wiring.test.ts && bun run typecheck`，记录通过/失败数量。
- [ ] 在 1440×900、相同缩放下截图空态、封面态、悬停态，对照参考；检查窄视口、75%/125% 缩放、节点锚点、键盘焦点。
- [ ] 在真实画布打开现有场景、编辑、关闭、刷新，确认封面持久、未多出节点/连线、无生成请求；主动验证失败/切换项目路径。
- [ ] 对发现的差异增补先失败后通过的测试并修复；复测截图及整套相关测试，记录仍未对齐的项目作为下一阶段输入；提交修复。
