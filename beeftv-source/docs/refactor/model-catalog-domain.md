# 切片：模型目录 / 能力合同 / 渠道配置抽到 `modelcatalog`

把渠道模型能力归一化、校验、目录脱敏、SKU/变体合同和助手渠道选择从 `internal/app` 抽到 `backend/internal/modelcatalog`。UI、Agent 与普通生成走同一套规则。本包不得 import `internal/app`。

## 边界

- 新包：`backend/internal/modelcatalog`
- 能力类型、`CapabilitySpec`、`ModelRequestIntent`、公开渠道目录投影、渠道模型配置 DTO 以本包为权威来源；`app` 用类型别名保留既有 JSON 字段名
- 协议插件仍由插件 worker 拥有。本包只注入 `ProtocolLookup`（`LookupFromRegistry` 适配 `protocol.Registry.Resolve`，只读 ID / Enabled / UnavailableReason / Categories[0]）
- 仓储不反向 import。`ChannelModelLookup` 由 `Service.channelModelLookup` 接到 `repo.ChannelModelByKey`
- 授权仍在 Service 边界：`RequireAdmin`、登录校验、资源归属检查留在 `app`
- 未改：`protocol_plugins.go` / `protocol_registry.go` / `plugin_management.go` / `workflow_plugins.go` / `internal/plugins`；生成任务投递/恢复/生命周期；`provider.go` 出站编排与媒体水合；前端；`project` / `localapp`

## 实际算法已搬家

- 能力默认值、归一化、配置校验、`CapabilitySpecFromModelCapabilityConfig`
- 任务能力校验（图片/视频/参考素材/单档位分辨率钉死）、Seedance 2.x 官方 overlay 与像素下限
- `MatchCapability`、意图推导、SKU 选择器、变体匹配
- 公开系统渠道目录脱敏与 intent 过滤（损坏能力 JSON 读路径隔离，写路径失败关闭）
- 渠道合同、变体规格、上游键级联重命名、协议别名经 `ProtocolLookup`
- 前台产品规格覆盖校验、渠道规格投影、默认参数
- 助手渠道/协议选择（`assistant.Provider` 合同不变；BeefAPI 托管密钥由 app 注入）

`app` 只保留：HTTP/仓储/功能开关、工作流 plugin 授权桥、上游目录出站适配（SSRF、请求头、超时与状态映射）、BeefAPI 托管凭证、厂商 extras 发现端口、`TestAdminChannelModel` 真实探测、以及 attempt 生命周期里对 provider 拥有的 image/direct 端口调用。渠道 `/models` 的校验、解析、合并与 BeefAPI/WhatsToken 视频 overlay 由 `modelcatalog.LoadChannelModelCatalog` 拥有。

## 调用图（现状）

```
HTTP 目录
  handler -> Service.ModelCatalog
    FeatureFrontendModels
      开：PublicLogicalModels（Router 选路目录）
      关：repo.SystemChannels/ChannelModels -> modelcatalog.PublicSystemChannelCatalog
    互斥读模型：modelcatalog.NewCatalogResponse（始终 []，frontend/system 互斥）

渠道保存
  RequireAdmin -> NormalizeChannelModelContract(lookup)
               -> NormalizeChannelModelVariants
               -> CascadeUpstreamRename
               -> NormalizeModelCapabilityConfigForModel
               -> repo.SaveChannelModelWithVariants

任务准入
  task.Service.admit -> Catalog.Select
    工作流：app RequireWorkflowPluginForUser（cross-domain 桥）
    其余：FeatureFrontendModels + modelcatalog.SelectTaskModel
           repo.SystemChannel / ChannelModelByKey / Router.ResolveLogicalModel
    能力：工作流 app validateWorkflowProvider*；其余 ValidateConfiguredTask

助手
  Service.assistantConfig（读本地快照）
  -> modelcatalog.ResolveAssistantProvider
       ManagedCredentialLookup = BeefAPI 托管渠道查密钥（app）
  -> assistant.Provider / UnavailableError
```

生成执行仍从 `provider.go` 进入。能力校验、MatchCapability 与系统渠道 admission 已指向领域实现。`generation.ModelCapabilityConfig` 仍是生成包内的重复类型，尚未切换。

## 切片 2 实际算法已搬家

- 路由目录缓存 / TTL / 冷却 / 同代 stale fallback / 版本作废（`Router`）
- 加权选路、健康封锁、公开目录 available、admin 逻辑模型投影
- 前台模型 bundle 校验与归档守卫
- 渠道 Apply/Merge/Public/Duplicate 副本图、渠道模型 save/import/fetch missing/delete selection/initial sync
- 上游 `/models` JSON 解析与 Fetcher 端口；app 只做安全 HTTP、鉴权、BeefAPI overlay、插件扩展
- 本地桌面快照解析与 generation-mode 过滤（直接 `canvas/capability`）
- attempt 决策 / finish / switch / retry 准备；app 仍调用 `createDirectTaskAttempt`、`retryRejectedImageAttempt`、`ImageSubmission`

## 切片 3 实际算法已搬家（任务准入）

- `SelectTaskModel`：前台 logical 路由、系统渠道重建、自定义渠道放行、catalog mismatch
- `ResolveSystemChannelModelSelection`：剥离客户端凭证/`interfaceType`/`variantId`/`providerModelKey`，能力默认值、`capabilityOptions` 覆盖、MatchCapability、变体与上游键重写、`ChannelAPIFormatForProtocol`
- 分类：`TaskInputUsesWorkflowProvider`（`channelId` 在场则不能靠客户端 `interfaceType` 绕过）、`TaskInputUsesCustomChannel`（含 managed BeefAPI）、`TaskInputUsesSystemChannel`
- `HasExecutableVideoConfig`（执行分类器；app 保留同名包装）
- `ModelError` 及 `invalid_model_selection` / `model_catalog_mismatch` / `model_capability_not_supported`；app 用类型别名，HTTP `errors.As(*app.ModelError)` 与 `Reason` 不漂移
- 公开目录互斥读模型 `NewCatalogResponse`

`app` 任务 adapter 只传 typed input、repo lookup、`FeatureFrontendModels`、工作流 plugin 授权桥。禁止把 Service 旧算法再挂成 callback。

## 仍留在 app 的算法（诚实边界）

- 工作流 plugin 授权：`RequireWorkflowPluginForUser` / `validateWorkflowProvider*`
- `TestAdminChannelModel` 真实协议探测（走 `runTextTask`/`runImageTask`/`runVideoTask`/`runAudioTask`）
- `beginTaskRouteAttempt` 编排：读 attempts、查 ImageSubmission、调用 provider 拥有的 direct/image 端口、写 `UpdateTaskProviderState`
- `FetchChannelModelCatalog` 出站适配：登录校验、`resolveChannelModelsRequest` 托管凭证、`NormalizeOutboundHeaders`、`apiURL` / Gemini `/v1beta` 拼接、`ValidateOutboundURL`、`doBinary`、`providerHTTPError` → 502 文案；`ENABLE_PROVIDER_PLUGINS` 时注入 extras 端口（bailian 发现，不发 HTTP）
- 领域：`LoadChannelModelCatalog` 校验/拉取/解析、`OverlayCatalogVideoCapabilities`（官方 BeefAPI/WhatsToken 合同）、`MergeCatalogExtras`
- 渠道密钥加解密、审计日志、仓储事务、`LogAPICall`/`APICallLogs`
- `local_model_config.go` 桌面 `workspace.ProviderConfig` IO
- `provider*.go` 出站、媒体水合、image/direct attempt 创建（provider worker 拥有）；`channelAPIFormatForProtocol` 出站副本仍在 `provider.go`，admission 走领域同名函数
- `service.go` / `bootstrap/runtime.go` 未改。生产接线已在 `taskCatalogAdapter.Select`：Catalog.Select → `modelcatalog.SelectTaskModel`

## 剩余 provider / transport 边界

- `provider.go` 仍拥有 `canvasGenerationInput` / `providerConfig` / `providerMedia`、出站 HTTP、媒体水合、`withSystemPrompt`。领域校验经 `taskInputFromCanvas` 显式拷贝字段；Grok 图片提示词字节由适配器先算 `ComposedPromptBytes`
- `normalizeVideoResolution` 的权威实现在领域；`provider_video.go` 出站仍走 app 包装
- 生成包能力类型去重并改为 import `modelcatalog` 由 provider worker 做
- 未猜测新的上游限制，未改 pi 版本

## 验证

插件包缺失会导致 `请选择有效的模型请求协议`；这是夹具，不是本切片回归。先构建：

```bash
./plugin-packages/build-packages.sh
cd backend
go test ./internal/modelcatalog -count=1
go test ./internal/app -count=1 -timeout 180s \
  -run 'TestRouteCatalog|TestNormalizeChannelModel|TestSaveAdminChannelModel|TestSanitizeChannelModel|TestChannelModelMatchesIntent|TestMatchCapability|TestCapabilitySpec|TestValidateTaskCapability|TestValidateVideoTask|TestValidateImageTask|TestSKUSelector|TestModelRequestIntent|TestDuplicateSystem|TestFetchAdminChannelModels|TestImportAdminChannelModels|TestDeleteAdminChannelModels|TestChannelFromRequest|TestChannelPresentation|TestImageSubmissionPermanentErrorsDoNotFallBackToAnotherRoute|TestPaymentRequiredIsSafeRouteRejection'
```

切片 1 实测：`go test ./internal/modelcatalog -count=1` 通过；构建协议包后 105 个既有 model/capability/channel/assistant 测试通过。

切片 2 实测：`go test ./internal/modelcatalog -count=1` 通过；构建协议包后 app 路由风暴/选路/渠道 CRUD/导入合并/级联重命名/能力/图片永久错误不换路 通过。`go list -deps ./internal/modelcatalog` 不含 `internal/app`。零付费上游调用，无真实 App/DB/GUI。

切片 3 准入实测：

```bash
cd backend
go test ./internal/modelcatalog -count=1
go test ./internal/app -count=1 -timeout 180s \
  -run 'TestTaskInputUsesWorkflowProvider|TestResolveTaskModelSelection|TestResolveSystemChannelModelSelection|TestImageResolutionPricingOnSystemChannel|TestRenamedUpstreamKeyReachesSystemChannelRequests|TestCreateTaskDoesNotClassifyCustomChannelAsMissingSystemModel|TestCreateTaskPersistsAuthoritativeSystemChannelSelection|TestCreateTaskReplaysSameClientOperation|TestCreateTaskRejectsCrossTypeRetry'
```

## 未做

- 生成包能力类型去重并改为 import `modelcatalog`（provider worker）
- `provider.go` 出站与媒体编排；`createDirectTaskAttempt` / `retryRejectedImageAttempt`
- 上游目录出站 HTTP（SSRF/Header/超时）与厂商 extras 发现适配仍在 app
- 前端目录 UI
