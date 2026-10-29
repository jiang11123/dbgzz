# 提交恢复评审复核

复核对象为生成提交重构的独立 Grok review 中第 1、3、7 项。只使用当前源码与可执行断言判断；其他评审项另行处理。本记录不代替完整 review、真实模型或安装包验收。

## 第 1 项：不确定提交丢失身份

评审引用的 `activeSubmission`、`clearSubmission`、`clearGenerationRuntime`、`BeefTV.canvasGeneration`、`buildSubmissionPlan`、`recoverSubmissionTask` 在当前 `web/src` 不存在；本实现不依赖所描述的 sessionStorage runtime。

实际代码为：

- `canvas-project-generation.ts:runCanvasGenerationTaskToConsumer` 在 POST 前保存 `taskClientOperationId` 与 `generationSubmissionState=submitting`；无法确认受理时改为 `unknown`。
- `use-canvas-generation.ts:recoverInterruptedGenerationTasks` 根据 `submitting|unknown` 恢复；不依赖 `node.status` 必须为某一种值。
- `use-canvas-generation-executor.ts` 先处理节点上尚未确认的操作，再进入新建生成流程；此路径只查原操作。

`customer-generation-scenario.browser.test.ts` 新增断连和 HTTP 503 两种情形。服务已受理 POST，随后的回执查询也返回 503。断言包括：原操作标识、unknown 状态和旧结果仍在；保存的节点含原标识；重复点击和刷新均只 GET，不增加 POST；查询恢复后原任务绑定到原目标，另一个节点不被改动，任务显示 running/loading。

结论：评审所描述的“清 runtime 后重新收费”路径不属于当前实现。节点可显示提交异常，同时继续保有不确定操作；不能把显示异常等同于原任务被丢弃。

## 第 3 项：跨项目操作号与回执目标

操作号在用户范围唯一是现有任务准入约定。同一用户在其他项目重复同一操作号不能代表两次独立生成。`FindOperation` 先按用户与操作号查询，再核对请求项目，不符返回 404；新增项目唯一索引会改变原约定，本轮未做此变更。

回执实际走 `presentTask -> taskPresenterAdapter.Task -> taskForOutput`，不是摘要列表。`publicTaskInputJSON` 明确保留 `mode` 和 `metadata`，过滤 `config` 与参考媒体传输内容。`generationTaskNodeId` 从 `clientContext.nodeId` 或 `inputJson.metadata.nodeId` 读取原目标；页面恢复还核对回执目标是否与节点一致。

新增真实 Go HTTP 用例 `TestTaskOperationReceiptKeepsOriginalTargetWithoutCredentials`：SQLite 中登记任务后调用真实 GET 路由，断言原 task/project/operationId、nodeId/sourceNodeId 保留，Key、私有 URL、config 与 referenceImages 不下发。该用例已通过 integration 当前 Go 源码执行，未 mock presenter 或 HTTP handler。

结论：评审关于“摘要过滤 metadata 导致写到当前选择”的前提不成立；没有据此改动唯一索引或新增重复快照。

## 第 7 项及准备提示

此前浏览器丢回执用例确实未单独覆盖“初次回执查询也不可用”；现增加上述两种错误与保存、刷新、重复点击、目标绑定的断言。fixture 的任务响应同步为真实公开投影形状，仅含 mode/metadata，不把完整带配置的输入交给恢复代码。

另新增准备提示用例：持住角色详情请求，先观察真实“正在准备参考素材…”提示；放行后等任务进入“供应商处理中”，断言准备提示消失。当前 executor 在重复确认之前已销毁准备提示，因此这项检查通过，无须新增生产修改。

上述 3 个浏览器专项和真实 Go HTTP 回执用例均通过。音视频 ensure 的取消、权限和未就绪状态由该领域的真实 Go 用例单独验证，本记录不把合成 HTTP 响应当作其证据。
