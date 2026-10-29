# Windows 视频运行包

`scripts/package-media-runtime-windows.ps1` 使用 `licenses/ffmpeg-windows.json` 固定的 BtbN FFmpeg 8.1.3 静态构建，并校验发行 ZIP、两个可执行文件与原始 GPL 许可证。随包保留 `ffmpeg.exe`、`ffprobe.exe`、上游 `LICENSE.txt` 和固定清单 `manifest.json`；另保留相同的 `LICENSE` 副本及 BeefTV 提供的 `README.txt`，兼容已发布更新器的文件要求。不携带 ffplay 或开发工具。打包时实际生成短视频，再用随包 ffprobe 检查时长与尺寸。应用不修改用户 PATH，也不在用户首次导入时下载运行包。

应用和 CLI 从自身位置解析 `agent-host/media-runtime/` 中的工具，不依赖当前工作目录。此目录随已有的 `agent-host` 整组更新和回滚，兼容已经发布的 Windows 更新器。原独立 `media-runtime/` 仍可读取，新包内的工具优先。`CANVAS_FFMPEG_PATH`、`CANVAS_FFPROBE_PATH` 的显式配置优先，配置无效时不得暗中回退。Windows 子进程隐藏控制台。

音视频入库时尽力补齐缺失时长和视频尺寸；检查失败仍保留已保存的原始文件。旧资源在作为生成参考时，由资源服务验证归属、读取本地文件、检查并保存缺失字段。检查使用 12 秒上限并响应任务取消，禁止探测过程访问网络；字段仍缺失、工具不可用、坏文件或保存失败时，在提交上游前停止。已有完整字段不重复探测。macOS 随包工具与 Linux 的安装依赖见 [本地参考素材检查工具](./media-metadata-runtime.md)，不能将 Windows 随包验证当成其他平台的发布验证。

该 FFmpeg 构建采用 GPL-3.0-or-later，作为独立进程运行；第三方许可证不由 BeefTV 的源码可用条款替代。固定清单记录 FFmpeg 核心提交 `46d899d7a02bc63237472cc4897258d5ddf274ac`、完整构建配方及对应源码归档。随包 README 指向该清单；实际源码和构建说明见清单中的组件归档，分发责任见[媒体组件的许可与源码交付](../media-source-distribution.md)。

验收至少覆盖：校验失败时不生成运行包、带中文和空格的搬移目录、测试进程 PATH 中无 FFmpeg/ffprobe 时 H.265 → H.264 后读取真实时长和尺寸、原文件哈希不变、原生可播放素材不请求转码、重用预览、失败重试、串行转换、按用户清理缓存、更新及回滚时整组移动运行包。`TestBundledWindowsHEVCWithoutSystemFFmpeg` 必须在实际随包目录下由原生 Windows 执行。源码合并不等于正式 Windows 包已经发布。
