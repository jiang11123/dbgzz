# 画布可复用工作流

用户已明确要求先实现封装和复用框架，成功配方由用户随后手动调试。不将人物动作效果验证作为框架实现的前置条件。

## 产品闭环

框选节点 → 保存为工作流 → 确认槽位用途、固定素材、可替换输入及执行步骤 → 持久化到本机工作流库 → 添加到画布成为独立实例 → 在空白输入节点上传/拖入素材 → 在画布运行 → 后端推进依赖步骤 → 对应执行节点展示状态和持久结果。

## 画布使用交互重构

容器类型为 `CanvasNodeType.Workflow`（`reusable-workflow`），控制节点为 `CanvasNodeType.WorkflowControl`（`workflow-control`）。通用提示词面板采用明确生成类型白名单；工作流绑定节点不作为独立生成目标。容器与背板共用结构操作，不共用生成语义。进度区距容器顶部 80，左右各留 40，与容器同步拉伸；媒体槽位顶部从 320 开始，避免与进度区重叠。工作流标题移至容器外侧上方，复用媒体节点的实时逆缩放变量，保持屏幕字号稳定；不显示内部节点数量。进度状态与素材计数相邻，放大状态/步骤字号，运行操作右对齐，移除生成步骤/额度说明。

模板库仅选择、添加和管理模板，不承担表单式运行。每个实例包含一个分组、运行控制节点和按依赖分列的真实媒体/文本节点；输入节点带用途名称和加号，支持文件上传、从当前画布选取、直接拖入匹配类型素材、清空替换。拖入复制资源绑定，保留来源节点的位置。保存模板时允许编辑每个槽位的名称；旧模板按原名称、媒体类型和深度依赖生成可编辑的简短用途标签，不推断无法确认的模型参数。

媒体输入初始为空，固定内容保留；执行节点初始无上轮结果。实例用独立节点 ID 与 template node ID 映射，状态、输入及运行回执随画布持久化。运行前显式保存稳定提交标识；不确定提交使用同一标识确认，禁止更换素材。后端依然执行已有模板；前端轮询所有实例，不依赖当前选中的节点。产物通过现有资源和素材绑定后回填执行节点，预览复用作用域缓存与视频播放服务。

运行中禁止更换输入。已结束后可替换并开始新一轮，失败重试沿用原输入；改过输入则必须新运行。缺少/重复执行节点拒绝运行；恢复后台完成结果时，素材绑定失败会继续同步，不把空结果标记为已回填。

首版支持持久图片、视频、音频、文本；图片/视频/文本/音频生成任务和本地深度处理。生成配方来源于用户已手动运行的任务，服务器保存所需执行快照，API 不暴露密钥。对于无法还原的操作、循环、遗漏依赖、无法映射的可替换输入，拒绝保存并给出原因。布局、运行中状态、旧任务绑定不作为新运行状态继承。

## 合同

`WorkflowNode { id, title, mediaType: image|video|audio|text, role: input|constant|generation|depth, resourceId?, text?, sourceTaskId? }`。

`WorkflowDefinition { version: 1, nodes: WorkflowNode[], edges: {fromNodeId,toNodeId}[], outputNodeIds: string[] }`。模板响应 `{id,name,description,definition,createdAt,updatedAt}`。

运行请求 `{clientOperationId, inputs: Record<nodeId,{resourceId?:string,text?:string}>}`，所有收费执行通过受信任 UI 手动确认。运行响应 `{id,templateId,templateName,status,error?,steps:[{nodeId,title,status,taskId?,error?,resourceId?,text?}],outputs:[{nodeId,mediaType,resourceId?,text?}],createdAt,updatedAt}`。模板修改通过另存新模板；旧运行保持快照。

API：GET/POST `/canvas-workflows`；GET/DELETE `/canvas-workflows/:id`；GET/POST `/canvas-workflows/:id/runs`；GET `/canvas-workflow-runs/:id`；POST `/canvas-workflow-runs/:id/retry` 与 `/cancel`。JSON 遵循现有信封。

后端在保存时从归属当前用户的原任务还原标准生成输入，依据连线和原素材 resource ID 编译准确的 referenceImages/referenceVideos/referenceAudios 槽位映射；文本替换仅作用于明确匹配的原提示词片段。保存模板前验证映射，不能把新素材简单追加到旧请求。固定外部引用也必须保留和校验。

安装版实操发现成功任务会在交付完成后清理 canonical 请求。新增任务需要在清理前原子保存私有加密配方，隐藏于公开 Task JSON，并随任务删除。模板从该快照读取；已清理且没有快照的旧任务明确提示先手动重跑，不猜测原参数或素材槽位。首版保证安装后手动跑通再封装的路径。

## 执行和保护

使用现有任务 admission/worker 执行，无新的模型协议循环。运行与步骤持久化；稳定 clientOperationId 和 step operation ID 防止重复扣费。已经提交的任务查原回执；不确定提交不盲重试。失败仅重试失败步骤，成功输出保留。切换画布不影响执行；App 退出期间暂停调度，启动后重查任务并继续。取消阻止新步骤并保留已有结果，已开始任务按原任务机制处理。

模板固定资源和运行结果加入删除引用检查。工作流定义及任务快照不能在 API/日志暴露密钥。资源、任务、模板和运行都校验 scope。首版库级缓存/市场/分享/循环/任意脚本不在范围内。

失败重试沿用原运行输入；输入变更后启动新运行。运行历史继续保留在后端，画布显示该实例最近一次运行。未接纳任务重试可读取更新的渠道凭据，已接纳/未知回执保留原恢复身份。

## 当前工作区约束

沿用当前 main checkout；存在其他任务未提交修改，保留。只做必要的集成修改；用户本机验收前不提交、建分支或推 PR。使用官方脚本更新 `/Applications/BeefTV.app` 并在该路径验收，不建立额外运行环境。
