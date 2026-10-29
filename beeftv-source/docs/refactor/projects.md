# 项目领域抽取

状态：项目聚合与生产算法（素材版本、角色、镜头、工作流步骤机、工作台只读装配）已迁入 `internal/project`。`app` 仍保留跨域任务解密、任务列表和交付补偿适配器。本文记录当前真实依赖，不是完整重构完成证明。

## 实际依赖图

```
HTTP handler
  ├─ localapp.ProjectPort.ListProjects        → internal/project.Service
  └─ app.Service 其余项目路由（兼容委托）
        └─ app.Service.projectDomain()        → internal/project.Service

internal/project.Service
  ├─ repository.Repository
  ├─ repository/project_mutate.go（同一事务内的聚合写入、归档/归属、CAS）
  ├─ model
  ├─ kernel
  ├─ prompts.ValidateStyleProfileJSON / ValidateStyleProfilePreset
  ├─ assets.FileURL（生成产物卡片的资源地址）
  └─ Workflows 端口（app.projectWorkflowHost，仅种子）
        ├─ EnsureBuiltinTemplate → 领域 EnsureBuiltinTemplate
        └─ PrepareDefault → 领域 PrepareDefaultWorkflow（只准备记录）

internal/localapp.ProjectPort
  └─ []project.Summary（不再引用 app 类型）

bootstrap.Open
  └─ svc.ProjectService() 作为 localapp.Projects
     LocalKernel 不再转发 ListProjects
```

禁止方向：`internal/project` 与 `internal/localapp` 不得 import `internal/app`，包括经类型传递的间接依赖。

## 领域已拥有的行为

- 项目列表/分页摘要，列表入口拒绝缺少 ID 或 `revision < 1` 的记录
- 创建项目：项目行、默认工作流实例/步骤、revision bump 在同一事务；`PrepareDefault` 失败则不落项目行
- 更新项目：按读取到的 revision 做内部 CAS；冲突返回 409。请求 JSON 仍无 `expectedRevision`（前端当前不传）
- 删除项目：进行中任务拒绝；画布脱离项目并改写 payload；项目侧生产行删除；账号素材库与画布任务保留
- 文件夹：父夹必须是当前用户已有记录，空 parentId 为根；搬家时原子递增 revision
- 复制项目：新身份、名称加「副本」、revision 归 1，章节正文与父子关系一并复制
- 章节创建/导入/排序/删除/更新与 revision 同一事务；覆盖写走 CAS
- 画布-章节关联：列 `project_id`、payload `projectId`、unit link、双方项目 revision 同一事务；未知 payload 字段保留。旧项目只在同用户且未归档时 bump；已有 link 回填原 ID，不返回新编造 ID
- 解除章节关联、解除项目关系；解除项目关系时删除 payload 中的 `projectId`，保留其余未知字段
- 归档项目不能再改生产数据，也不能作为生成任务的业务项目；更新项目本身仍可解档
- 素材链接/解除/分类/目录、版本、候选确认；角色卡与声音绑定；镜头创建/整章替换/修订/引用；工作流步骤机与任务产物登记
- 生成产物身份：`sha256(namespace:taskID)` 截断 16 字节，登记幂等
- 工作台 core/overview/unit summaries/canvas page，以及 typed `Inspect` / `ProjectUnitWorkspace` / 素材与候选分页
- 测试/遗留 `Service{repo}` 构造不再懒写入共享 `projects` 字段；缺字段时每次返回无状态实例

## 写入原子性

窄仓储 `repository/project_mutate.go` 持有事务。领域写入先 `Active()` 早失败，事务内再 `requireActiveProjectTx`（`id AND user_id` 且未归档）。覆盖写使用读到的 revision / `primary_version_id` / `current_revision_id` / `expectedShotIds`+镜头版本指针+项目 revision 做 CAS；空指针仍参与 CAS。追加写使用 `revision + 1`。素材文件夹父夹、镜头所属章节、引用资产版本在事务内再查一次。

| 写入 | 同一事务内 | 失败后 |
| --- | --- | --- |
| 创建项目 + 默认工作流 | 项目行、workflow instance/steps、revision+1 | 项目与实例都不留 |
| 章节/素材/角色/镜头/候选 | 生产行 + 归属归档校验 + 项目 revision | 不留半写入 |
| 关联画布章节 | canvas 列与 payload、link、本项目 revision；旧项目仅同用户未归档才 bump | 列/payload/link 一致回滚 |
| 更新项目/章节/素材分类/文件夹 | 归属 + `revision = expected` 的 CAS | 另一方完整保留 |
| 角色新版本 | `primary_version_id = expected` 的 CAS（空指针也参与，含 NULL/空字符串） | 旧主版本完整保留 |
| 镜头修订 | `current_revision_id = expected` 的 CAS（空指针也参与，含 NULL/空字符串）；事务内再确认章节仍在 | 旧当前版本完整保留 |
| 整章替换分镜 | 事务内章节仍在、引用版本仍属本项目；必须带上批准快照的 `expectedRevision`（缺省或非正数直接拒绝，不用当场读到的 revision 顶上）。`expectedShotIds` 与进入方法时的镜头 `current_revision_id` 快照一致，并以该 `expectedRevision` CAS 提交。省略 `expectedShotIds` 时用当时的服务端镜头集合。章节分镜生成把批准时的 revision/shot IDs 写入任务 input metadata（现有自由字段，不改 ClientContext/schema/journal）；刷新恢复必须用该快照，缺快照的旧任务不得自动写入 | 原分镜完整保留；缺版本 400，冲突可刷新；旧任务结果仍保留，需对照当前章节明确确认 |
| 工作流步骤完成 | 预检通过后事务内重读步骤/实例/下一跳、章节正文、候选、镜头与产物；完成门槛按该快照再判一次，实例 revision CAS，项目 revision CAS | 门槛数据被改过则不完成；冲突可刷新 |
| 工作流产物登记 | 事务内重读步骤/实例/镜头；同任务已有 link 则不回放步骤、不抬实例 revision。新任务按当前状态派生。产物仅当 `revision_id` 等于镜头当前版本才 selected，完成门槛同样比较当前版本 | 同任务重试不改工作流；失败则 link/产物一并回滚 |

内置工作流模板仍由 `EnsureBuiltinTemplate` 在项目事务外幂等写入（全局共享）。无新 schema version。

## 仍留在 app 的适配器

这些不是领域缺口的伪装完成。跨域任务、密钥解密和交付补偿仍在 `app`；Lead 接入 taskdelivery 前，读路径仍调用它们以保持现网行为。

| 残余 | 位置 | 仍在 app 的原因 |
| --- | --- | --- |
| `decryptTaskInputJSON` | `app/secret_store.go` | 任务输入加密属于密钥/任务域 |
| `TasksWithOptions` | `app` 任务列表 | 工作台卡片要拼近期任务，领域读端口不持有 TaskSummary |
| `RegisterTaskOutputFromTask` | `project/workflow_task_output.go` | 领域解析任务元数据与 result 资源 ID，再执行 `EnsureGeneratedProjectAsset` + `RegisterTaskOutput`；app 只保留任务输入解密包装 |
| `finalizeCharacterTurnaroundTask` | `app/project_character.go` | 解密任务并解析图片资源后调领域 `BindCharacterTurnaround` |
| `reconcileCharacterTurnaroundTasks` | `app/project_character.go` | **REMOVE**：Lead 接入 taskdelivery 后删除。当前 `ProjectDetail`/`ProjectCore` 仍调用，避免刷新丢三视图 |
| `ProjectDetail` 读补偿 | `app/project.go` | **REMOVE**：成功任务 `RegisterTaskOutputFromTask` 不应属于正常读所有权；交付 worker 才拥有生成产物恢复 |
| `ProjectWorkflows(projectID)` | 已移除 | 无 userID 的旧签名没有调用方；`ProjectDetail` 统一走领域 `ProjectWorkflows(userID, projectID)` |

`Workflows` 端口保持最小：只准备默认实例记录。步骤机、产物登记、章节工作流创建已在领域。`app` 方法名继续转发，HTTP JSON 不变。handler 在组合根迁完前仍可调用 `app.Service`。

不得把本切片写成完整重构完成：任务、资源、画布桥、插件、模型目录和前端仍不在本工作树。
