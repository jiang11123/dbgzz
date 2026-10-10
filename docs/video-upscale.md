# 视频库批量超分

## 使用

豆包网页直接操作：在工作台内的豆包网页视频封面或播放器上右键，选择“超分到 2K”或“超分到 4K”。源视频仅下载到内部缓存，不入库、不显示下载完成；最终超分成片通过校验后才保存至下载目录的“超分视频”文件夹并入库。原“去水印下载”入口保留，行为不变。

全局任务提示持续显示准备、排队、AI 超分、校验、输出阶段。AI 阶段直接读取 Video2X 的 `frame=N/T` 标准输出，展示本轮百分比、实际帧数、帧速率、已用时间和预计剩余时间。AI 达到 100% 后仍需合成与校验，只有最终文件成功保存才显示“超分完成，视频已保存”和打开下载位置。内部缓存正常结束时清理。进度接口适用于新启动的任务，旧进程不能热升级。

构建后重新启动应用：`npm run build`、`npm start`。

1. 打开视频库，勾选视频；支持全选、Ctrl / Cmd 切换选择、Shift 连选。
2. 在已选视频上右键，选择“超分到 2K”或“超分到 4K”。在未选视频上右键则仅处理该视频。
3. 页面下方显示每条任务的等待、AI 处理、输出、完成或失败状态；可取消未完成任务。切换页面后任务继续。
4. 完成文件自动进入视频库，也可直接打开输出位置。

2K 沿用先前测试中的约定：长边 2560；4K 长边 3840。根据显示宽高比计算另一边，取最近的偶数像素以兼容 H.264。不裁切、不拉伸到固定横屏画布；非整除比例有最多约 1 像素的取整误差。已达到目标长边的源视频会提示无需超分。

输出位于源文件旁的 `超分视频` 文件夹，命名为 `原名-2K.mp4` / `原名-4K.mp4`；重名自动加数字。原视频、已有输出不覆盖。保留音频，输出 H.264 / AAC MP4；不保留字幕、章节和 HDR 元数据。

## 引擎与配置

- 当前项目已放置官方 Video2X 6.4.0 Windows 便携版：`tools/video2x/video2x.exe`，模型和 DLL 必须一起保留。
- 来源：[官方 6.4.0 发布页](https://github.com/k4yt3x/video2x/releases/tag/6.4.0)。原 ZIP SHA256：`0337B6DCAE2BAD2FD13E43FBDB73EF728D2F6289F37CC3617E87AC3A1A5CF793`。
- 可用“配置 Video2X”选择其他 6.x 命令行程序，选择保存在本地设置中。优先级：保存的路径 → `VIDEO2X_PATH` → 项目便携版 → PATH。
- FFmpeg / ffprobe 从 PATH 查找，支持 `FFMPEG_PATH` / `FFPROBE_PATH` 指定完整路径。
- 需要 Vulkan GPU 与足够显存。当前 RTX 4060 Laptop GPU 已实际跑通短样片。

依据[官方命令行说明](https://docs.video2x.org/running/command-line.html)，Real-ESRGAN 使用 `-s 4` 和 `realesrgan-plus` 模型，再由 FFmpeg 等比例调整至目标尺寸。低分辨率视频可能需要多轮 AI；已有高分辨率视频也会先放大 4 倍，处理时间、显存和临时磁盘占用可能较高。

## 可靠性与已知限制

- 仅接受视频库中的路径；参数数组直接启动进程，不经过 shell。一个队列串行使用 GPU，相同源文件、相同目标的活动任务去重。
- 预处理统一旋转方向、非方形像素，并去除 B 帧，规避本机 Video2X 6.4 对短片尾部延迟帧的漏帧问题。
- 本机 6.4.0（对照 6.3.1 也复现）有输出完成后进程访问冲突的情况。仅当退出码为 `3221225477`、引擎明确报告成功且处理帧数完全匹配时，才尝试恢复；随后完整解码并核对帧数、时长，任何验证失败都不归档。不是忽略所有非零退出码。
- 最终输出核验尺寸、帧数、时长后才入库。单项失败不阻断其余任务。正常取消会终止进程并清理临时目录。
- 队列及历史状态仅保存在本次运行内，退出应用会取消任务；不支持重启续传。强制结束应用或系统断电可能留下 `.upscale-*` 临时目录。
- 不扣账号生成额度。超分结果单独归类为“视频超分”，原记录保留。

## 本次核实与验证（2026-09-19）

原目录无 Git 元数据，不能比较提交历史。核实源码后发现已有下载、去水印、视频库功能；超分只有 `video-upscale.test.ts`，实现文件、IPC 和多选界面尚不存在。旧下载说明中的未勾选条目不作为未实现的依据。

已补齐后端队列、独立结果表、IPC、多选组件及右键菜单。同时修复原工作台 effect 依赖 `data` 导致的持续刷新，避免选择被刷新干扰。

验证命令：

```powershell
npm run typecheck
npm run build
node --test dist/main/main/*.test.js
node scripts/check-video-upscale.cjs
# Windows GUI 程序需等待实际进程退出，并读取日志
$check = Start-Process ./node_modules/electron/dist/electron.exe -ArgumentList 'scripts/check-upscale-ui.cjs' -PassThru -Wait -WindowStyle Hidden -RedirectStandardOutput exports/upscale-check/ui.stdout.log -RedirectStandardError exports/upscale-check/ui.stderr.log
$check.ExitCode
```

真实 GPU 样片：480×640 → 1920×2560（有音频）、960×540 → 3840×2160。包含坏文件后继续、去重、取消、临时文件清理、重名保护检查。输出和结果 JSON 位于 `exports/upscale-check`。界面测试使用隔离数据库，验证多选、两个菜单入口、刷新选择保留及结果入库；截图为 `exports/upscale-check/multi-select-menu.png`。未对用户整段长视频执行批量超分。
