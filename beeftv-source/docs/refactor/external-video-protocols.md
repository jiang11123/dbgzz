# 外接视频接口格式与插件选择

## 调查范围

调查核对时间为 2026-10-15，选择公开文档可查、且代表不同线协议的六个样本：WhatsToken、New API、火山方舟、fal、xAI、KIE。它们是格式样本，不是用户使用率排名；没有采集用户密钥、提示词或素材。公开文档与本地协议测试不能代替供应商真实生成验收。

## 对照结果

| 服务或协议样本 | 创建与请求体 | 素材与关键字段 | 查询及结果 | BeefTV 对应项 |
| --- | --- | --- | --- | --- |
| [New API 的 Sora 格式](https://docs.newapi.pro/zh/docs/api/ai-model/videos/sora/createvideo) | `/v1/videos`，multipart | Sora 文件上传 profile；不同 New API 部署可扩展字段，须逐字段核对 | `/v1/videos/{id}`；状态对象 | `newapi` / OpenAI Videos；最多一张输入图，不作为所有视频模型的默认值 |
| [WhatsToken 兼容视频](https://www.whatstoken.ai/docs/openai/doc0007)、[Seedance 示例](https://www.whatstoken.ai/docs/examples/doc0047) | `/v1/video/generations`，JSON | `images` 对象数组含 `url/role`；`videos/audios`；整数 `duration`、`ratio` | `/v1/video/generations/{id}`；`data[].url` | `video-generations-json`，明确选择 |
| [火山方舟原生视频](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh) | `/api/v3/contents/generations/tasks`，JSON | `content[]` 含素材类型与 role；`duration/ratio` | 同路径加任务 ID；`content.video_url` | 已有 `volcengine-ark-video`；兼容服务必须明确支持该原生路径 |
| [fal queue](https://fal.ai/docs/documentation/model-apis/inference/queue) | `queue.fal.run/{model}`，JSON；Key 鉴权 | 素材字段由模型 schema 决定 | `status_url`、`response_url` 分开；`COMPLETED` 后取结果，仍检查 error | 已有 `fal-queue-video` 等模型插件，不能套 OpenAI Videos |
| [xAI 视频](https://docs.x.ai/developers/model-capabilities/video/generation) | `/v1/videos/generations`，JSON | 模型对应的 image/video 输入 | request ID 后查询 | 已有 `xai-video`；此处只核对协议家族，不声明覆盖其所有新模型能力 |
| [KIE Market](https://docs.kie.ai/market/common/get-task-detail) | `/api/v1/jobs/createTask`，JSON，`model/input` | 每个模型独立 input schema | `/api/v1/jobs/recordInfo?taskId=...`；HTTP 200 仍查业务 code；`resultJson` 是 JSON 字符串 | 当前没有完整相同的通用 profile；记录为后续明确需求，不自动选其他插件 |

另有已发布的 `newapi-channel-2`：同样使用 `/v1/video/generations`，但字段是 `seconds/aspect_ratio/image_urls/video_urls/audio_urls`。它与 WhatsToken 文档的 `duration/ratio/images/videos/audios` 不同，查询结果映射也不同。不能只按路径把两者合并。`seedance-videos-compatible` 则使用 `/v1/videos` 的 JSON，再次证明路径相同也不代表格式相同。

## 采用规则

1. 地址、鉴权、字段、素材角色、查询、错误和结果格式都相同，才复用同一插件。
2. 仅字段和响应不同，使用独立声明式 profile；不在通用请求层按供应商域名打补丁。
3. 特殊上传、签名或队列生命周期使用其专用协议，有明确需求再增加支持。
4. “OpenAI 兼容”、模型名、`videos` 等宽泛目录标记不足以选择具体视频线协议。新外接视频缺少明确合同则待选择，保存前提示；用户已有明确配置不自动迁移。
5. 精确目录合同 `openai-video/openai-videos`、`video-generations-json`、`volcengine-ark-video` 仅在对应插件已启用时可选。第三方接口若不提供这些元数据，用户对照文档手动选择，不做付费探测。
6. 协议不支持的素材须在提交前失败，禁止静默遗漏，也不在失败或超时后换格式重发。

## 通用协议与自定义配置

协议插件由请求字段、鉴权、查询和结果格式决定，不限制服务商域名或模型名称。自定义渠道明确选择 `video-generations-json` 时，按该插件完整发送图片数组和用途；选择 `newapi` 时仍执行 Sora multipart 的单图合同。不再按 WhatsToken 域名或 Seedance 模型名称替用户切换协议。旧配置若实际连接的是 JSON 视频服务，需在高级模型设置中选择对应 JSON 协议；没有网络探测、持久配置迁移或失败后换格式重发。

回归从实际配置解析入口覆盖不同服务地址、自定义路径、`seedance-2.0-fast` 及其他模型：同一 JSON 协议均发送五张参考图，保持顺序与 `reference_image` 用途，并完成创建、查询和下载。另覆盖恢复已有任务、415 不重发、取消、插件缺失，以及 Sora 协议在提交前拒绝无法发送的多图。证据来自本地模拟上游，不代表客户现场或真实付费生成验收。

## 本次案例的证据限度

外接 Seedance 任务的诊断记录是 `POST /v1/videos`、HTTP 415；v1.7.23 的 `newapi` 插件发送 multipart 且只取第一张图。该行为与 WhatsToken 公开文档不匹配，属于已证实的客户端配置/适配问题。原始 415 正文没有保留，未使用客户密钥做生成；不能据此宣称已经复现供应商侧拒绝的完整原因或确认退款。插件验收覆盖本地提交、轮询、结果下载、失败不重发，不等于线上付费生成成功。
