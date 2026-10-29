# Windows Depth Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Mac 深度视频流程不变的前提下，让 Windows x64 优先以 CUDA、否则以 CPU 生成可播放的深度参考视频。

**Architecture:** 复用现有画布入口、任务与资源写回；为 Windows 增加经验证的 CPU/CUDA 运行包，Go 负责可信安装、设备选择和仅一次的设备故障回退。Windows 能力在真实短视频推理通过前不对用户开放。

**Tech Stack:** Go 任务与下载器、Python 3.11/PyTorch/Video Depth Anything Small、FFmpeg、PowerShell、Wails、Bun test、GitHub Actions Windows runner。

**Spec:** `docs/superpowers/specs/2026-09-29-windows-depth-runtime-design.md`

## Global Constraints

- 仅支持验证通过的 Windows x64；Mac Apple Silicon 继续使用现有 MPS 路径。Windows ARM64 不在本期范围。
- 保留现有 15 秒上限、Video Depth Anything Small、近白远黑、1920×1080 H.264 输出及现有节点/任务流程。
- CUDA 仅在真实模型试运行通过后启用；无 CUDA 或 CUDA 设备故障用 CPU，其他故障不得伪装成设备回退。
- CPU 模式开始前提示可能耗时较长；不得静默丢帧或改变视频时长。
- Runtime 和模型只从经可信验证的发布清单下载；无签名或校验失败不执行。私钥不得进入仓库、日志或客户端。
- 每项改动只涉及深度功能及其 Windows 分发；每任务先红测、最小实现、绿测，再提交。

## Review Focus

- 无 NVIDIA 设备：不下载 CUDA 包，选 CPU，任务可成功。
- NVIDIA 驱动存在但模型前向失败：选 CPU，且仅有一个结果节点/资源。
- 运行中 CUDA 设备故障：清理半成品、CPU 最多重试一次；用户取消时不重试。
- 输入损坏、模型哈希错误或磁盘不足：保留真实错误，不触发 CPU 回退。
- Windows 路径含空格或中文、包解压中断/文件占用：安装与重试安全，不影响 Mac 缓存。

---

### Task 1: Windows CPU/CUDA 可行性证明

**Files:**
- Create: `scripts/probe-depth-runtime-windows.ps1`
- Test: `tools/depth-capture/tests/test_windows_device_probe.py`
- Modify only if proven necessary: `tools/depth-capture/depth_capture/model.py`

**Interfaces:**
- Consumes: 固定的 VDA commit `4f5ae23172ba60fd7bc11ef671cca678842c7072` 与 Small 权重哈希，现有 `python -m depth_capture` CLI。
- Produces: Windows 实机 CPU/CUDA 短片运行记录（退出码、可播放输出、帧数、时长、设备）；如需 CPU 算子兼容层，保持 `infer_relative_depth(...)` 现有接口。

- [ ] **Step 1: 写失败测试**：`test_cpu_uses_supported_attention_path` 验证 CPU 模型前向不调用 CUDA-only xformers 算子；`test_cuda_probe_rejects_failed_forward` 验证显卡存在但前向失败不宣称 CUDA 可用。
- [ ] **Step 2: 在 Windows x64 上运行测试，记录当前失败原因**：`uv run python -m unittest discover -s tests -v`（工作目录 `tools/depth-capture`）；缺少依赖/权重和模型算子失败要分别记录。
- [ ] **Step 3: 最小修复并加入短片探针**：PowerShell 脚本接受 `-Device cpu|cuda` 和本地模型路径，生成短测试视频，运行现有 CLI，以 `ffprobe` 校验结果；若固定上游 CPU 算子不兼容，仅对该路径做兼容补丁。
- [ ] **Step 4: 在至少一台无 CUDA 与一台可用 CUDA 的真实 Windows x64 机器上运行探针**；两条路径均生成可播放视频且帧数、时长符合现有合同，才通过此门槛。无设备可用时标记为未验证，不继续开放 Windows 入口。
- [ ] **Step 5: 提交探针和必要的 CPU 兼容修复**：`git add scripts/probe-depth-runtime-windows.ps1 tools/depth-capture && git commit -m "test(depth): prove Windows CPU and CUDA inference"`。

### Task 2: 可信的多变体清单与平台安装

**Files:**
- Modify: `backend/internal/depthruntime/installer.go`
- Modify: `backend/internal/depthruntime/installer_test.go`
- Create: `backend/internal/depthruntime/manifest_verify.go`
- Test: `backend/internal/depthruntime/manifest_verify_test.go`

**Interfaces:**
- Consumes: `Ensure(ctx, EnsureOptions)` 现有安装入口与 `Artifact` 哈希校验。
- Produces: `EnsureOptions.Platform string`（`darwin-arm64` / `windows-amd64`）、`EnsureOptions.Variant string`（`mps` / `cpu` / `cuda`）；`Installation` 继续暴露 `Python`, `ToolDir`, `ModelRuntime`。新版清单使用独立 URL、schema v2、按平台/variant 选择 artifact，旧 v1 URL 和 Mac 缓存继续可用。

- [ ] **Step 1: 写失败测试**：v2 清单按平台/variant 选对包；Windows 用 `python.exe` 路径且无需 POSIX 执行位；Mac v1 测试保持通过；路径穿越、无效签名、恶意重定向、错误哈希、包中断、中文/空格路径都拒绝或安全恢复。
- [ ] **Step 2: 跑红测**：`cd backend && go test ./internal/depthruntime -count=1`，确认仅新增用例失败。
- [ ] **Step 3: 最小实现**：新 URL 的 v2 JSON 附独立 Ed25519 签名，客户端内置专用公钥验证签名后再解析下载项；Windows 目录按 variant 隔离，解压到临时目录、自检后发布。旧 Mac 清单/缓存路径不改；受信 fallback 仅保留现有 Mac 固定值，不能把远端未经签名的 Windows 清单当 fallback。
- [ ] **Step 4: 跑绿测和 Windows 原生测试**：`cd backend && go test ./internal/depthruntime -count=1`；Windows runner 另跑相同测试。签名私钥只放 CI secret；发布前必须完成与内置公钥对应的配置。
- [ ] **Step 5: 提交**：只提交上述深度安装文件和测试。

### Task 3: 可重定位的 Windows CPU/CUDA 运行包

**Files:**
- Create: `scripts/build-depth-runtime-windows.ps1`
- Create: `scripts/test-depth-runtime-windows.ps1`
- Modify: `tools/depth-capture/pyproject.toml`（仅在 Windows 依赖固定需要时）
- Modify: `.github/workflows/quality.yml`（增加非发布 Windows 校验）

**Interfaces:**
- Consumes: Task 1 验证的 Worker/模型接口；Task 2 的 v2 清单条目和安装布局。
- Produces: `windows-amd64-cpu.zip`、`windows-amd64-cuda.zip`、各自大小/哈希/文件数/解压体积元数据；包内 Python、固定依赖、VDA 源码、Worker、FFmpeg/ffprobe 与 LICENSE/NOTICE。

- [ ] **Step 1: 写包自检脚本**：对每种包从全新目录解压并移动到含空格/中文路径；验证 Python、PyTorch、FFmpeg 可运行；CPU 包在无 NVIDIA 驱动机器启动。
- [ ] **Step 2: 在 Windows runner 跑自检，确认当前缺包失败**：`pwsh -File scripts/test-depth-runtime-windows.ps1 -Variant cpu`（CUDA 包的真实 GPU 前向由 Task 1 的实机门槛覆盖）。
- [ ] **Step 3: 最小实现打包**：两种包固定相同 VDA commit/Worker，CPU 与 CUDA 使用各自固定 PyTorch wheel；不得复用 Mac `.venv/bin` 布局，也不得在运行时 `git clone` 或 `pip install`。
- [ ] **Step 4: 验证 CPU/CUDA 包都可重定位，并校验发布元数据**；CPU 包自检跑在无 NVIDIA 的 Windows runner，CUDA 包做静态依赖检查和 NVIDIA 实机探针。
- [ ] **Step 5: 提交**：只提交 Windows 打包、自检和相应 CI 校验。

### Task 4: Go 设备选择、有限回退及 Windows 进程清理

**Files:**
- Modify: `backend/internal/app/task_depth_worker.go`
- Create: `backend/internal/app/task_depth_device.go`
- Create: `backend/internal/app/task_depth_device_test.go`
- Create: `backend/internal/app/task_depth_process_windows.go`
- Create: `backend/internal/app/task_depth_process_other.go`
- Modify: `backend/internal/app/task_depth_test.go`

**Interfaces:**
- Consumes: Task 2 的 `EnsureOptions.Platform/Variant` 与 `Installation`；Task 3 的运行包。
- Produces: `depthDeviceChoice{Variant, Device, FallbackReason}`，由探测器注入以便单测；后端任务阶段/结果记录最终设备、Runtime 版本、回退原因与耗时，现有资源写回协议保持兼容。

- [ ] **Step 1: 写失败测试**：Mac 仍固定 MPS；Windows 无候选 NVIDIA 不下载 CUDA；CUDA 真实前向失败选 CPU；设备类运行中失败仅重试一次；输入/下载/哈希/空间错误不回退；取消后不重试；重复事件只写入一份资源。
- [ ] **Step 2: 跑红测**：`cd backend && go test ./internal/app -run 'TestDepth' -count=1`。
- [ ] **Step 3: 最小实现**：轻量候选检测后才准备 CUDA 包，在包内运行真实前向探针；选择失败则装 CPU 包。运行中仅对稳定设备错误码回退一次，先清理半成品；Windows 用受控进程树终止 Worker/FFmpeg，其他系统沿用现有行为。
- [ ] **Step 4: 跑绿测与跨平台编译**：`cd backend && go test ./internal/app ./internal/depthruntime -count=1`，并在 Windows runner 跑同样命令。人工取消后确认没有孤儿 Python/FFmpeg。
- [ ] **Step 5: 提交**：只提交深度任务执行文件和测试。

### Task 5: CPU 提示与现有节点回归

**Files:**
- Modify: `web/src/pages/canvas/use-canvas-media-tools.ts`
- Modify only if necessary: `web/src/components/canvas/canvas-node.tsx`
- Modify: `web/test/canvas-depth-capture.test.ts`

**Interfaces:**
- Consumes: Task 4 的任务阶段、错误类别、最终设备；不新增画布工具入口。
- Produces: CPU 开始前的慢速提示、从 CUDA 切到 CPU 的原因及现有节点中的进度/取消/错误展示。

- [ ] **Step 1: 写失败测试**：无 CUDA 走 CPU 时显示慢速提示；CUDA 回退不创建第二个节点；输入损坏显示原始错误；Mac 正常流程文案不变。
- [ ] **Step 2: 跑红测**：`cd web && bun test test/canvas-depth-capture.test.ts`，确认仅新增用例失败。
- [ ] **Step 3: 最小实现**：优先使用已有 `task.stage`/`processingLabel`；仅缺少提示呈现能力时改节点组件，不改其它模型节点。
- [ ] **Step 4: 跑绿测及画布回归**：`cd web && bun test test/canvas-depth-capture.test.ts && bun run typecheck`，再执行相关画布测试；手动确认取消、失败、重试和结果播放。
- [ ] **Step 5: 提交**：只提交深度 UI 与测试。

### Task 6: 发布与整体验收门槛

**Files:**
- Create: `.github/workflows/depth-runtime-windows.yml`（独立发布流水线；不改桌面应用常规发布）
- Modify: `tools/depth-capture/README.md`（记录 Windows 能力、下载、CPU 慢速提示及限制）
- Test: `scripts/test-depth-runtime-windows.ps1`

**Interfaces:**
- Consumes: Tasks 1–5 的运行包、签名/哈希元数据、应用路径。
- Produces: 签名 v2 清单与两个 Windows Runtime 资产；发布前独立验收记录。

- [ ] **Step 1: 写发布门槛检查**：缺专用签名私钥、公钥不匹配、包 SHA-256 不符、任一实机推理验收缺失时失败；不得发布未签名 Runtime。
- [ ] **Step 2: 运行门槛检查，确认失败会阻止发布**。
- [ ] **Step 3: 最小实现独立发布流程与文档**：Windows runner 构建两包，签清单，发布到新版本 URL；旧 `v1.5.5` Mac 资产和旧客户端 URL 不覆盖。
- [ ] **Step 4: 全链验收**：NVIDIA Windows 用 CUDA、无 CUDA Windows 用 CPU；两者分别跑短片与接近 15 秒片段，核对帧数/时长/可播放、峰值内存/磁盘/耗时。再测 CUDA 初始化失败、运行中故障、取消、输入损坏和应用重启。Mac MPS 做回归。
- [ ] **Step 5: 只在全部通过后启用 Windows 入口并提交**；任何实机或签名门槛未通过时保留功能关闭，记录未完成项，不宣称 Windows 已支持。

## 执行顺序与停止条件

严格按 Task 1→6，每任务红测→最小改动→绿测→提交。Task 1 的 Windows CPU/CUDA 真实推理是第一停止条件；Task 2 的可信签名与 Task 6 的实机矩阵是发布停止条件。缺少 Windows 实机或签名发布密钥时可完成本地代码与模拟测试，但不得跳过相应门槛发布或称为已验证。
