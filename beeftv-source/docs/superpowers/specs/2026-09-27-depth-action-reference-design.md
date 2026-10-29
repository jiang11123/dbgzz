# BeefTV 深度动作捕捉设计

## 1. 目标与产品边界

在视频节点顶部的“视频处理”菜单中增加“深度动作捕捉”。用户点击后无需配置参数，BeefTV 自动准备可选的本地 Depth Runtime 与 Video Depth Anything Small 权重，执行固定标准参数的深度视频推理，并在画布上创建可直接播放的结果视频节点。

产品文案沿用用户指定的“深度动作捕捉”，但技术实现输出的是时间连续的单目相对深度视频，不输出骨骼、关节坐标、BVH、FBX 或 SMPL 数据。功能说明应称其为“将普通视频转换为近白远黑的深度动作参考视频”，避免让用户误解为 3D 骨骼捕捉。

本期成功标准：

- 视频节点的“视频处理”菜单依次包含“视频剪辑”“画面裁切”“深度动作捕捉”。
- 点击后立即创建与源视频关联的结果占位节点，不显示参数弹窗。
- 首次使用时持续显示 Runtime 和模型的下载阶段、百分比、已下载大小与总大小。
- 下载完成后自动推理、编码、校验并把结果写入 BeefTV 资源体系。
- 成功后占位节点直接变成可播放的视频节点；失败后保留节点并显示原因和“重新生成”。
- 第二次使用命中已校验缓存，不重复下载。

## 2. 固定处理合同

第一版仅支持 `darwin-arm64`，使用 Video Depth Anything Small 和 Apple MPS。不提供 CPU 静默降级；不支持的平台或没有可用 MPS 时返回明确的不可用原因。

输入合同：

- 输入来自当前用户有权访问的 BeefTV 视频资源，不重复上传。
- 支持现有 FFmpeg 能探测和解码的 MP4、MOV、WebM。
- 最大时长 15 秒；允许一个输入帧时长的探测误差，超过时提示用户先使用视频剪辑。
- 推理前统一处理旋转信息、像素格式和可变帧率；最高处理 30 fps，第一版保留不高于 30 fps 的源帧率。

固定参数：

- `device=mps`
- `input_size=280`
- `max_resolution=960`
- 全段 P2/P98 归一化
- `gamma=1.25`
- 近处白、远处黑
- 输出 H.264、`yuv420p`、CRF 18、`+faststart`、无音频
- 输出时长与输入误差小于一帧
- 不生成或保留原始 NPZ

## 3. 用户交互

入口位于视频节点顶部工具栏现有“视频处理”下拉菜单，作为第三项“深度动作捕捉”。入口只对拥有可读取视频资源的普通视频节点显示；处理中节点、缺失资源节点和非视频节点不显示或禁用，并给出可理解原因。

用户点击后：

1. 在源节点右侧创建结果占位节点，并建立源到结果的关系。
2. 占位节点记录源节点 ID、源资源 ID、任务 ID 和操作类型 `depth_capture`。
3. 节点内显示当前阶段、进度条、细节文案和取消按钮。
4. 任务成功后更新节点的视频资源、时长和预览信息，保留来源元数据。
5. 任务失败或应用重启后可从任务 ID 恢复状态；失败节点提供“重新生成”。

面向用户的阶段文案包括：

- 检查深度处理组件
- 下载深度处理组件 `已下载 / 总大小（百分比）`
- 下载 Small 模型 `已下载 / 总大小（百分比）`
- 校验组件或模型
- 加载深度模型
- 分析视频 `当前帧 / 总帧`
- 生成结果视频
- 保存到素材库
- 已完成

不提供质量、输出方向、原始深度数据或其他高级参数。

## 4. 系统架构

### 4.1 前端

前端复用画布工具注册表、任务查询/订阅、资源上传后的节点写回和现有节点状态展示能力。前端不直接下载 Runtime/权重，不直接启动 Python，也不持有本地文件路径。

新增职责：

- 注册 `depthCapture` 视频处理工具。
- 调用后端创建深度任务。
- 创建并持久化结果占位节点。
- 将任务 `stage`、`progress` 和下载详情映射为节点文案。
- 成功后消费后端返回的资源并更新节点；失败、取消和重试保持幂等。

### 4.2 Go 后端

Go 是下载、缓存和执行的控制面，复用现有任务队列与资源体系。新增任务类型 `depth_capture` 和专用创建接口：

```text
POST /api/depth-captures
```

请求只包含 `projectId`、`resourceId` 和必要的客户端上下文。后端校验用户、项目和资源归属，拒绝外部路径和未就绪资源。

Go 负责：

- Runtime/model manifest 获取、签名验证和兼容性判断。
- 磁盘空间预检、断点续传、下载源回退、进度持久化和 SHA-256 校验。
- Runtime 自检、Worker 启动、标准参数注入、日志采集和进程组取消。
- 输入探测、输出视频验证、资源注册和任务结果持久化。
- 应用重启后的下载恢复，以及推理中断任务的明确失败收敛。

### 4.3 Python Worker

Python Worker 是能力包内的无状态执行器，不提供 HTTP 服务，也不下载源码、Runtime 或权重。Go 以短生命周期子进程启动它，输入为受控 JSON 请求文件，标准输出为 JSON Lines 事件。

事件至少包括：

```json
{"event":"progress","stage":"inferring","progress":42,"currentFrame":186,"totalFrames":442}
{"event":"output","previewPath":"/approved/task/output/depth-preview.mp4"}
{"event":"completed"}
{"event":"error","code":"depth_out_of_memory","message":"深度处理内存不足"}
```

Worker 只能读取任务指定的输入文件和 Runtime/model 目录，只能写入任务专属临时目录。所有生产路径由 Go 创建和校验。取消时 Go 终止整个 Worker 进程组，Worker/FFmpeg 不得成为孤儿进程。

## 5. Runtime 和模型分发

主应用不包含 Python、PyTorch、OpenCV、Video Depth Anything 权重或完整推理环境。

缓存目录使用 BeefTV 用户数据目录下的版本化路径：

```text
runtimes/depth/<runtime-version>/darwin-arm64/
models/video-depth-anything-small/<model-version>/
downloads/
```

Runtime 包包含：

- 独立 Python Runtime
- 固定版本的 PyTorch/TorchVision、OpenCV、NumPy 和必要依赖
- 固定 commit 的最小 Video Depth Anything 源码
- BeefTV Depth Worker
- LICENSE、NOTICE 和版本元数据

模型缓存包含 Small 权重和模型 manifest。Small 权重固定为已批准的 SHA-256；备用源只允许下载该权重，不允许运行远端源码。

## 6. 下载可靠性

### 6.1 Manifest

BeefTV GitHub Release 发布一个签名的 Depth manifest，字段至少包括：

- schema version
- Runtime/model 版本
- 支持平台
- 主源 URL
- 备用源 URL（模型为 Hugging Face 官方地址）
- 文件大小
- SHA-256
- 解压后大小
- 最低 BeefTV 版本
- Runtime 与模型兼容范围
- 签名与签名算法标识

应用内置公钥并验证 manifest；验证失败时不得下载或执行。

### 6.2 下载和回退

- Runtime 主源为 BeefTV GitHub Release。第一版 Runtime 没有未审核的第三方备用源；主源失败时明确提示重试。
- Small 权重主源为 BeefTV GitHub Release，备用源为 Hugging Face 官方固定地址。
- 下载使用 `.download` 临时文件和 HTTP Range 断点续传。
- 每个文件最多进行有限次带退避重试；主源确认失败后才切换备用源。
- Range 不被服务器接受时安全地从头下载，不拼接不兼容响应。
- 下载进度写入任务 `stage/progress`，并附带已下载字节和总字节的结构化详情。
- 用户取消下载时保留可续传的 `.download` 文件；校验失败的文件改名为 `.corrupt`。
- 校验成功后原子移动到正式缓存；解压到临时版本目录，自检通过后原子切换活动版本。
- 预检包含磁盘空间，预算应覆盖压缩包、解压目录、模型和任务临时输出同时存在的峰值。

### 6.3 缓存与更新

- 已校验缓存通过本地 manifest、文件大小和 SHA-256 判断，不因 BeefTV 应用升级自动删除。
- 新 Runtime 先并行安装到新版本目录，自检成功后切换；失败继续使用当前兼容版本。
- 第一版设置页提供查看占用空间、修复组件和删除深度组件。
- 删除只针对解析后的 Depth Runtime/model 精确目录，不影响项目视频、任务结果或其他模型。

## 7. 任务生命周期与数据

任务主状态复用：

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
```

细分阶段：

```text
checking_runtime
downloading_runtime
validating_runtime
downloading_model
validating_model
probing
loading_model
inferring
normalizing
encoding
validating_output
saving_resource
completed
```

任务输入保存源 `resourceId`、项目 ID、客户端节点上下文和固定处理配置版本，不保存用户机器绝对路径。任务结果保存输出资源 ID、预览 URL、模型/runtime 版本、设备、帧数、fps、时长和处理耗时。

下载任务可在应用重启后恢复；推理/编码任务若随应用退出中断，则在启动恢复时标记为可重试失败，不能假装继续。相同任务 ID 的资源写回必须幂等，避免重连或重复消费产生多个节点或资源。

## 8. 错误、安全与隐私

至少定义以下稳定错误码：

- `depth_platform_unsupported`
- `depth_mps_unavailable`
- `depth_video_too_long`
- `depth_input_invalid`
- `depth_disk_insufficient`
- `depth_manifest_invalid`
- `depth_download_failed`
- `depth_checksum_mismatch`
- `depth_runtime_invalid`
- `depth_model_load_failed`
- `depth_out_of_memory`
- `depth_worker_crashed`
- `depth_encoding_failed`
- `depth_output_invalid`

用户错误文案包含可执行建议，但日志不得记录用户视频内容、密钥或可对外暴露的完整本地路径。下载 URL 必须来自已签名 manifest；重定向后的主机需要受允许列表约束。解压需要防止路径穿越、符号链接逃逸、压缩炸弹和异常文件数量。

模型仅使用 Video Depth Anything Small。能力包保留 Apache-2.0 LICENSE、固定源码 commit、权重来源和第三方声明。Large/CC-BY-NC 权重不进入产品分发链。

## 9. 测试与验收

### 自动测试

- 前端：菜单可见性、点击创建任务和占位节点、下载进度文案、取消、失败、重试、成功资源写回及重复事件幂等。
- Go 下载器：签名错误、磁盘不足、Range 续传、服务器忽略 Range、主源失败切备用源、哈希错误、原子安装、并发请求只下载一次、取消后保留临时文件。
- Go 任务：资源归属、15 秒限制、固定参数、Worker JSONL 解析、进程组取消、重启收敛、输出验证、资源写回幂等。
- Python：输入探测、固定参数、全段归一化、近白远黑、标准 JSONL 进度、取消/异常协议和输出时长。
- 安全：恶意 manifest URL、ZIP path traversal、符号链接、超大解压预算和损坏权重。

### 构建与回归

- 前端完整测试与 `bun run build`。
- 后端 `go test ./...`。
- Depth Worker 单元测试和真实样片测试。
- Release 构建体积检查，确认主安装包没有包含 Runtime 或模型权重。

### Apple Silicon 真实验收

使用 5–15 秒、包含人物移动和遮挡的真实视频：

1. 在无缓存环境点击“深度动作捕捉”。
2. 确认 Runtime/model 下载进度持续可见且数值增长。
3. 确认产物为 H.264/yuv420p、无音频、帧率正确、时长误差小于一帧。
4. 确认近处更亮、远处更暗，动作和背景深度在时间上连续。
5. 确认新节点直接播放，并能在任务中心查看完整阶段。
6. 再次处理同一或另一视频，确认命中缓存且不发起 Runtime/model 下载。
7. 分别模拟断网、取消、磁盘不足和损坏权重，确认任务不会注册半成品且能够恢复或重试。

## 10. 非目标

本期不实现：

- 骨骼、关键点、SMPL、BVH、FBX 或动作重定向。
- Base/Large/metric depth 模型。
- 用户可调质量、gamma、方向、分辨率或原始深度导出。
- Intel Mac、Windows、Linux 或无 MPS 的 CPU 推理。
- 通用第三方插件执行任意 Python。
- 云端深度推理。

