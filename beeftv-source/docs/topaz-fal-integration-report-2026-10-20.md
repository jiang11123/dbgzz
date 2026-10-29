# Topaz / fal.ai 接入 BeefTV：选型、计费与交互报告

核对日期：2026-10-20（北京时间）。范围：图片与视频超分辨率。本文为调研与实现建议，尚未实施 Topaz 接入，也未调用付费推理。

## 一、建议结论

**首版接入 5 个任务接口，前台提供少量场景预设，后台保留明确的模型版本。**

| 媒体 | 用户模式 | 推荐模型 | 接口 | 首版地位 |
| --- | --- | --- | --- | --- |
| 图片 | 保真放大 | Standard V2；高质量原图可选 High Fidelity V3，低清压缩图可选 Low Resolution V2 | `topaz/upscale/image/precision` | 默认 |
| 图片 | 细节重建 | Wonder 3.5，初始强度 low | `topaz/upscale/image/generative` | 可选增强 |
| 图片 | 保留透明背景 | Transparent | `topaz/upscale/image/transparent` | 检测 Alpha 后提供 |
| 视频 | 保真增强 | Proteus | `topaz/upscale/video/precision` | 默认 |
| 视频 | 细节重建 | Starlight Fast 2（经济）；Starlight Precise 2.6（高画质）；档案素材后续评估 Mini | `topaz/upscale/video/generative` | 可选增强 |

依据：[图片保真模型合同](https://fal.ai/models/topaz/upscale/image/precision/api)、[Wonder 模型合同](https://fal.ai/models/topaz/upscale/image/generative/api)、[视频保真模型](https://fal.ai/models/topaz/upscale/video/precision)、[Starlight 模型合同](https://fal.ai/models/topaz/upscale/video/generative/api)。上述默认值与开放顺序为 BeefTV 产品建议。

Bloom 2（图片）和 Astra 2（视频）留作第二阶段“创意增强”。它们允许更强的内容重建，适合用户主动追求纹理变化的素材；不宜成为保真工作流的默认模式。[Bloom 2](https://fal.ai/models/topaz/upscale/image/creative)、[Astra 2](https://fal.ai/models/topaz/upscale/video/creative/api)

接入形式：BeefTV 使用用户的 fal 渠道密钥提交云端任务，上传所需素材，再把结果持久化回本地资源库。无需为此管理本地 GPU 或购买 Topaz 桌面应用许可；fal API 使用费单独结算。[Topaz on fal](https://fal.ai/topaz)

## 二、480p 能放大到多少？

### 2.1 先把尺寸术语统一

- 图片：建议在 BeefTV 明确定义长边 1K=1024、2K=2048、3K=3072、4K=4096 像素，并始终显示完整宽×高。
- 视频：建议使用 720p、1080p、1440p、4K UHD 的标签。16:9 对应 1280×720、1920×1080、2560×1440、3840×2160；不把“2K”作为精确规格。
- 下表的 480p 宽屏样本取 854×480；实际视频还需处理偶数像素、像素宽高比和旋转信息。不能仅凭“480p”推断它一定是宽屏。

常规图片及视频超分接口的倍率范围为 1–4，倍率作用于宽和高。`4×` 使总像素数变成 `16×`；生成式也受对应接口合同约束。[图片 Schema](https://fal.ai/models/topaz/upscale/image/precision/api)、[视频 OpenAPI](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=topaz/upscale/video/precision)

### 2.2 按公开倍率计算的尺寸

| 源素材 | 目标 | 需要倍率 | 单次常规接口能否达到 |
| --- | --- | --- | --- |
| 854×480 | 图片长边 1024 | 约 1.20× | 能，约 1024×576 |
| 854×480 | 图片长边 2048 | 约 2.40× | 能，约 2048×1151 |
| 854×480 | 图片长边 3072 | 约 3.60× | 能，约 3072×1727 |
| 854×480 | 视频 1080p | 约 2.25× | 能，宽度约 1922，精确尺寸按比例/编码对齐 |
| 854×480 | 视频 1440p | 3× | 能，约 2562×1440 |
| 854×480 | 单次 4× 上限 | 4× | 3416×1920，约 6.56MP |
| 854×480 | 标准 4K UHD / 2160p | 约 4.50× | 超过单次常规接口上限 |
| 640×480（4:3） | 单次 4× 上限 | 4× | 2560×1920，长边达不到 3072 |
| 1280×720 | 标准 4K UHD | 3× | 能 |
| 1920×1080 | 标准 4K UHD | 2× | 能 |

**所以：宽屏 480p 单次可以输出长边 3K 左右的文件；4:3 的 480p 单次最多长边 2560。两者都不能承诺“恢复为原生 3K/4K 的真实信息”。** 尺寸表是数学换算，不是图像质量实测。

如果目标是严格 1920×1080，应让用户选择保留比例后适配、裁切或留边，不能悄悄拉伸。竖屏相同规则交换宽高。

### 2.3 两个必须单独建模的例外

1. **Transparent 固定输出 4×，始终 PNG。** 不开放可随意选择的 1×/2×控制；如需更小成品，可在 4×结果落库后增加本地下采样步骤，但费用按上游实际的 4×结果计算。[透明图接口](https://fal.ai/models/topaz/upscale/image/transparent/api)
2. **Astra 2 会对齐自身支持的输出规格，通常为 4K，可能覆盖请求倍率；费用按实际交付分辨率。** 因而它不能作为精确像素输出的默认路径。带 prompt 时还限制 450 帧，30fps 约 15 秒、60fps 约 7.5 秒，按帧数而非笼统时长校验。[Astra API](https://fal.ai/models/topaz/upscale/video/creative/api)

不建议首版自动做两次云超分去跨过 4×上限：会新增一次付费任务，并可能累计重建伪影。若以后提供，需作为显式的多步工作流展示每次费用与尺寸。

## 三、效果该怎样判断？

### 3.1 模型能力与预期

| 素材 | 推荐起点 | 预期收益 | 重点观察 |
| --- | --- | --- | --- |
| 人像、商品、建筑，身份与外形重要 | 图片保真；视频 Proteus | 更整洁的边缘、降噪和压缩修复 | 肤质蜡化、锐化光晕、商标/文字改变 |
| 小尺寸或压缩严重的照片 | Low Resolution V2；再比较 Wonder 3.5 low | 传统清理或更明显的细节重建 | 眼睛、牙齿、头发与重复纹理是否变形 |
| AI 生成的视频 | Fast 2 与 Precise 2.6 对比 | 重建纹理、改善质感 | 人脸身份、手指、衣服纹理是否随帧闪动 |
| 老视频或快速运动 | 保真基线；再评估 Starlight Mini | 提升退化素材可读性 | 运动拖影、轮廓跳动、不同镜头间风格变化 |
| Logo、字幕、透明抠图 | Text Refine / Transparent | 边缘、形状与透明度处理 | 字符是否正确、Alpha 边缘是否发黑或发白 |

官方将 Precision 定位为保留源内容的增强，将 Wonder/Starlight 定位为重建缺失细节；Topaz 文档说明 Precise 2.6 改进了时间一致性，Mini 面向老低清和快速运动。上表的风险项与选型顺序为工程判断，不是测得的模型排名。[fal 分类](https://fal.ai/topaz)、[Topaz 模型说明](https://docs.topazlabs.com/cloud-apps/astra-modes-and-models)

实际使用建议：480p 视频先以 1080p 为默认交付目标，1440p/最大 4×作为进阶选项；图片默认 2×，重建模式默认低强度。极低清小脸、严重失焦和原本不可读的文字，没有足够信息保证真实还原。

### 3.2 当前证据限度与后续验收

本报告已核对官方价格、Schema 与当前源码；未上传用户素材、未调用付费模型，因此不能给出“清晰度提高百分之多少”、处理速度或本机播放兼容性的实测结论。官网演示仅能作为候选效果，不能替代同素材对比。

接入时建议使用用户指定的 6–10 张图片、4–6 段 5–10 秒视频：包含人像、中文小字、商品、透明边缘、低光、快速运动及 AI 素材。同一目标尺寸比较本地插值、保真与重建；按 100%/200%局部和整段播放评估。看轮廓/身份保持、文字准确性、肤质、闪烁与音画同步；同时记录输出尺寸、耗时、文件大小和实际账单。预览片段也是付费请求，应展示费用后由用户运行。

## 四、计费方式与预算

以下为 2026-10-20 公开美元标价；账号折扣、后续调价及其他渠道价格另计。报价与最终账单应分开标识，人民币如展示需使用带日期的汇率。

### 4.1 图片：输出像素按块向上取整

`M = 输出宽 × 输出高 ÷ 1,000,000`（MP，百万像素）。

| 模式/模型 | 单张公开计价公式 |
| --- | --- |
| 所有 Precision 模型 | `$0.08 × ceil(M / 24)` |
| Wonder 3 / Wonder 3.5 | `$0.08 × ceil(M / 8)` |
| 其余 Generative：Wonder、Wonder 2、Recover 3、Standard MAX、Redefine、Recovery 系列 | `$0.08 × ceil(M / 4)` |
| Bloom 2 / Bloom / Bloom Realism | `$0.08 × ceil(M / 2)` |
| Transparent | 先按固定 4×算实际输出，再 `$0.08 × ceil(M / 24)` |

来源：[Precision 定价](https://fal.ai/models/topaz/upscale/image/precision)、[Generative 定价](https://fal.ai/models/topaz/upscale/image/generative)、[Creative 定价](https://fal.ai/models/topaz/upscale/image/creative)、[Transparent 定价](https://fal.ai/models/topaz/upscale/image/transparent)。

由上述公式计算：

| 单张输出 | MP | Precision | Wonder 3.5 | Bloom 2 |
| --- | ---: | ---: | ---: | ---: |
| 1920×1080 | 2.074 | $0.08 | $0.08 | $0.16 |
| 2560×1440 | 3.686 | $0.08 | $0.08 | $0.16 |
| 3072×1727 | 5.305 | $0.08 | $0.08 | $0.24 |
| 3416×1920 | 6.559 | $0.08 | $0.08 | $0.32 |
| 3840×2160 | 8.294 | $0.08 | $0.16 | $0.40 |
| 6000×4000 | 24 | $0.08 | $0.24 | $0.96 |

4K UHD 是 8.294MP，已跨过 Wonder 的 8MP 阶梯，不能按约 8MP 算 $0.08。后两行仅为输出费用示例，不代表所有 480p 输入能单次达到该尺寸。每张单独计费；批量 100 张 1080p Wonder 约 $8，不能先合并像素再取整。

### 4.2 视频：模型、输出尺寸、时长和帧率共同决定

官方列出的 **10 秒、30fps** 示例：

| 模型 | 720p | 1080p / 不高于1080p | 4K |
| --- | ---: | ---: | ---: |
| 常规 Precision（Proteus 等） | $0.10 | $0.20 | $0.60 |
| Proteus Natural（仅2×） | $0.10 | $0.20 | $0.50 |
| Gaia 2（动画、2×） | $0.10 | $0.10 | $0.30 |
| Starlight Fast 2 | — | $0.60 | $1.30 |
| Starlight Precise 2.6 / HQ / Mini / Sharp | — | $1.20 | $2.60 |
| Astra 2 | — | $3.00 | $5.00 |

来源：[视频 Precision 价格](https://fal.ai/models/topaz/upscale/video/precision)、[Starlight 价格](https://fal.ai/models/topaz/upscale/video/generative)、[Astra 2 价格](https://fal.ai/models/topaz/upscale/video/creative)。

**不能把这张表做成“每 10 秒向上取整”的通用公式。** 官方说明单次任务统一取整，并直接给出常规 Precision 的 60秒/30fps价格：720p $0.40、1080p $0.80、4K $3.10；并非把 10 秒价格乘 6。60fps 的 Starlight 10秒示例为高画质 $2.40/$5.10、Fast 2 $1.20/$2.60（1080p/4K）；Astra 为 $6/$10。1440p、3K、非标准宽高和其他时长不能硬套两个分辨率锚点得出“精确账单”。

价格服务建议：读取 [fal Pricing API](https://fal.ai/docs/platform-apis/v1/models/pricing) 的账号单位价格，按经过核对的模型计量规则计算单位数；[Estimate API](https://fal.ai/docs/platform-apis/v1/models/pricing/estimate)接受历史调用量或单位数，不能直接替我们从任意视频 JSON 得到精确价格。未核实计量规则时展示保守估算及依据，或明确“费用暂无法准确估算”，不要伪造报价。记录提交时的价格快照，完成后用可取得的账单数据对账。

### 4.3 控费规则

- 默认保持原帧率；超分与补帧分成两个开关。避免用户选“更清晰”时同时被升到 60fps。
- 提交前展示：素材范围、真实输出宽高、时长、fps、模型、估价和价格核对时间；批量任务展示总额。
- 提供 3–5秒片段试跑；取连续视频片段，不能只用单帧效果推断整段稳定性。试跑费用单独展示。
- 本地预算阈值可以阻止提交，但不能宣称它能限制已经交给上游的最终收费；自动替换更贵模型或自动拆分请求均不启用。
- 失败不等于必然免费：fal 说明服务端 500+ 错误不收费，部分在 GPU 执行后才发现的 422 错误仍可能收费。取消也不承诺退款。超时后先查询原 request_id，不自动重新推理。[fal FAQ](https://fal.ai/docs/documentation/model-apis/faq)

## 五、结合 BeefTV 的接入方式

### 5.1 当前源码事实

本地基线 `9bb7b7f`，安装版版本读数 v1.7.27；当前 checkout 含多个任务的未提交改动，且本地追踪信息显示落后 origin/main 91 个提交。本文只按当前源码分析；进入实现前应先处理基线同步及修改归属，本文不执行拉取、合并或清理。

| 位置 | 现状 | 对接入的影响 |
| --- | --- | --- |
| `web/src/components/canvas/canvas-node-upscale-dialog.tsx` | 名称为“调整尺寸”，文案明确为插值；读取源图尺寸 | 保留本地工具，新增单独的 AI 超分入口 |
| `web/src/lib/canvas/canvas-image-data.ts` | `upscaleDataUrl` 调用 Canvas 插值 | 不能作为 Topaz 的执行器 |
| `plugin-packages/fal-queue-image/manifest.json`、`fal-queue-video/manifest.json` | 默认 Bearer；请求有外层 `input/model/version`；图片读 `response.images`；查询为手工 `statusPath` | 与此次 Topaz 原生合同有差异，需专用 profile/适配 |
| `backend/internal/generation/protocol.go` | 默认 bearer 前缀为 `Bearer `，同时支持自定义前缀/header | 可声明 `Authorization: Key ...`，不必在通用层按域名打补丁 |
| `backend/internal/task/canvas_media.go`、`canvasworkflow/media_operations.go` | 已有素材归属校验、任务队列和本地媒体处理；`image.resize` 是插值操作 | 复用任务/资源/工作流设施，新增云端语义操作 |

这里只是静态源码发现，未用真实密钥验证现有 fal 插件。已有用户自定义配置可能不同；不应直接改写全部 fal 插件并影响其他模型。

### 5.2 接入合同

1. 一个 fal 渠道保存密钥；五个 endpoint 配置成不同能力，模型枚举来自各自 Schema。固定具体版本，避免 API 默认值变化。
2. **endpoint ID 与内层 model 不混用**：`topaz/upscale/image/generative` 是路由；`Wonder 3.5` 是这个接口请求体的模型值。
3. 直接提交模型所需的 JSON，使用 `Authorization: Key <FAL_KEY>`。Topaz 必填的是源图片/视频，不强制用户编写提示词。
4. 接受并保存服务端返回的 `request_id/status_url/response_url/cancel_url`。状态完成后再取结果、检查错误、下载结果文件；使用返回的 URL，避免按完整 endpoint 拼错查询路径。[fal Queue](https://fal.ai/docs/documentation/model-apis/inference/queue)
5. 图片读取单个 `image.url`，视频读取 `video.url`，标准化为 BeefTV 资源；完成必须以资源落库成功为准。[图片输出合同](https://fal.ai/models/topaz/upscale/image/generative/api)、[视频输出合同](https://fal.ai/models/topaz/upscale/video/generative/api)

示意请求（未执行）：

```http
POST https://queue.fal.run/topaz/upscale/image/generative
Authorization: Key <由本地后端读取的渠道密钥>
Content-Type: application/json

{
  "image_url": "<fal 能读取的素材地址>",
  "model": "Wonder 3.5",
  "upscale_factor": 2,
  "enhancement_strength": "low",
  "face_enhancement": false,
  "output_format": "png"
}
```

```json
{
  "video_url": "<fal 能读取的视频地址>",
  "model": "Starlight Precise 2.6",
  "upscale_factor": 2,
  "H264_output": true
}
```

第二个 body 提交到 `topaz/upscale/video/generative`。不设置 `target_fps` 表达不主动补帧的意图，完成后仍探测实际帧率。`softness` 仅属于 Precise 2.6；Wonder 的低中高强度、Bloom 的 1–9 创意值不能共享同一个参数名和范围。[视频参数](https://fal.ai/models/topaz/upscale/video/generative/api)、[图片参数](https://fal.ai/models/topaz/upscale/image/generative/api)

### 5.3 执行与存储

```mermaid
flowchart LR
  A[图片或视频素材节点] --> B[Topaz 超分处理节点]
  B --> C[后端校验素材与参数并估价]
  C --> D[准备云端可读素材并提交 fal 队列]
  D --> E[保存请求回执并恢复查询]
  E --> F[下载并探测结果，写入资源库]
  F --> G[新结果节点与前后对比]
```

- 本地 `file://`、localhost、私有资源引用不能直接发给云模型。后端将本次必要文件上传 fal storage，或提供可访问的短期素材地址；界面注明“云端处理”。不向请求体或日志暴露渠道密钥。[文件输入说明](https://fal.ai/models/topaz/upscale/image/precision/api)
- 资源元数据记录来源、处理配置、模型版本、requested 与 actual 宽高/fps、request_id、价格快照；工作流中存资源引用和非敏感参数，不存 API key。
- App 重启可继续查询既有请求；上游完成但下载失败时只重试取回，不重新超分。提交结果不确定时提示“查询原任务”。
- fal 文件链接有生命周期，成品应及时下载到 BeefTV；不能把临时 CDN 链接作为长期唯一来源。[文件保留说明](https://fal.ai/docs/documentation/model-apis/faq)
- 音轨保持、字幕、色彩、方向与时间戳必须独立验证。公开超分 Schema 未给出足够的音轨保留保证：必要时保留原音轨并由本地合流，显式报告差异，不能无声丢音。

## 六、交互方案

### 6.1 画布使用

**选中图片/视频 → AI 超分 → 在相邻位置生成“Topaz 超分”处理节点 → 新结果节点。** 原素材保留，处理节点保留配置和任务记录，结果节点可继续连接生成或工作流。菜单中的现有“调整尺寸”继续表示本地插值。

首屏只放以下控件：

| 控件 | 图片 | 视频 |
| --- | --- | --- |
| 源信息 | 宽高、文件类型、Alpha | 宽高、时长、帧率、音轨 |
| 模式 | 保真 / 细节重建 / 透明图 | 保真 / 细节重建（经济或高画质） |
| 输出 | 2×、4×或自定义长边；显示实际宽高 | 1080p、1440p、最大4×或自定义；保留比例 |
| 默认保护 | 保真模式人脸增强关闭，用户可启用 | 帧率保持原样，补帧默认关闭 |
| 费用 | 单张估价与批量总价 | 全片/选段估价与帧率影响 |
| 主操作 | 开始超分 | 先试跑片段 / 处理全片 |

技术模型名展示在模式下方，便于复现；高级参数按模型条件显示。透明图固定显示 4×和 PNG。选择无法达到的目标时解释倍率上限，不静默改成更小尺寸。用户追求身份保持时不自动开启重建或面部修复。

任务状态：待上传 → 排队 → 处理中 → 下载结果 → 完成/失败。仅展示真实可得的排队位置和日志，不用假的百分比。完成后支持图片同倍率滑块/局部对比，视频同步时间点并排/切换播放。

### 6.2 工作流复用

建议新增 `image.upscale.topaz` 与 `video.upscale.topaz` 两个有版本的云处理操作；它们不归入本地 ffmpeg 的 `image.resize`。

- 图片输入口只收图片，视频输入口只收视频，均为单素材；批量在任务层展开。
- 固定：模式、模型、强度、格式、帧率策略。可替换：源素材。目标规则可选择固定2×或固定长边/短边尺寸。
- 更换源素材后重新探测、计算倍率和报价。保存“上次 output_width”不能替代保存尺寸规则，否则不同素材会错用倍率。
- 每步保留执行来源，便于封装、重跑与对账。未知/已变更模型需重新配置，不能静默切到贵模型。

## 七、图片与视频格式边界

| 类别 | fal 页面/合同 | BeefTV 首版策略 |
| --- | --- | --- |
| 图片输入 | 上传控件列出 JPG/JPEG、PNG、WebP、GIF、AVIF、HEIC、HEIF | 首版稳定验证 JPEG/PNG/WebP；其余先解码探测，必要时转成适配格式 |
| 图片输出 | 常规 JPEG/PNG；Transparent 始终 PNG | 透明资产走专用接口；保真图可选 JPEG，文字与透明边缘优先 PNG |
| 动图 | 图片控件接受 GIF，但不等于图片接口保留动画 | 动态 GIF 走视频转换流程或明确拒绝，不静默只取首帧 |
| 视频输入 | 上传控件列出 MP4、MOV、WebM、M4V、GIF | 首版优先验证 MP4/MOV；其他容器按解码结果显式转码，记录变化 |
| 视频输出 | 超分接口默认 H.265，可请求 H.264 | 首版默认 MP4/H.264，H.265作为可选；跨平台播放实测后开放 |
| 视频限制 | 各超分视频接口标注最长5分钟；target_fps参数16–60 | 首版单次不超过5分钟；更高原帧率、VFR单独验证，不强制转换 |
| 特殊素材 | 超分接口不等同 HDR/透明视频/专业母版导出接口 | HDR、Alpha视频、ProRes等不承诺保留；检测到时解释当前能力 |

格式依据：[图片输入页面](https://fal.ai/models/topaz/upscale/image/precision)、[视频输入页面](https://fal.ai/models/topaz/upscale/video/precision)、[Starlight Schema](https://fal.ai/models/topaz/upscale/video/generative/api)。上传控件列出的扩展名是接受入口，不构成对所有编码组合、动画、色彩空间的保证；文件大小限制还需按模型与上传端实际合同核验。

## 八、建议实施与验收顺序

1. **基线与合同**：确认当前多任务改动归属；记录五个 endpoint 的 Schema、枚举、价格日期、输入输出和专用 fal profile。
2. **完整覆盖图片和视频**：实现素材上传、异步提交、重启恢复、结果下载；保留、透明图、生成式均按独立合同处理。
3. **画布处理节点与报价**：统一图片/视频入口，按媒体显示参数；保留原素材，完成对比与元数据探测。
4. **工作流集成**：新增两项可复用操作，替换素材后重算规格/费用。
5. **用户素材验收**：先短样本再完整素材；检查身份/文字/时间一致性、透明度、音轨和费用，对比后再决定默认模型。

功能验收应覆盖：854×480的2×/3×/4×及非法4.5×、4:3/竖屏、透明图固定4×、8MP/24MP价格边界、超过5分钟、Astra prompt帧数限制、422/500、提交不确定、App重启恢复、下载失败恢复、原图/视频保留，以及工作流替换素材后的重新计价。

**决策建议：先交付“图片 Standard V2 + Wonder 3.5 + Transparent；视频 Proteus + Starlight Fast 2/Precise 2.6”的五接口闭环。** 对480p默认以1080p和内容保持为验收目标，最大倍率作为用户主动选择；创意增强与多次超分待同素材实测后扩展。

## 本次交付边界

报告最初交付为调研方案；用户随后授权实施、配置本地密钥并进行合计不超过 US$3 的真实推理。

## 九、实施与实测记录（2026-10-20）

- 已接入五个专用端点、本地加密渠道、图片与视频节点顶部「AI超分」、规格/图片估价面板、持久任务及原回执取回。视频估价暂显示不可预估，以 fal 账单为准。
- 安装位置 `/Applications/BeefTV.app`，版本 v1.7.27（现有 checkout 的本地修改构建）。原素材保留，结果为新的自有素材与节点。
- 图片保真 Standard V2：1024×1024 PNG → 2048×2048 PNG，实际文件约3.51MB。一次推理，界面估价US$0.08。
- 视频保真 Proteus：1280×720、约5.63秒 → 2560×1440 MP4/H.264；ffprobe实测30fps保持，AAC 44.1kHz双声道存在，音频码流SHA256与原片一致。一次推理，恢复只查询与下载原任务。
- 真实验收发现并修复下载完成顺序与画布双写版本冲突；失败可取回原结果，不重提推理。最终安装版新增一次图片保真复测，2048×2048自动落图，无版本冲突；共两次图片和一次视频推理，全部任务及结果节点成功，原任务恢复未重复推理。图片界面估价合计US$0.16；视频实际费用需以fal账单确认，未伪造精确扣费值。

当前边界：JPEG/PNG/WebP图片、MP4/MOV视频；1–4倍，透明模式固定4倍，视频最长5分钟。其他格式、HDR/高帧率、全部生成式模型的主观质量与透明边缘尚未逐一实测。报告中的工作流封装、滑动对比及更多高级参数属于后续建议，未全部纳入此次首版。

## 十、独立超分节点修订与验收

已将图片与视频统一改为独立AI超分处理节点：左侧多素材输入、下方无提示词配置面板、右侧逐素材输出。顶部功能入口创建并连接处理节点，添加菜单也可创建。支持混合批次、多节点独立设置、复用右侧空结果节点；批次冻结参数和操作ID，原任务恢复不重复推理。

安装版v1.7.27（2026-10-20 19:04本地构建）混合批次实测通过：1024²→2048² PNG；720p短片→1440p MP4，均自动落图。2倍与4倍节点配置隔离并保存；运行中修改配置未影响已提交参数。示例保存在“AI超分 · 批量处理示例”。本轮新增一图一视频推理，仍在原授权总预算范围内控制，视频最终账单未取得。保存重开与窄窗口最后复核因macOS截图服务连续报错未完成。未提交或推送，待用户本地验收。
