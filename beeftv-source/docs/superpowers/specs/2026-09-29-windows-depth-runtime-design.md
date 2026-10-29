# Windows 深度动作捕捉：CUDA 优先、CPU 兜底

## 目标与范围

在保留现有 macOS Apple Silicon 深度动作捕捉行为的同时，让 Windows x64 用户使用同一入口生成单目相对深度参考视频。Windows 设备优先使用经实测可用的 NVIDIA CUDA；没有可用 CUDA、或 CUDA 初始化失败时使用 CPU。CPU 运行前提示可能耗时较长，但不因缺少 NVIDIA 显卡隐藏入口。性能优化和 AMD/Intel GPU 加速不在本期范围。

本设计扩展 [现有深度动作捕捉设计](2026-09-27-depth-action-reference-design.md)，仅覆盖平台能力、运行包、设备选择、回退和 Windows 验收。原有 15 秒上限、模型 Small、近白远黑语义、输出格式、节点及任务生命周期保持不变；如性能验证需要降低 CPU 推理尺寸，必须作为明确版本化的 CPU 配置并验证输出可用，不得静默丢帧或更改视频时长。

## 现状与必须解决的障碍

- `backend/internal/app/task_depth_worker.go` 仅允许 `darwin/arm64`，并固定向 Worker 传递 `--device mps`。
- `backend/internal/depthruntime/installer.go` 固定下载 `darwin-arm64` 包，固定 POSIX Python 路径。Windows `.exe`、目录布局和文件锁语义均未覆盖。
- `scripts/build-depth-runtime-darwin-arm64.sh` 只能在 Apple Silicon Mac 构建；现有 manifest 只有一个 Runtime 条目。
- Python `select_device` 接受 `cuda` 与 `cpu`，但这仅说明入口允许该字符串。上游固定版本在 CPU 上是否含 CUDA 专用注意力算子、整条视频解码/推理/编码链能否运行，尚无 Windows 实机证明。
- 现有模型推理会在内存中持有视频帧和完整深度数组。CPU 模式下必须测量长片段峰值内存，并在必要时作有界处理；不能把速度慢误判成任务卡死。
- 原设计要求签名 manifest，但当前实现只校验由远端 manifest 指定的归档哈希。公开发布 Windows 可执行 Runtime 前，应补齐发布清单的可信验证；这一点不由设备回退掩盖。

## 方案选择

采用“按平台分包、Windows 按设备选择 CUDA/CPU”的方案：Windows CPU 包是所有 Windows x64 设备的保底能力，CUDA 包只供通过能力探测的 NVIDIA 设备使用。两种包固定相同的 Video Depth Anything Small 源码 commit、权重、BeefTV Worker 协议及输出合同。权重单独共用缓存，避免双份下载。主应用不内置 Python/PyTorch。

不采用“只提供 CUDA 包”，因为它排除非 NVIDIA 用户；也不在本期引入 DirectML、ONNX 或多厂商 GPU 后端，因为这些需要独立模型算子与输出一致性验证，不能替代可工作的 CPU 保底。

## 能力探测与设备选择

Windows x64 的任务开始后，先完成输入校验，再用轻量系统探测判断是否值得准备 CUDA 包。没有 NVIDIA 驱动或设备时直接准备 CPU 包，避免下载无用的 CUDA 包；有候选设备时才下载并验证 CUDA 包，再用包内 PyTorch 检查 `torch.cuda.is_available()`、模型加载和极小输入的真实前向推理。仅凭显卡名称或驱动文件存在，不判定为可用。探测失败不应让节点停在“生成中”。

1. CUDA 探测通过：选择 Windows CUDA 包，运行任务并记录 `device=cuda`。
2. 无 CUDA 或设备初始化/模型算子探测失败：选择 Windows CPU 包，向用户明确显示“将使用 CPU，处理可能较慢”，记录 `device=cpu` 与回退原因。
3. CUDA 推理运行中若出现明确的设备故障，清理该次未完成输出后，只自动重试一次 CPU。重试沿用同一 BeefTV 任务和结果节点，阶段文案说明已切换。不得产生两个资源、两个结果节点或无限重试。
4. 输入损坏、权重校验失败、下载失败、空间不足、取消及其他非设备故障不触发 CPU 回退，而是给出原始原因和可操作建议。

CPU 提示应在实际运行 CPU 推理前可见，不能在用户等候很久后才出现。已验证的本机 CUDA 能力可按 Runtime/驱动版本缓存；检测失败、驱动变化或 Runtime 更新后重新探测。缓存不是跳过 Runtime 完整性校验的理由。

## Runtime 分发和安装

发布相互独立的 `windows-amd64-cpu` 与 `windows-amd64-cuda` Runtime，保留 `darwin-arm64` Runtime。发行清单按 `platform + variant` 标识版本、下载地址、大小、SHA-256、解压预算与模型兼容版本。客户端仅选择被内置可信签名验证通过的清单条目；下载后的文件仍验证大小与哈希，禁止执行不可信包。

CUDA ZIP 的 CI 实测体积为 3,736,173,977 字节，超过 [GitHub Release 单附件小于 2 GiB 的上限](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。构建器须将超限包切成小于 2 GiB 的有序分片；签名清单分别记录每片 URL、大小、SHA-256，以及重组后完整 ZIP 的大小、SHA-256、文件数和解压体积。客户端逐片校验、断点恢复、重组后再次校验完整哈希，然后按现有安装路径解压；CPU 与 Mac 单文件包不受影响。CI 必须验证分片尺寸/哈希，且不能将未分片的 CUDA ZIP 作为一个 Release 附件上传。

Windows 包在 Windows 构建环境中生成，包含可重定位的 Python、固定依赖、Video Depth Anything Small 固定源码、BeefTV Worker，以及可执行的 FFmpeg/ffprobe。安装器按平台和 variant 定位 Windows Python `.exe`，使用版本化独立目录、临时解压、自检后切换，并处理 Windows 文件占用和中断恢复。CPU 包不依赖 NVIDIA 驱动；CUDA 包随固定 PyTorch CUDA 构建携带其所需组件，但仍要求适配的系统驱动。首次使用的下载量、磁盘需求和进度在界面可见。

模型权重继续单独缓存并共用。运行包和权重仍遵守现有许可证、固定来源与发布声明。Windows 进程取消须终止 Python 和 FFmpeg 子进程树，清理任务专属临时文件；不得误删源视频或已完成素材。

## Worker、任务和界面边界

Go 后端负责平台/variant 选择、可信下载、进程生命周期和资源写回；Python Worker 只负责指定设备的推理与编码，不自行联网或替换模型。前端复用现有视频处理入口、占位节点和进度组件，只增加 CPU 慢速提示、回退阶段及清晰设备相关错误。Mac 路径保持 MPS，不通过 Windows 选择逻辑修改已有输出。

任务结果应持久记录最终设备、Runtime 版本、是否发生回退及处理耗时。后端给前端稳定的故障类别，避免用自由文本判断是否重试。取消优先于自动回退；用户取消后不得启动 CPU 重试。应用重启后的既有失败收敛和重复事件幂等要求保持不变。

## 实施顺序与验证门槛

1. **可行性门槛**：在真实 Windows x64 上分别用 CUDA 与 CPU 跑短视频到可播放输出。核对固定版本上游算子；如有 CUDA 专用路径，为该固定版本加入经测试的 CPU 兼容实现并验证结果。此门槛未过，不开放 Windows 入口。
2. **运行包门槛**：构建、校验、安装和自检两种 Windows 包；验证签名清单、哈希、磁盘预算、断点/失败恢复、Windows 路径与 FFmpeg。Mac 包及旧缓存仍可用。
3. **任务接入门槛**：后端接入设备探测、variant 选择、一次性设备故障回退、进程树取消和单任务资源写回；先使用模拟 Worker 单测，再做真实推理集成测试。
4. **界面门槛**：CPU 提示、下载阶段、切换原因、取消、失败和重试在现有结果节点中清楚呈现。无 NVIDIA 设备时入口仍可用。
5. **发布门槛**：在 NVIDIA Windows、AMD/Intel 或无独显 Windows 上测试；分别覆盖短片与接近 15 秒上限的片段，记录峰值内存、耗时、磁盘占用、输出帧率/时长、播放结果与取消后残留进程。测试 CUDA 初始化失败回退、运行中设备故障只重试一次、输入损坏不回退、应用重启不重复写资源。未通过则不发布 Windows 深度能力，不影响已发布 Mac 功能。

本期验收标准是上述目标 Windows x64 设备均可产出正确、可播放的深度参考视频；CPU 可明显较慢，但不能无响应、无限重试或让用户误以为任务成功。Windows ARM64 和旧到无法满足已验证 CPU Runtime 基线的设备，需要明确提示不支持，不宣称“所有 Windows 设备”无条件可用。
