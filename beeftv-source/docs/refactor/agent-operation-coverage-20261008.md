# 无限画布助手业务操作清单（OP02）

日期：2026-10-08。以当前 `internal/operations/ops.go` 注册与 `internal/agentops/scope.go` 白名单为准。HTTP 服务存在某项能力不等于内置助手能调用。此清单记录接入点，不扩大任务权限；并行新增能力应更新本表。

## 已开放的真实业务路径

| 用户想完成的事 | 助手操作 | 验证与限制 |
| --- | --- | --- |
| 理解当前画布和引用的素材 | canvas.get、asset.get | 当前画布模式仅读取当前画布、明确引用及当前项目授权的内容；只读与完全访问可读取本用户工作区 |
| 看参考图片、视频，听声音 | media.overview、media.inspect | 有归属的资源，先获取版本，再按该版本读指定片段；真实图像/MP4/WAV，并非只给路径 |
| 检查黑屏、静音、音量 | media.check | FFmpeg 客观检测；默认整段、长度受限，不能替代内容审片 |
| 在当前项目查素材/画布 | project.media.search、project.canvas.search | 从当前ownedcanvas解析真实项目；ProjectForUser+active校验，素材按project_asset_links关系筛选。无项目只查当前画布关联asset和directresource节点；每页最多20，不返回其他项目facets或任意路径 |
| 查询模型和参考能力 | model.catalog | 返回公开模型目录、类型与参考能力，不含密钥；实际可用性仍由节点配置校验 |
| 配置镜头模型和参数 | canvas.node.configure | 草稿metadata类型化配置，实际model kind/可用性校验；image/video/audio字段与界面一致，真实回执/CAS/撤销；capabilities/v5、descriptor3；不生成不付费 |
| 把创意变成镜头草稿 | canvas.nodes.create、canvas.node.update | 新建 title/type/prompt；更新 title/prompt/content，revision 校验；保存回执可恢复/撤销 |
| 批量准备分镜制作 | canvas.script.prepare | 复用已写分镜，一次建立首帧/视频、参数、引用、行绑定与排布；整批CAS和回执，拒绝覆盖已有绑定；不生成不付费 |
| 移动、删除镜头或移除参考线 | canvas.node.move、canvas.node.delete、canvas.edge.delete | revision 校验、原子回执和撤销；删除节点不删除素材库原件或任务 |
| 将素材绑定成可用参考节点 | canvas.node.bind_asset | 指定已引用或当前项目授权的素材；校验同 owner、素材资源关联、READY 与媒体类型，CAS 保存真实 content/storageKey/assetId；不生成不付费 |
| 给镜头关联参考节点 | canvas.edge.create | 当前画布节点，重复边幂等 |
| 将已生成产物放回草稿 | task.get、canvas.task.bind | 本轮/明确引用任务，资源 READY 且归属正确；恢复不重复付费 |
| 剪裁、排序、调音量、字幕 | canvas.timeline.update | 当前画布已关联素材；revision 校验、时间区间验证；不接受任意路径 |
| 输出可检查的本地成片 | canvas.timeline.render、task.get | 本地 FFmpeg，不付费；时间线参数校验，通过任务查产物，再用媒体工具审片 |
| 请求付费镜头生成 | canvas.generation.propose | 只提议，由界面显示模型/费用并让用户确认后提交 |
| 按自己的流程工作 | skill.catalog、skill.get、skill.file | 目录只列本人已安装、已启用技能的当前版本（名称、说明，不含正文）；正文读取限本轮选择、同一对话之前选择过或当前安装的版本，按版本精确匹配。只读包内声明的文本辅助文件。重启保留 pin；重新验证安装授权与文件 SHA256；未提供脚本执行能力 |

`canvas.search`、`asset.list`、`canvas.document.commit` 不在当前画布模式白名单内；只读模式开放本用户工作区读取，完全访问还开放整文档提交与跨画布写入，仍校验归属、revision 和整组撤销。`conversation.message.attach` 不向内置助手开放。

## 要真正出有用短片，还需要接上的动作

| 使用者的需求 | 当前缺口 | 已有实现可复用的位置 | 接入要求 |
| --- | --- | --- | --- |
| “选一个支持这个参考视频的模型，调时长/比例/音频” | configure 已开放类型化模型/参数修改；model.catalog 已开放公开模型与参考能力查询，实际可用性仍由节点配置校验 | `operations/ops.go` ResolveAssistantGenerationModel/proposalModelKey、`canvas/capability`、`app` 模型/渠道 catalog；`canvas` 的节点 patch 与持久化 | 已接入 model.catalog 和类型化参数配置；依据实际 schema 校验，预估费用随参数变更；不暴露 API key |
| “从这个项目里找那条采访” | 当前项目的media/canvas搜索已开放；当前画布模式不开放跨项目整库搜索；只读与完全访问允许本用户工作区读取 | `operations` asset.list/canvas.search；`app/canvas_bridge.go` UserCanvasProjectsPage、UserCanvasProjectSummaries，资产查询领域 | 已实现：真实当前canvas ProjectID+owner/active校验，page<=20，资源读取每次Go重新查DB关系；删除关联、切换项目、归档后旧搜索ID不继续授权。metadata.projectName/projectIds标签不参与授权 |
| “删掉这个废镜头，移开重叠节点，去掉参考” | 已开放 canvas.node.delete、canvas.node.move、canvas.edge.delete | `canvas` 文档保存与 revision、`app/canvas_bridge.go` UpsertUserCanvasProjectWithTx、assistantturns 轮前快照/撤销 | 局部、类型化、同事务回执；真正用户删除不能被旧任务恢复 |
| “这个任务不要了”“失败后再试一次” | 只有 task.get；取消/重试未开放 | `app/service.go` CancelTask、RetryTask；`app/provider_task_cancellation.go` 上游取消对账 | 取消仅明确本轮任务；未知上游状态不重复提交。重试付费必须重新确认预算与参数 |
| “把参考视频加入素材库并连上草稿” | 附件上传已登记真实素材并立即供再次引用；自动创建画布节点与参考线需另行调用画布操作 | `app` 资源上传、资源 READY、资产与画布提交；`operations` edge.create | 把引用与库资产区分；上传失败保留可重试状态；引用需有所有权，不使用模型任意 URL/本机路径 |
| “这个 Skill 需要执行 scripts/*.py” | 目前故意没有脚本执行器；文件可读不代表执行 | `skills/agent_resources.go` 包文件声明、大小/SHA、unsupportedCapabilities | 当前回复说明缺少能力并保留已完成步骤。若后续加入执行器，需独立受限环境、具体能力与副作用契约；不能调用宿主通用 shell |
| “安装插件、修改渠道/账号、更新客户端” | 产品管理能力未做助手工具 | 插件注册与安装服务、已有设置/升级 UI | 操作会影响全局/外部系统，不应以当前画布授权隐式执行；显示可评估结果与明确用户确认 |

## 当前验证证据

旁白裁切使用实际音频听取与 `media.check` 的客观低音量区间共同选候选剪点，并再次听取裁剪后的片段。`silenceIntervals` 采用固定 -35 dB、连续至少 120 ms 的检测条件，时间沿用原素材坐标；不提供词级时间戳，也不能单凭检测证明尾字完整或成片声音正确。真实模型听取、裁剪与成片复核仍须单独验收。

- 三个通过真实 ZIP 上传安装的合成用户技能：咖啡分镜、采访原话草稿、依赖未提供脚本的声音审片。不是抽象 list UI 验证。
- `skills/agent_resources_test.go` 验证旧版本保持、卸载后拒绝、私有包归属、文件摘要损坏、路径穿越、脚本不可执行。
- `assistantturns/skill_pins_test.go` 验证 SQLite 重开后 pin 恢复与同 turn 换版本拒绝。
- `handler/skill_host_integration_test.go` + `agent-host/test-support/skill-business-probe.mjs` 用真实 Go/SQLite 与生产 Durable 宿主、loopback 模型验证固定技能正文出现在官方模型请求、skill_file 返回真实辅助文件、业务草稿保存。脚本案例必须无画布改动并明确尚未执行。
- 以上为隔离 fixture 集成验证，不代表观察了真实用户已安装技能、真实线上模型遵循性、桌面可用性或最终短片质量。付费生成与用户桌面终片验收仍需要各自的授权和实际材料。

## 项目搜索实测补充

`app/operations_project_search_test.go` 使用真实SQLite项目与assetlinks、真实上传PNG、共享operation registry及Go scope callback。验证search→media.overview→media.inspect可读；模拟伪造metadata项目标签与foreign owner不能泄露；删除项目关系后inspect拒绝，切换当前画布所属项目后旧asset.get拒绝。无项目画布只列自己的direct resource node并分页。`operations/project_search_test.go` 拒绝模型提交projectId、任意kind及大页码/每页>20。

内部 `UserAssetPageFilter.ProjectID` 是真实关系筛选，与原有展示标签 `Project` 分开；只给分页素材，不返回整库facets。当前画布模式不开放通用 `asset.list` / `canvas.search`；只读与完全访问可读取本用户工作区。Go-only `ProjectReference(kind,id)` callback每次从当前DB验证，不把模型返回ID写进任何授权列表，因此恢复不延续已撤销的搜索权限。当前共有27项共享操作；内置只读、当前画布、完全访问分别可发现13、23、26项。只读不含生成提议；完全访问不含对话消息产物绑定。
