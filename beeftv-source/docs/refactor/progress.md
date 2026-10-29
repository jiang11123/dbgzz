# 完整重构实施记录

本文件记录开发候选的真实状态；不是发布证明。范围与验收以 [实施合同](./implementation-contract.md) 为准。

## 已核实基线

- 15266ba 合并正式 v1.6.21 与 Agent 候选；035bb49 固定完整重构范围。
- 独立验证：`cd backend && go test ./internal/database ./internal/generation ./internal/beefapi ./internal/handler`。新工作树先运行 `./plugin-packages/build-packages.sh`，否则官方协议包缺失会导致 registry 测试失败。构建协议包后 generation 通过。
- 独立验证：`cd backend && go test ./internal/generation ./internal/app` 通过，app 用时 168.348 秒。
- 独立验证：`cd web && bun install --frozen-lockfile && bun run typecheck` 通过。
- 以上仅证明合并基线；不代表下列工作已完成，也不替代真实客户端、模型和发布包验收。

## 第一批并行实现

所有工作树固定于 15266ba，只有 Lead 向集成分支合入。Grok 不执行发布、真实数据写入或付费模型调用。

| 责任 | Grok job | 写入范围 | 集成前核查 |
| --- | --- | --- | --- |
| 迁移身份与实际结构 | 20261002-005355-delegate-035f0aa6 | database | 历史编号碰撞、结构缺失、未知列保留、失败重试 |
| Agent 宿主运行时 | 20261002-005355-delegate-4c14270a | 宿主 lifecycle、新 runtime、必要 bootstrap 接线 | 进程唯一 Wait、配置与凭据隔离、停止/恢复 |
| 公共业务操作 | 20261002-005355-delegate-53bc028d | operations、agentops 适配、canvas 合同 | 授权先于重放、事务与回执、无 app 反向依赖 |
| 生成结果可靠交付 | 20261002-005638-delegate-f5527881 | app/task、结果交付、task repository | 界面关闭仍可落地、故障重试不重复付费/节点 |
| 剪辑与导出完整性 | 20261002-005638-delegate-2ab89e9b | timeline、merge、export-integrity、zip | 实际音轨/字幕、执行器语义一致、备份引用 |
| 官方 pi 会话与事件 | 20261002-005825-continue-4b74edc3 | agent-host、助手事件投影 | dispose、官方持久化、隔离加载、取消/压缩/重试 |
| 画布页面职责 | 20261002-010449-delegate-75be177f | project 页面、新私有 controller | 不以巨型 hook 搬家代替解耦、保留交互 |
| 协议插件领域 | 20261002-010449-delegate-0a5e6e6c | plugins、app 插件适配 | 单一注册表/变更所有者、实际实现退出 app |

## 基线回归排查

直接 `cd web && bun test`：2311 pass / 10 skip / 37 fail。该命令绕过仓库隔离入口，`mock.module` 污染后续文件。逐文件复核后，除浏览器运行时未指定路径外全部通过。

已修复一处实际合并回归：明确 `local_storage_failed` 的准入失败保留“尚未提交生成”；普通数据库错误仍不推断上游是否接单。`bun test test/generation-error.test.ts`：64 pass / 0 fail。

正确全量入口：`cd web && CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' bun run test`。结果 2389 pass / 0 fail / 10 skip，退出 0。使用仓库 `scripts/run-test-suite.mjs` 的既有隔离规则，没有删测试。

## 独立审查与合入

| 切片提交 | 独立验证 | 决定 |
| --- | --- | --- |
| database 2d8b3ce | 完整生产 diff 与历史 DDL 夹具审查；`go test ./internal/database -count=1` 通过，2.426s | 合入为 331857a；公开文档跟进 |
| runtime 17f5f35 | runtime/handler/bootstrap 测试通过 | 暂不合入；新领域反向依赖 app、请求级临时 Host 必须修正；继续 job 20261002-011135-continue-c3772d17 |
| editing b9fb278 | 实际 native FFmpeg + 执行/计划/完整性测试，29 pass / 0 fail | 暂不合入；共享 worker 取消所有权、空备份限制、实际 native 调用边界需修正；继续 job 20261002-011554-continue-f082d24e |

第二批项目领域：job 20261002-011319-delegate-63acf902，工作树固定 0d29c11，负责项目实际规则退出 app、消除 project/localapp 反向依赖。仅允许项目相关接线，不能改生成、素材、宿主或插件核心。

## 后续审查与并行接入

- runtime 修正 a7dd50b 独立测试通过：assistantruntime 1.663s、assistant 1.155s、handler 3.064s、bootstrap 14.861s；合入 ecda201 / 1218b3e。Lead 进一步移除独立路由注册的无 Close 所有者 Host 兜底，集成 handler/bootstrap 通过。
- pi 5541435：54 pass / 0 fail；额外确定性复现并发 replace 泄漏和 current.json 写失败后的状态分裂，未合入。继续 20261002-012611-continue-352b1416。
- generation fdf34aa：未合入；恢复仍依赖 GET、元数据覆盖与错误吞没待修。继续 20261002-012722-continue-ab34e728，实现后台恢复和实际 taskdelivery 领域。
- plugins e03031e：未合入；同包重装失败可能删除旧包、管理状态回滚存在并发窗口。继续 20261002-012809-continue-39115e00。
- operations 7000765：聚焦四包独立测试通过；修复调用身份 fail-closed 并接入人工画布保存，继续 20261002-012045-continue-a38f46d6。
- Agent 业务轮次：20261002-011801-continue-a7418435，固定 331857a，assistantturns + schema 10；官方 pi 保留会话事实，SQLite 负责业务轮次和撤销事务。
- 模型目录/能力/渠道：20261002-012935-continue-dead2721，固定 1218b3e；实际规则退出 app，保留上游参数合同。

以上都在独立工作树；尚未进入发布验收，没有新增真实模型费用。

## 第二轮审查

- editing 911bc1a / 708fc35 / 0c9d91b 已进入集成。Lead 复现取消当前工作时，后续租约拿到已终止预热 worker 的竞态，直接修正所有权转交与 dispose；36 项聚焦测试、2 项真实浏览器 worker 测试和 typecheck 通过。实际原生/浏览器共用内容计划继续由 20261002-014317-continue-8982ff92 实现。
- project fc96599 独立 project/localapp/handler/bootstrap 测试通过；仍有章节/关联分步写入、更新无 CAS 和父文件夹归属问题，继续 20261002-013550-continue-babf5c0c，尚未合入。
- assistantturns 408c16e 独立迁移/领域/应用聚焦测试通过；旧 JSON 双写、Begin 未优先迁移旧 ID、清理后可重导入、损坏 scope 静默降级必须修正。继续 20261002-014449-continue-1ca2e878，尚未合入 schema 10。
- 资源真实领域：20261002-013215-delegate-6c5c1bb2，固定 673e320；保持现有生成存储方法适配，不能与交付 worker 重复拥有任务逻辑。
- 旧 Agent 退场：20261002-013853-delegate-63e3a533，固定 673e320；只移除已验证无活跃入口的实现，保留历史数据及现有功能仍使用的公共规则。
- CPU 数据处理基线已记录于 [performance.md](./performance.md)，并非 UI 或数据库端到端性能结论。

## 后续必须继续的范围

### 第三轮集成核查

- pi `5541435` + `ea763e8` 已合入 `0174d60` / `561073e`。独立官方 SDK 宿主测试 75 pass / 0 fail；前端事件投影测试 40 pass / 0 fail。
- 在 `372a835` 上按仓库隔离入口完成全量前端回归：2414 pass / 0 fail / 12 skip，退出 0。跳过项不是已验收；剪辑真实媒体仍需专项输出验证。
- 项目核心 `fc96599` + `362a491` 合入 `2ade7a4` / `f065ae0`；独立 project/repository/localapp/bootstrap/handler 通过。项目素材、角色、分镜、工作流实际领域继续 `20261002-015848-continue-a98109ad`。
- 旧 Agent 退场 `50931cf` 合入 `6666186`；独立 app 全包 179.928s，handler/bootstrap/generation/database/repository 通过。历史表保留，现行 pi 入口保留。
- 模型规则 `fbf25da` 合入 `5f416c8`，Lead 保留非字符串 metadata 的严格读取语义（`d750b18`）。独立 modelcatalog 与 app 相关能力/渠道/助手/Seedance 测试通过。模型服务与路由实际归属继续 `20261002-020309-continue-bb37025d`；Provider 执行另由 `20261002-020308-continue-35d509a8` 负责。
- assistantturns `408c16e` + `f26c674` 合入 `64aa600` / `80a493f`，schema 10。独立迁移、轮次和 app 聚焦测试通过。旧 JSON 为只读输入；SQLite 为唯一业务轮次账本。
- operations `7000765` / `96593b0` / `94f2f31` 进入集成 `d29fe0e` / `69666a9` / `3a826bc`；独立后端五包通过，前端 36 pass。人工提交日志仍有 IO 失败、scope 切换与取消后身份保留缺口，继续 `20261002-020021-continue-4a95b35b`，本次合入不代表该边界验收完成。
- Lead 已在操作事务里接入轮次开放校验，修正遗留 JSON 读取测试；agentops/operations/assistantturns 独立集成测试通过。覆盖预检后结算拒绝写入、先提交的写入被结算记录、缺少轮次事务校验时失败关闭。
- 画布组合 `8963bb4` 合入 `3286bfe`；独立 11 文件 125 pass / 0 fail。页面仍有后续职责与异步写入边界要收口，不能只以行数变化为完成证据。
- 交付恢复继续 `20261002-015749-continue-0dfdf1f7`，补公平扫描与失败资源重试；资源继续 `20261002-015750-continue-d01fd274`；插件继续 `20261002-020352-continue-c1b4f643`，补数据库卸载事务与失败后的内存视图一致性。三者尚未合入。

1. 人工 UI 已接入公共操作，继续补提交日志持久化失败、scope 切换与未知响应后的幂等身份保留。
2. 配合后端结果交付切换前端 materializer/consumer，完成节点/消息与回执的原子绑定，避免两个执行者同时交付。
3. Agent 业务轮次已改为 SQLite 单一账本并接入操作事务；继续在整合后验证确认、撤销及会话恢复。
4. 模型目录、Provider/Protocol/Transport、RunningHub 的实际实现归属；插件状态与包文件的失败恢复。
5. 工作区、项目、素材、配置与生命周期接线。project/localapp 已解除 app 反向依赖，LocalKernel/task facade 的生产组合根仍需切换到实际领域服务。
6. 旧 Agent 活跃实现已移除；整合中持续守住历史数据保留和旧任务拒绝边界。
7. 真实媒体输出、备份还原、平台升级、性能对比、完整回归、独立复审和新候选付费验收。

### 第四轮审查与交付衔接

- 整合快照 `6840b32`：前端 typecheck 和 `go test ./...` 通过。此前独立重跑 app 全包 193.509s，handler/bootstrap 43.788s/49.708s，operations/agentops/assistantturns/modelcatalog/project/localapp 均通过。不是最终候选全量验收。
- 生成交付 `373fd84` 独立 task/taskdelivery/app 聚焦测试通过，合入 `baec6fd` / `f9a101f` / `d9a97ac`。包含后台公平扫描、同资源身份恢复、READY 所有权校验；节点绑定仍只是意图。后续 `20261002-022438-continue-54fd462d` 负责原子画布绑定和前端交付切换。
- 任务运行时 `d6b8db8` 尚未合入。Lead 发现空 ResultWriter 造成虚假 Applied、Commit 失败状态、StartLoop 重入与槽位释放问题，继续 `20261002-021807-continue-0e6afbed`。
- 资源 `84175ac` / `1e279f3` 尚未合入。继续 `20261002-021808-continue-6370b477`，补删除事务中的运行任务引用检查，以及同一工作区多个服务句柄的 PENDING 所有权。
- 剪辑计划 `484eaaa` 尚未合入。Lead 发现图片分支无限音源未限定输出时长、执行器可覆盖计划参数、采样率与混音策略不一致，继续 `20261002-022311-continue-9d7dc656`；要求实际媒体输出与空工作区 ZIP 还原。
- RunningHub 实际协议域由 `20261002-021904-delegate-ea62673e` 独立实现，固定 `6840b32`，与通用 Provider 切片不重叠。
- 创作页对话原为 IndexedDB 唯一持久状态。`20261002-022128-delegate-0883fddd` 负责 SQLite aggregate、CAS、旧缓存幂等导入与删除 tombstone，为原子消息绑定提供事务端口；schema 11 只保留给该切片，尚未合入。

### 第五轮整合与独立复审

- `dcbe8ed` 全量前端隔离回归：2409 pass / 0 fail / 12 skip；operations/assistantturns/taskdelivery race 通过。
- 发布包补齐 pi 新宿主模块，使用内置 Node 24.15.0、空 PATH 和隔离数据目录完成实际启动，3 项测试通过、模型请求 0。合入 `e2ed6c7`。
- 工作区身份及配置 `f09c75a` / `ac32331` 独立测试通过，合入 `0409d30` / `1ae05aa`。渠道凭据仅按 ID 匹配，null 配置和异常路径失败关闭。
- 资源域 `84175ac` / `1e279f3` / `f2f495c` 独立资源/仓库/app 测试通过，合入 `e5b9728` / `75be749` / `c7f4443`。任务运行时 `d6b8db8` / `fff369a` race 通过，合入 `dc60669` / `0900f4d`。模型路由 `2dd4fbe` 独立 race 通过，合入 `6545fa1`。
- 以上整合回归发现 1 项旧测试通过修改 Service.dataDir 注入故障，与固定资源所有者冲突；改为在同一工作区制造、解除真实文件系统故障后专项通过。其余 app 测试以及 asset/workspace/taskruntime/modelcatalog/bootstrap/handler 通过。不把原先整轮失败记为通过。
- 组合根改接实际资源服务和工作区身份域，删除 LocalKernel 资源转发与旧 Asset 边界；asset/bootstrap/localapp 回归通过。任务服务组合根仍等待准入修正。
- 独立 Agent 审查 `20261002-023129-review-ac6d2341` 为 REPAIR。Lead 已核实未受监督残留进程被当作可用、子进程凭据/端口继承、取消接口权限缺口，交给 `20261002-024935-continue-d922e56d` 修复；不是发布签核。
- 待复审：任务准入 `20261002-024307-continue-6693893d`，资源交付与删除/准入事务 `20261002-024418-continue-b310dc32`，画布异步归属 `20261002-024510-continue-a21de995`，项目产物/版本事务 `20261002-024639-continue-63120f34`，RunningHub 实际提交边界 `20261002-024707-continue-d8c2dc8f`。

### 第六轮集成与数据一致性复核

- 剪辑 `484eaaa` / `ce1bc68` 合入 `8381c3e` / `8f48c6e`。独立 Go editing/app/handler 通过；实际原生 FFmpeg、ZIP 与计划测试 20 pass；集成真实浏览器 Worker 10 pass / 0 fail，覆盖媒体输出、取消重试、下载和卸载。ZIP 的浏览器夹具不能代替 SQLite 新工作区重启验证，后者继续 `20261002-030258-delegate-cfcf463f`。
- 任务准入 `25ddcbf` / `ede5a09` 合入 `5bb1074` / `4d761dc`。Lead 在 `89954d2` 对齐资源、模型和结果交付投影，组合根直接使用实际 task.Service。独立 task race 与集成 task/bootstrap/localapp/app 创建、重试、创作测试通过。旧 facade 清理继续 `20261002-030258-continue-796dad23`。
- 人工操作日记 `0348069` 仍未合入。Lead 确认生成回写的集合合并会复活删除节点、覆盖文字，以及等待日记写入期间的新编辑；`20261002-025853-continue-2aa16ede` 实现三方合并与确认发布顺序。
- 插件 `195b8e3` 仍未合入。SQLite 已成为 registry 唯一权威，但启动顺序仍先提交后校验，导入重复 ID 会被折叠；继续 `20261002-030414-continue-5fd369e1`。包文件还需目录持久化和并发读取核对。
- RunningHub `93ddc50` 仍未合入。领域返回了受理但保存失败的类型，实际任务终结与重试尚未识别；继续 `20261002-030604-continue-f49712e0`，禁止将返回错误类型本身当作重复付费防护完成。
- 所有本轮验证仍使用隔离数据与测试替身；没有新增真实生成费用，尚未进入发布验收。
- `89954d2` 全量 `go test ./...` 退出 0（app 209.772s、bootstrap 68.663s、handler 54.098s）；`3cbb9d1` 前端 typecheck 通过。Go 依赖图核对未发现新领域对 `internal/app` 的反向依赖。
- 任务旧门面 `98feebf` 合入 `d1e2a24`，移除 task.Backend/New/lifecycle 转发，只保留真实领域服务；`retryOf` 非字符串明确拒绝。独立 task/localapp/bootstrap race 专项通过。生产任务非空作用域仍有未知 ID 放行，继续 `20261002-031714-continue-c73db5e9`，与 READY 素材事务相邻合并。
- Provider `cc8b241` 尚未合入。主要协议与 HTTP 算法已迁到 generation，Lead 正收紧运行依赖和请求记账；`20261002-031331-continue-bd76d8a3`。RunningHub Field 别名由工作流切片提供，合并时删除重复 JSON 算法和全局回调。
- 项目 `ca1fa3e` 尚未合入；继续 `20261002-030923-continue-908c8c7d` 完成前端快照 revision 传递。资源 `325a34d` 尚未合入；继续 `20261002-030846-continue-0ce9b886` 保留生成专用限额并核对恢复记账。
- 素材库 `4fe28cc` 尚未合入；继续 `20261002-031014-continue-be4624db` 关闭缺失 Host 的安全降级、整批配额和事务引用窗口。画布 `8f6918d` 尚未合入；继续 `20261002-031107-continue-a590130c`，把页面作用域延伸至分段上传及等待后的实际请求。
- 创作执行 `7857208` 尚未合入；继续 `20261002-031623-continue-2e3dc0b4`，核对真实审批凭据、活跃租约、事务内素材验证及实际任务幂等，不以假端口中的付费调用代表生产证据。

项目素材、角色、分镜和工作流已进入 `internal/project`（见 [projects.md](./projects.md)）；`app` 仍保留任务解密、任务列表和交付读补偿，后者将在后台完整恢复接线后退场。

### 第七轮领域集成与恢复复审

- 素材库 `4fe28cc` / `d322817` 合入 `63ceb0c` / `9f491dc`。独立 asset/canvas/repository race 通过；集成 asset/canvas/handler/app 通过（app 193.717s）。批量配额、资源和画布引用仍由实际调用链校验。
- 插件完整切片至 `405ea68` 合入 `7f01522` / `6ce8e2a` / `68f118b` / `1c8e5c1` / `b713c34`。独立 plugins/repository race 通过（267.890s / 2.602s）；集成 plugins/repository/app/handler 通过（app 271.256s）。生产注册表为 SQLite 单一权威，包文件导出校验哈希。Windows 目录同步仍有平台能力边界，不能用 macOS 结果代替 Windows 验收。
- 项目实际领域至 `fd975cb` 合入 `aceb1ce` / `7230598` / `1671213` / `9c509c4` / `885e6b4` / `7a31174`。独立 project/repository race 与前端 typecheck 通过。Lead 在 `c318453` 去除默认工作流绕经 app 的回调，领域自身生成工作流；聚焦 project/app 通过。刷新恢复分镜仍须保留原批准快照，继续 `20261002-032830-continue-0f08e07e`。
- RunningHub 至 `48c54e3` 合入 `3cc9571` / `0acc7cf` / `da01b85` / `6a10d4a`。Lead 修正插件切片合并后的规范化调用和超时测试计数竞态，集成 workflow/app race 专项通过（1.445s / 2.451s），覆盖完整任务未知受理与禁止重试链。原独立 app race 失败不记为通过。
- `7a31174` 集成 project/app/bootstrap/handler 全包通过（app 246.859s、bootstrap 75.765s、handler 54.703s），仍不是最终候选的全量验收。
- Agent 监督器 `45c1e47` 尚未合入：独立 Go race 与 Bun 生命周期测试通过；继续 `20261002-032729-continue-7077865a`，避免未知健康状态被当作空闲杀掉生成，并处理非法认证字节。
- 画布绑定 `4f6e9a0` 尚未合入，继续 `20261002-033055-continue-e4145505`：历史回执不能覆盖新任务节点，失败的草稿保存不能继续绑定，确认版本必须来自完整服务端投影。消息原子绑定等待 conversation schema 11。
- 任务作用域 `2add02b` 尚未合入；删除画布会清空历史 task.project_id，重启后重试可被误当独立任务，继续 `20261002-033401-continue-c53f5fa8`。资源 `2d2bc4d` 继续 `20261002-032808-continue-eb655c0f`，恢复提交不得扣除其他上传的预留额度。
- 对话与画布上传出现 scope epoch 公共文件接缝，集成时必须统一为同一计数与订阅，不允许两套身份时钟。人工画布三方合并继续补 pending projection 的崩溃恢复。

### 第八轮整合与端到端边界

- 画布 UI 至 `b29148d` 合入 `781212f` / `f9277fa` / `bc79199`，Lead `6a60446` 添加可见交接重试入口与中文账号切换提示。独立及集成 67 pass，typecheck 通过。公共 scope epoch 与 conversation 订阅共用同一个时钟。
- Provider `cc8b241` / `e475ba4` 合入 `7fbe3f3` / `09a8d15`；Lead `8525690` 收紧 Limits 依赖、删除重复 workflow Field 和全局回调，generation/workflow/app race 专项通过。该快照的全量 Go 曾因旧空 Service 测试夹具失败；`0791ac6` 改成真实本地策略与任务夹具，Seedance 仅轮询原任务、无需已删除参考素材的专项通过。不能把原全量失败记成通过。
- 任务作用域 `2add02b` / `d8624f5` 合入 `dbb5be4` / `9dbe21b`：已删除/归档作用域禁止新准入，历史 task.project_id 保留，原 client operation 重放仍优先。集成 task/project/repository/app race 通过。
- 对话 `f7c10ad` / `cfe8999` / `239bb15` 对应合入 `a55634e` / `8522e53` / `1e003c3`，schema 11。`b9a2745` 接入实际组合根、统一账号时钟，采用既有 4 MiB 结构文档边界，移除新增的 1000 条消息和 64 KiB 单字段限制。conversation/database/handler/bootstrap race 通过；前端 42 pass 与 typecheck 通过。消息结果原子绑定继续实现。
- Agent `45c1e47` / `cfc32b5` 合入 `576aad8` / `9922328`。集成 runtime/handler/bootstrap/assistant race 通过；官方依赖安装后生命周期 5 pass。打包使用 Node 24.15.0、空 PATH、带空格目录，3 pass / 0 模型调用。首次生命周期测试因集成树缺少依赖失败，未伪记通过。独立复审 `20261002-040018-review-4d55c6e9` 仍进行中。
- 项目分镜恢复 `4f2eba8` 合入 `7a111ca`，只自动应用原批准快照；冲突/旧任务保留结果供明确核对后写入，不重新生成。创作领域 `7857208` / `a92fb3b` 合入 `936c0b0` / `aabe821`，`a3b4d00` 直接调用实际任务域 PrepareOnly，删除旧私有准备标记。creation/app/handler race 专项与章节前端测试通过。
- 画布绑定 `4f6e9a0` / `3964fcf` 合入 `968fa61` / `8bed2fb`；集成 taskbinding/operations/agentops/canvas race 通过，前端绑定及章节 29 pass，typecheck 通过。Lead 仍发现本地 fallback 伪造确认投影、投影错误吞没和过早写 store；`20261002-035911-continue-f32ddfe4` 在新集成基线修正并实现消息原子绑定与后台恢复，不能当作边界已验收。
- 资源 `325a34d` / `2d2bc4d` / `6e4a2c4` 合入 `5407617` / `bf77b96` / `020f575`。READY 资源与作用域在同一任务准入事务检查；生成恢复使用原身份和 GeneratedFileMB。Lead 修复嵌套创作事务不能另取 pooled connection，补单连接回滚测试，并映射资源未就绪/坏输入到用户可处理错误。repository/asset/task race 与 app 创作/交付/配额专项通过。普通上传失败额度与分片会话准入仍由 `20261002-035434-continue-8e6b0071` 收口。
- `c7d9d3c` 让画布/创作配额的策略读取使用同一事务仓储；单连接 SQLite 中未提交策略可见性及相关 race 专项通过。宿主、生成与资源的实际产品入口仍需最终冻结候选联合验证。

### 尚在执行的完整性补齐

- 人工画布提交日记：`20261002-035249-continue-358efd28`，完整 pending projection、A→B→A 及真实 HTTP dispatch 的同一 epoch。
- 备份：`20261002-034350-continue-f6b7fd0d`，并发失败清理、内容身份、实际服务端读回；画板文档与文件夹仍须同样以 SQLite 为提交权威，schema 12 专用于此。
- 原生渲染与转写 `20261002-035403-delegate-55a59d90`；播放转码与深度捕获 `20261002-035404-delegate-cb8dbd53`；Eagle/诊断/appearance `20261002-035406-delegate-07a755ef`；文本回放 `20261002-035408-delegate-0c84ccc0`。这些是只读完整性审查定位到的真实旧 app 算法，不按文件行数机械迁移。
- 模型准入选择仍在旧 app/task_creation.go；`20261002-040134-continue-e8b01dc6` 收入已有 modelcatalog，保留系统渠道、变体和自定义渠道合同。
- 以上没有新增真实生成费用、没有发布。后续仍需全量回归、实际媒体/新工作区重启、性能/平台/发布包和有明确预算的真实模型验收。

不得将第一批 worker 完成、目录分包或旧版验收报告写作“完整重构完成”。后续变更需按实际依赖顺序实现与验证。

### 第九轮集成与独立复审

- 文本回放四个提交合入 `0d33a89` / `fcbdb67` / `74ce210` / `e2f7d73`；`dd5713c` 删除进程级 Service map，由同一 runtime 持有领域实例和缓存，任务、HTTP 与清扫共用。textreplay/app/handler/bootstrap 相关 race 专项通过。
- 原生剪辑与转写合入 `3cd763f` / `8d44111` / `00d0a4b` / `165016d`。editing/transcription 领域专项通过；集成 app 仍有两个创建测试引用未登记资源，不能记为整体通过。`20261002-042302-continue-19c37d4c` 补 READY 夹具、生成输出身份/配额与实际输出校验。
- `235219a` 修正 supervisor 测试先发布 endpoint 再覆写 PID 的竞态，并让能力目录测试对照实际注册表及宿主可见范围；父进程杀死专项三次 race 通过，能力目录专项通过。此前全量 Go 的这些失败保留为失败记录，尚未重新完成全量。
- 独立 Agent 复审发现真实启动依赖循环：父端尚未 Serve 就等待会读取父端 `/ops` 的子进程就绪。`25ed58e` 先 Serve，新增真实 Node/pi 首次启动断言，避免 status/Ensure 后备重启掩盖失败。真实宿主启动与桌面打包布局链路 race 通过，模型请求为零。
- 人工画布恢复至 `10b3c43` 合入 `1241c4c` / `be358dd` / `37913b6` / `76dc941` / `141db35`：服务端完整确认快照、pending projection、三方合并和 entry epoch 贯穿提交队列及 HTTP。集成 typecheck 与 76 项专项通过；保留公共 scope 单一时钟、conversation 订阅及绑定 API。
- 模型准入 `f60a486` 合入 `a03499f`，实际 Select 调用 modelcatalog；系统渠道重建、规格默认、上游模型和 variant 选择离开旧 app 算法。modelcatalog/app 专项 race 通过。
- `b90e382` 更新视频找回浏览器夹具，提供已交付素材及完整服务端画布绑定回执，验证原任务不重新生成、绑定恰好一次。浏览器 5 pass；绑定生产错误恢复仍由下述 worker 收尾。

### 第九轮仍未关闭的问题

- 独立核心复审发现事务内 canvas host 抢根 storageMu 与先锁 storageMu 再取 SQLite 连接的路径形成 ABBA。`20261002-042350-continue-7a00bb5a` 修复 TX-aware 锁并补单连接真实写/撤销并发回归。
- 分片上传 `9a64c0b` 暂不集成：并发 chunk/complete、整份内存拼接、同 key 不同请求、失败/重启额度归因仍有问题。`20261002-042018-continue-5b26d8c5` 继续；schema 12 为 backup 独占，如必须增加上传归因表只能独立 schema 13。
- 播放/深度 `63edaeb` 暂不集成：播放仍有 Runner 拒绝后裸 goroutine、重新启动 worker、无界失败回填等生命周期问题，`20261002-042833-continue-6aa5137c` 修复。
- Eagle/diagnostics/appearance `e12ca38` 暂不集成：Eagle redirect 和真实路径 symlink jail 仍待收紧，`20261002-042228-continue-7166c008` 修复。
- 消息原子绑定/后台交付 `20261002-035911-continue-f32ddfe4`、项目结果应用回执 `20261002-041143-continue-dfc02ab9`、素材 UI 后端权威及 epoch `20261002-041314-delegate-51107282`、完整备份及 schema 12 `20261002-034350-continue-f6b7fd0d` 仍在执行。
- 尚未冻结最终候选；未增加真实费用、未 push/发布。阶段性集成通过不能替代最终全量回归和真实客户端验收。

### 第九轮补充验证与辅助领域

- `2cd13b1` 快照前端标准 `bun run test` 退出 0：2546 pass、0 fail、14 skip。另在 `3dd522a` 明确开启浏览器 FFmpeg Worker 专项，10 pass / 103 expect；原生内容专项 4 pass / 77 expect，覆盖原声、人声、背景音乐、中文字幕、静音/淡入淡出和图片时长。未把 opt-in skip 记为通过。
- `3dd522a` 为渲染/转写/深度等专用任务复用任务领域准入错误映射，缺少素材/不可用项目/坏 JSON 不再误报 500 本地存储故障。SQLite 拒绝后无任务行的专项 race 通过。
- 辅助领域至 `f35fd5a` 合入 `51d7511` / `10f98a7` / `d42ec46` / `939dbae`，`0559fb2` 注入运行时拥有的 Eagle 客户端和同一 diagnostics/appearance 实例。Eagle 不跟随 redirect，真实路径 jail 保留合法库根 symlink；诊断脱敏、外观坏文档删除保护在领域内。三个领域完整 race 通过；app/handler/bootstrap 相邻专项 race 通过。没有真实 Eagle/真实账号调用。

### 第十轮复审修正与集成

- 原生剪辑修正合入 `b3a17d7` / `7eeff30`；`2974647` 保留有界 stderr 尾部之外的字体失败判据，并按实际帧间隔校验短片时长。真实 FFmpeg 1 fps / 500 ms 回归先复现再修正；editing/transcription 完整 race 通过。原生所有 cmd 编译及 Windows internal 交叉编译通过，不等于 Windows 实机验收。
- 核心锁修正 `7ca98ab` / `9c4c4ca`：事务仓储不再抢根 storageMu；单连接 SQLite 的画布写、撤销与任务创建/完成四种交错均通过 race。测试用隔离 GORM 回调控制时序，没有生产全局测试钩子。
- 项目结果回执 `04e011f` 合入 `0461e66`；`acef7b4` 补严格回执身份校验及文本 SSE 在 A→B→A 后拒绝发布。实际 AgentOpRecord 与结果写入同一事务；刷新未应用分镜须核对，已应用结果不覆盖后续编辑。project/operations/repository race 通过，前端专项 19 pass / 78 expect，typecheck 通过。
- 播放与深度五个提交合入 `5a01a06` / `d8b7095` / `fe77251` / `d5f18fa` / `b6abd10`；`3eeef83` 由 runtime 持有领域单例和可取消 worker context，旧转码 claim 只恢复一次，重复扫描不重置在飞任务。四个领域完整 race、app 入口专项通过。实际 GPU / Windows 深度运行仍未验收。
- 分片上传 `9a64c0b` / `420580a` 合入 `12899f3` / `ddaf697`；`192fe09` 修正同一日额释放两次及生产 DataDir 缺失，资源会话锁覆盖并发状态读取。分片、上传、结构迁移、app/handler 专项 race 通过。schema 13 是既有日额账的预留恢复索引；schema 12 仍待备份领域合入，当前仅对临时测试库执行迁移。
- 整库 Go 回归正在运行，不能提前记为成功。

### 第十轮仍未验收

- 消息绑定 `5af8acb` 尚未合入；`20261002-044851-continue-4b37928b` 修复回执覆盖在途新草稿、持久化失败和类型化冲突。
- 素材 UI `c1c06df` / `491a062` 尚未合入。进一步缩小到草稿持久化：`20261002-045929-continue-98e63164` 补实际内容快照、持久写入顺序与准确版本 ack。页面和 folder 接线由 Lead 复审整合。
- 完整备份、实际画板/文件夹 SQLite 权威和 schema 12：`20261002-034350-continue-f6b7fd0d` 仍进行中。
- 无新增真实模型费用、未 push/发布、未替换本机正式应用；最终冻结候选、跨平台/性能/真实客户端与明确预算的生成验收仍是独立门槛。

### 第十一轮草稿、消息交付与复审

- 消息原子绑定合入 `a7dd851` / `01b82bb`，后台交付覆盖消息、画布和项目结果，普通 GET 不再负责写补偿。conversation/taskbinding/operations/handler/app 的绑定专项 race 通过。Lead 在 `23c0c56` 复现并修正最后一次草稿 remove 等待期间的新编辑丢失，以及远端删除消息被三方合并复活的问题；相关前端回归通过。
- 素材 UI 写入合入 `2561de1` / `c4cc58a`；持久草稿修正 `83ce956` 合入 `5ea78b0`。upsert 保存真实快照，删除保存 tombstone，按 scope 串行持久化，版本高水位不因 ack 归零。Lead 独立专项 23 pass / 76 expect，typecheck 通过，并补旧 hydrate 不投影进 A→B→A 新 epoch 的回归。
- `6460ffd` 在 HTTP 成功响应后重验原 epoch，文件夹投影也重新校验。独立复审指出任务轮询可能重试废弃 scope；Lead 补立即退出及 poll/SSE 最终查询发布前断言，A→B→A 轮询和 SSE 两项通过。
- 第十轮全量 Go **失败**：asset 只读测试仓储因启动清理调用未实现端口而 panic，已由 `ba228eb` 限定有 DataDir 的实际资源服务恢复，完整 asset race 再跑通过；bootstrap 5 秒冷启动在并行负载下耗时 5.295 秒，单独三次为 1.256 / 0.902 / 1.059 秒，完整 bootstrap race 通过。没有放宽 5 秒阈值，尚不能记录最终全量通过。
- `6ad3bf4` 将已有性能预算变为可执行比较：匹配运行时和夹具，超过 1.5 倍且增加超过 2 ms 才失败。本地 CPU 基准 `performance-integrated-cpu.json` 未越线；这不代表 UI 或跨平台性能验收。
- 独立核心复审 `20261002-050411-review-72951ad3` 发现终态资源与上传预留记录之间的崩溃窗口；Lead 核实，`20261002-052139-delegate-7d200e4d` 修复 READY/FAILED 重启结算、删除与同 key 重传。结论未关闭。
- 素材读路径仍有 local-workspace 误分流，`20261002-050721-delegate-17eb1316` 负责素材页、选择器与会话入口读取 SQLite 并叠加明确草稿。完整备份/schema 12 仍由原 worker 进行；二者均未验收。

### 第十一轮集成快照验证（42408c8）

- 标准前端 `bun run test` 退出 0：2599 pass、0 fail、14 skip。显式开启的实际媒体专项沿用本轮此前同实现的独立证据，不把这 14 skip 计为通过。
- `bun run build`、`bun run lint`、typecheck 通过；Web 产物 99.38 MiB / 105 MiB。仍有大分包提示，没有以构建通过宣称启动或渲染性能改善。
- 发布器 Python 测试 14 项通过。全量 Go 以 `-p 1` 执行中；备份、素材读取和上传终态修复尚未进入该快照，因此它不是最终候选验收。
- Lead 新增草稿 hydrate 的 A→B→A 回归最初因夹具缺少浏览器 window 未进入存储读取而超时；补齐夹具后专项 16 pass / 58 expect。没有修改生产等待时限。

### 主线前移至 v1.6.22

- `42408c8` 全量 `go test -p 1 ./...` 退出 0；app 184.387s，asset 3.406s，handler 33.023s。它不包含下面新并入的主线和仍执行的三个切片。
- 远端 readback 发现 PR #63 / `bcc3b05` 已发布 v1.6.22。集成保留导演台新流程、复制场景隔离、备份入口及操作栏换行，不以旧 v1.6.21 状态覆盖线上功能。
- 冲突按新职责合并：CORS 同时保留正式版识图头与重构 UI 凭据头；导演台回调进入拆出的 editor dialogs，已下线的模板弹窗不恢复；键盘禁用条件保留导演台与助手两边规则。新加入的图片回调/批量上传在原 epoch 与页面生命周期下发布，素材 API 沿用捕获身份。
- 合并后 typecheck 及导演台/复制/引用/会话/页面归属专项通过；最终全量与发布门禁须使用合并后的候选。

### 第十二轮：备份检查点与剩余权威存储

- `2b4e099` 合并主线后的标准前端回归 2783 pass、0 fail、14 skip；CORS 专项 race 通过。此证据早于以下备份检查点，不是最终候选。
- 原备份 Grok job 达到两小时上限。保留未完成工作为 `a173636`，通过 `8328722` 合入可审查检查点；schema 11/12/13 顺序并存，未修改真实用户数据库。最初 typecheck 有三处错误，Lead 已修复；画板/文件夹的事务、引用、草稿与账号切换仍须补完，不能视为完成。
- 重新分工：Grok `20261002-054515-delegate-bffb7f09` 修复画板/文件夹后端事务及 tombstone；`20261002-054821-delegate-a7d1eea9` 修复其前端持久草稿和 epoch；Lead 接手备份传输与完整恢复读回。素材读取 `20261002-053900-continue-8df0e6e1`、新导演台素材权威 `20261002-054013-delegate-1aa84e71` 并行执行。
- 上传结算 `6e7b45c` 尚未集成：Lead 拒绝通过“表不存在则成功”掩盖生产存储错误，也要求 FAILED 资源第一次重试即可正确释放旧预留。`20261002-055621-continue-248c250f` 继续修正。
- Lead 备份专项已补文字/布局/导演场景的完整字段读回、导演媒体重映射、原 scope API 传递，以及清理失败保留可见记录。15 项专项通过；真实隔离 SQLite 重启用例原本缺少 IndexedDB 夹具，正在补足测试环境后再跑。尚未完成最终备份验收。
- 未新增付费生成，未 push/发布，未替换正式应用。最终候选和真实验收仍未冻结。
- Lead 补齐仅用于 Bun 的内存缓存夹具后，真实 Go/SQLite 备份专项 2 pass / 49 expect：清空缓存、重启后画布/文件夹/画板和媒体字节仍可读取；坏包和保存失败不产生已保存画布。该证据不验证可播放媒体内容，也不关闭仍在并行修改的画板草稿/事务边界。typecheck 通过。
- 文件夹封面改为备份包内字节，不携带源资源 ID；导入保存到新文件夹并在重启后核对相同字节。默认失败清理只删除本次实际新建的素材，未绑定的资源由已有延迟孤儿清理回收，不按全局内容摘要误删旧资源。新 SQLite 专项 2 pass / 54 expect，导出专项 17 pass / 76 expect；清理回归曾被 Bun 缺少 window.setTimeout 阻断，补夹具后通过，没有在生产吞掉错误。
- 独立结构审查 `20261002-060445-review-cf4377b6` 固定 `88b5c76`，检查活跃 app.Service 业务归属与旧执行路径，不把类型别名或行数作为问题。素材读取继续 `20261002-060302-continue-7014d592`，补 canonical 项目来源聚合、asset.list 同过滤合同和跨页草稿计数。
- 上传结算 `6e7b45c` / `89e4db8` 合入 `359e835` / `d480a1e`。Lead 独立 repository/asset 完整 race 3.281s/6.417s，app 上传专项 race 2.016s 通过；生产缺表不再吞错，FAILED 第一次重试和重启结算有回归。当前 Web build 通过，101.26 MiB / 105 MiB。
- `d480a1e` 前端整套第一阶段失败于四个旧入口源码断言；迁移断言至新归属后专项通过，并修正本地导入进度文案、新建画布失败退出等待页。真实 headless Chrome 五项通过，包含新浏览器空间导入后 reload、缺文件、坏包及实际 PUT 503 失败入口。Bun/浏览器测试夹具分清原生 API 与纯浏览器存储，未用源码断言代替这五项行为。
- 同快照全量 Go 因新画板删除夹具缺少 canvas_unit_links 失败；补齐夹具后完整 canvas race 2.628s 通过。尚未重新记录最终全量成功。旧 restoreCanvasArchiveMedia 无产品调用者，已移除，导入只保留统一恢复流程；导出测试据实只声明包内字节检查。
- 导演台 `d5b0322` 暂未集成：拒绝生产导出测试复位接口把 epoch 重置为 1，AI 全景仍须同 epoch，`20261002-061624-continue-2d6d3709` 收尾。画板后端 `4acad09` 暂未集成：`20261002-061728-continue-41ddd32e` 去掉独立 8MiB 新限制，按既有结构化存储策略准入；Lead 合并时必须保留事务仓储绑定的 runtimePolicyWithRepo。

### 独立结构复审后的实际执行路径收口

- `890b224` 标准前端全套退出 0：2802 pass、0 fail、14 skip。全量 Go 的唯一失败为前述 canvas_unit_links 夹具，后续 canvas 完整 race 已通过；最终完整 Go 仍须在最后候选重跑。
- 结构审查 `20261002-060445-review-cf4377b6` 给出 REPAIR。Lead 核对了实际 desktop worker/handler 调用：生成主编排、图片恢复的全局服务表、剪辑/深度专用准入、模型/插件目录和首阶段媒体入库仍有 app.Service 业务体。不能据此前目录拆分声明完整重构。
- 固定 `890b224` 再拆四个独立 Grok 工作树：`20261002-062025-delegate-31b5a890` 生成主编排/图片恢复/退休 Agent 空钩子；`20261002-062025-delegate-80ec02ac` 专用任务领域准入；`20261002-062025-delegate-5cc8bf40` 模型/插件目录；`20261002-062025-delegate-418c3026` 媒体首阶段入库。彼此禁止改对方业务体；Lead 合并共享 composition hunks。
- Lead 将 generation/plugins/modelcatalog/operations/asset/canvas/creation/taskruntime/taskdelivery/taskbinding/agentops/assistantruntime/assistantturns/playback/depthcapture/transcription/workspace/provider-workflow 加入真正 go list -deps 防倒置测试，18 个领域通过。该证据只证明依赖方向，不代替业务迁移。

### 集成复核：保存回执与功能保留

- `c0ff9f4` 为首次画布 PUT 检查返回 project 的身份；空回执不得清掉 revision 0 草稿。专项 52 pass / 294 expect，typecheck 通过。
- `2b0bc92` 等待并发画板写入全部结束后才清理失败导入，避免清理后再次落盘；画板必须读回完整快照，canonical 预览与生成图必须有资源身份。专项 17 pass / 89 expect；真实隔离 Go/SQLite 重启验证 2 pass / 54 expect；typecheck 通过。
- 素材读取 `ae5cdce` 已完成 SQLite 项目来源聚合、统一筛选和跨页草稿总量。Lead 仍未接受其功能回退：生成历史仅首 120 条、清空回收站变当前页删除。`20261002-063010-continue-e6ddff5f` 保留完整原功能并补 canonical 分页、全部类别和草稿计数。
- 导演台 `3f9155a` 删除生产 epoch 复位接口，桌面上传失败保留 pendingRemoteUpload，AI 全景恢复使用捕获 epoch。Lead 继续追踪本地缓存经 ensureCanvasNodeAsset 被误认已保存的路径，`20261002-063221-continue-c2843ecc` 补实际持久草稿与成功回执边界，尚未集成。
- 画板前端 `f3af80a` 的文件夹大草稿仍使用 localStorage，已退回 `20261002-062315-continue-f4fdb6ec` 改为 scoped localforage，并保留已删除远端对象的可恢复草稿。
- 上传预留在 FAILED 重试 claim 后、重新预留前存在崩溃窗口；`20261002-062418-continue-16631d14` 用真实 SQLite 重启复现并修补。此前结算专项通过不覆盖该窗口。
- 四个结构归属 worker 仍在实施；未冻结最终候选、未新增付费生成、未 push/发布、未替换正式应用。

### 后端生产路径与素材确认继续收口

- 画布库事务、墓碑与迁移合入 `f1559fd` / `8c40993` / `b1f6458`：同一事务内验证资源归属、配额和 revision；删除文件夹同步更新画布历史。canvas/repository 完整 race 与 app 单连接专项通过，迁移夹具按 current 13 与 v12 身份分别检查。
- 模型/插件目录实际编排合入 `13e21e8`；首阶段媒体入库合入 `e2d9b75`，`404870b` 将生产 worker/恢复入口接入 taskId:inline 稳定身份。专项 race 通过；首阶段资源入库与第二阶段素材物化/节点绑定仍分开。
- 专用渲染、转写、深度任务准入合入 `8811762`：领域统一身份、项目归属、drain、幂等、持久化配额及活动任务上限；task/localapp/handler race 通过。前端任务观察与迟到结果的 scope/lifetime 修补仍在执行。
- `523c02d` 修复 FAILED claim 后无预留见证的恢复窗口；`b8bf939` 修复已消费 READY 缺字节修复失败被降级后重复计入额度。后者采用 SQLite 重开、物理写失败及最终保存失败回归，Lead 集成 race 正在运行。
- 独立审查 `20261002-064700-continue-b74c31ec` 对 `8811762` 上述五包给出范围内 ACCEPT，无新增 P1/P2；明确排除生成编排、前端画板/素材页和当时未集成的 READY 修补，不能视为最终整体 review。
- 导演台上传/草稿确认合入 `df5db34` / `92631f4` / `7e94e76`；Lead `0276452` 进一步验证素材写回执 ID，普通保存遇到仅本机媒体必须返回未完成，导演台显式返回 confirmed=false，画布批量归档不再误报成功。六文件专项 52 pass / 213 expect，typecheck 通过。
- 全量 Go `8811762` **失败**：app 中两项旧恢复夹具在 PENDING 缺见证时额外计入额度，分别为 `TestGenerationDeliveryRecoversFailedAndPendingResourceSameIdentity` 与 `TestPromoteReadyDoesNotDebitOrdinaryUploadPending`。交由原结算 worker 核对真实生命周期与升级语义，不能删除断言或以局部绿灯掩盖失败。
- 尚未集成：生成生产编排与 analytics 全局表退场；素材 canonical UI 完整历史/回收站/分页；画板与文件夹并发草稿和回执；专用任务前端身份/生命周期。原合同范围不变，未新增付费调用或发布。

### 生成领域、素材读取与项目登记集成

- `0276452` 后补齐共享本地分流的两项旧源码断言，`ea97e4a` 对应标准前端全套退出 0：2832 pass / 0 fail / 14 skip。该快照不含后续素材页及专用任务前端。READY 修复集成 race：asset 6.388s / repository 3.764s；lint 通过。
- 素材读取四个提交合入 `74bf9e6` / `a37aac8` / `ec783c3` / `de38dc5`，保留 SQLite 筛选后分页、完整生成历史、全部回收站、分类计数与独立 canonical 页数。`4dc03ca` 对齐新消息端口及已升级的草稿 hydrate 夹具，64 项前端专项和 typecheck 通过；asset/repository/CLI race 通过，operations 修补编译后完整 race 64.782s。
- 清空回收站并发继续修补 `20261002-070544-continue-ac5f2840`：失败不得 ack 后来的删除意图，已恢复为 active 的素材不能被旧 archived 列表永久删除。素材页/选择器新增的累计历史与账号 epoch 隔离由 `20261002-070844-delegate-1b721c4c` 修补，不能用数据层检查代替页面状态归属。
- `ebc6673` 将两项上传恢复夹具改为生产崩溃时真实持有的预留见证，保留日额不增加断言。但 Lead 对照正式 `bcc3b05` 发现旧版确有匿名预留后 PENDING 的升级遗留，因此 `20261002-071052-continue-96f72a0f` 继续补真实旧结构迁移；未接受重复计入额度作为默认代价。
- `b032d30` 将实际付费生成编排移入 generation.Execute，删除进程级 provider 服务表与退休 Agent 空钩子。缺图片恢复所有者在网络前失败；worker 与恢复路径保留 taskId:inline 入库身份。Lead generation 完整 race 4.249s / app 相关入口及结算夹具 race 35.554s 通过，独立复审 `20261002-071014-continue-bcf34d22` 进行中。
- `6fb2a7a` 将项目成功任务登记编排移入 project，app 只做解密；删除无调用方的无身份 ProjectWorkflows 旁路。领域 race 正在验证。
- `27546fd` 接入剪辑、转写、深度任务的提交/观察 scope 与 clientOperationId。`20261002-071232-continue-f52f7cbf` 继续补资源缓存 expectedScope、深度恢复、persistMediaNodes 内部每次等待后的归属断言及改变输入后的重试身份，当前仅阶段集成。
- 剩余 app 编排独立审查 `20261002-070109-continue-1fe4af26` 在指定范围给出 ACCEPT，区分合法组合/投影/恢复扫描与业务规则，不按行数强行搬迁。最终全量与完整架构审查仍未完成。无新增付费调用、push、发布或正式应用替换。

### 并发草稿与集成回归收口

- `3609177` 对应标准前端全套 2879 pass / 0 fail / 14 skip；修补新转写入口的浏览器夹具后，实际时间线 UI 5 pass / 26 expect。该快照早于后续画板、文件夹修改。
- 画板/文件夹草稿及代际回执合入 `8227edf` / `867b67d` / `345e98a`；Lead `ad27320` 将备份读写、清理绑定原 scope，并拒绝把草稿当成 canonical 导入结果。专项 32 pass / 137 expect；备份专项 34 pass / 165 expect；真实隔离 Go/SQLite 重启 2 pass / 54 expect；typecheck 通过。
- 后续实际 Chrome 启动回归失败：自动创建画布只出现 GET，没有预期 PUT 503，界面已出现本地项目。保留失败证据，由 `20261002-072714-delegate-9c891a5e` 调查；未放宽等待时间或跳过失败路径。绘图代际 blob 回收仍在审查，未合并有旧预览读取回退风险的 `5257e1e`。
- `04654ea` 清空回收站在同一删除事务检查 archived 状态；失败只确认本次草稿版本，保留后来的删除/更新意图。前端 13 pass / 484 expect，asset/canvas/repository race 7.176s / 7.316s / 4.131s。
- 全量 Go `de29e89` 失败于三组 HTTP 请求证据回归。`608c2c1` 显式恢复诊断端口，Lead `132e165` 去掉从其他端口反查 Service 的隐式计费权限恢复；真实 HTTP 回归包含控制面请求只记录诊断，专项 race 2.186s 通过。最终全量仍待重跑。
- 独立生成复审发现两项待修：系统 SKU 被二次解析，及退休 AgentRequests 与普通文字发布共用出口。`20261002-072939-continue-cc4b226c` 修复；此前专项绿灯不关闭这两项。项目登记领域 race 5.492s 通过。
- 旧版匿名额度不能按当日总量猜测资源是否已付费，`d9bc8dd` 未被接受；`20261002-072815-continue-3820770b` 按身份见证与不可归属遗留分别处理。素材视图/选择器和专用执行器迟到回调继续修补，未冻结发布候选。

### 旧数据恢复与迟到回调集成

- `a79fbe8` 只集成修正后的旧上传迁移：pre-v13 未完成资源没有身份见证时写未归属标记，保留原数据和日额，停止自动恢复；不依据匿名日额猜测、不重复预留。`5adf3fb` 删除未经产品入口证实的“删除未完成素材”建议，文档区分仓储清理能力与用户入口。database/asset/repository race 9.078s / 8.234s / 4.236s，包含真实历史结构与多次重启。
- `09dc3b6` / `565018a` 合入绘图代际 blob 回收及 Lead 审查修补：旧版预览按键迁移、IDB 读取失败释放 in-flight、回收失败不掩盖提交错误。`6cfe1dd` 修复新增文件夹 store 触发 versionchange 导致 app_state 连接失效。绘图/文件夹/存储专项 43 pass / 181 expect，typecheck 通过；实际 Chrome 6 pass / 29 expect，自动新建确实发出 PUT 并显示 503 失败。
- 全量前端发现全库串行 IO 会阻塞独立草稿写入，`asset-store-draft-commit` 的受控慢缓存场景超时。继续 `20261002-075654-continue-214aa743` 只协调初始化/升级、恢复普通读写并行；不能移除该测试或放宽超时。全部其他同库 store 的接入 `d87430e` 等待此修正后再合并。
- `00ae495` / `3665fd4` 合入专用任务资源查询、媒体持久化内部及深度恢复的原身份传递；取消请求不再与其他观察者共享在途 IO，输入变化更换确认 ID。Lead `f605df0` 在快照视口更新前与回读前再次断言身份。专项 42 pass / 158 expect，typecheck 通过。
- `9b6147b` 修复生成复审 P1/P2：领域单次解析系统模型，普通正文与推理分离；声明式文本通过已有解析器处理 SSE。Lead app 专项 race 2.414s，通过真实 mock HTTP 检查目录 SKU 对应上游模型及只发一次请求。generation 完整 race 与全量 Go 后续单独记录。
- 全量后端 `5adf3fb` 仍运行中；独立整体架构复审 `20261002-074335-continue-f7a73044` 仍执行。当前还没有最终候选或新付费/发布回执。

### 整体复审与退场边界

- 全量 Go `5adf3fb` 退出 1，唯一失败为 taskbinding 依赖边界：`taskbinding -> task -> generation -> creation -> canvas`。`259ab62` 把共用纯素材占位解析移入 protocol，删掉无调用方的 app 包装，原边界检查保留；Lead taskbinding/generation/creation/protocol race 1.999s / 5.338s / 3.501s / 4.415s 通过。`9b6147b` generation 完整 race 3.877s 通过。
- `7f27341` / `0748229` 合入素材页与选择器入口 epoch、异步父回调身份及 3D 素材持久回执。真实 Chrome 挂载页面 2 pass / 13 expect：同页 A→B→A 清除旧内容，迟到普通网络错误不会提示或写入替换账号；相邻专项 23 pass / 151 expect，typecheck 通过。
- 独立复审 `20261002-080819-continue-2a23cfbc` 固定 `0748229`，对生成 P1/P2、旧上传标记、绘图 GC、专用任务身份和素材页五包分别 ACCEPT，无新 P1/P2。实际读取 Lead 钉选 pi 包源码，确认 `noTools=builtin` 与全控装配吻合。剩余 app 方法经调用链区分为端口、组合和互补持久化；revision-0 创建 PUT 与 generated-assets 同事务保存是有效专用操作，不再凭方法名或 Service 存在继续搬迁。
- `abeb058` / `56546bd` / `a23eef2` / `a450b0b` 删除未接线的自建 MCP、tar.gz helper、项目 Agent 工具及无前端调用的旧节点/连线 HTTP；官方 MCP SDK、产品 ZIP 与活跃画布保存保留。`44b6beb` 复用既有桌面 UI 身份校验到任务创建与专用任务创建；重试同样重新生成，继续由 `20261002-081908-continue-da38b192` 补齐。
- IDB 初始化-only 实现 `a900049` 尚未接受：不得为 Bun 测试吞掉真实缺驱动错误。`20261002-081842-continue-65ad71b0` 改测试替身并恢复生产错误传播，同时保留慢缓存与持久草稿并发、九表首次打开与浏览器回归。
- `20261002-080750-continue-3f6fad9c` 收口拖放/粘贴/章节插入的迟到回调，以及 `ensureCanvasNodeAsset.confirmed=false`、项目设置表单原身份。当前整体 verdict 仍为 REPAIR；未扩大到新 Agent 内核或替换合法专用事务。无新增付费、发布或真实数据写入。

### 最后集成回归

- `fa7b9b3` 将同一可信桌面身份规则接入重新付费的 retry；handler 重试专项 race 7.417s 通过，读取与取消保持独立。
- `b9ee1bb` / `ffc2360` / `ee3d20e` 统一九个既有 IndexedDB store 的首次初始化，普通 IO 并发；生产缺驱动或 ready 失败向上传播并允许下一次显式重试。Bun ready 替身只在测试 preload，实际 Chrome 仍运行真实 IndexedDB。Lead 慢缓存/持久草稿/初始化失败 16 pass / 77 expect；真实浏览器九表写入重开 2 pass / 22 expect。
- `7d285f4` / `fe8c168` 合入上传原 scope、未确认草稿反馈与延迟 React updater 归属检查，专项 16 pass / 57 expect。项目设置初始归档状态冻结和 StrictMode mounted 标记经 Lead 复审发现，`20261002-083037-continue-75e0bee2` 继续修补并挂载真实组件验证；早期 upload/settings harness 仅覆盖辅助逻辑集成，不当作真实设置组件回执。节点编辑器两条手动保存回调由 `20261002-082937-continue-9730423c` 补同一归属规则。
- `3233608` 对应标准前端全套退出 0：2988 pass / 0 fail / 14 skip；typecheck、lint、Web build 通过。真实原生 FFmpeg 4 pass / 77 expect，真实浏览器 Worker 8 pass / 94 expect，覆盖音轨、字幕、时长、取消与失败不交付。
- 同一集成代码的官方 pi 宿主与随包 Node 检查 83 pass / 308 expect，含真实 SDK 会话往返、宿主进程退出和空 PATH 打包启动；模型请求计数为 0。发布器 Python 14 pass。以上是本地证据，待完成的 UI 修补仍须整体验证；后端全量与独立 review 正在运行，未冻结候选、未发布。
- 后端全量 `go test -p 1 ./...` 已退出 0（后端源码 `7d285f4`，此后仅前端及文档改动）。CPU 首次复测有 50,000 节点 serialize/parse 越线；后台测试结束后同脚本复测 regressions=[]，保留两份原始结果，未改阈值、未声称 UI 性能改善。
- `9d8eb10` 设置组件集成浏览器 6 pass / 23 expect；`07f1b77` 节点编辑集成专项 33 pass / 166 expect、实际 hook 浏览器 10 pass / 39 expect。独立复审 `20261002-084522-continue-66b22372` 对两包 ACCEPT，无新增 P1/P2。
- 唯一已知代码 HOLD：剪辑器 `editor-asset-ingest.importFiles` 的 probe/upload/link/retry/refresh 仍缺入口身份与生命周期。`20261002-084205-continue-8b435c42` 单独修补，不归入已完成的节点编辑包；待合入后复跑前端整套与最终结构验收。此前全量、宿主和媒体回执不冒充最终候选。

### 本地代码验收完成，发布验收待执行

- `c7f00ec` 将剪辑器导入钉住原账号与项目，覆盖 probe/upload/link/retry/refresh。Lead 复现旧 finally 清掉新项目忙碌状态后，`dcb7c95` 使用项目 ID 和现有账号 epoch 重建导入子组件，去掉重复项目计数；真实组件 17 pass / 67 expect，保留修补前失败证据。
- `dcb7c95` 标准前端整套退出 0：3030 pass / 0 fail / 14 skip；类型检查、lint、Web 构建通过。独立复审 `20261002-085826-continue-47d46723` 关闭最后代码 HOLD，给出累计 whole LOCAL architecture ACCEPT，无新增 P1/P2。
- `611882b` 修补发布 sourceDigest 遗漏 agent-host 的问题。Node 24 隔离 Git 回归逐项修改宿主源码、锁文件与清单，确认旧真实生成回执失效；既有十二条及豁免负向检查保留。独立复审 `20261002-090233-continue-035cee33` ACCEPT，无新 P1/P2。
- 本地代码指纹为 `63f6af3ee98b9caa01921a3fd86be6a6ac1abf1b4d9213e1fc7794dcc4d7efd8`。后续实际发版 VERSION 或任何打包源码变更都须重新冻结。没有新增付费模型调用、真实数据库写入、正式应用替换、push 或发布；真实模型与跨平台发布门禁保持未完成。
