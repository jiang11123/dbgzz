# 本地参考素材检查工具

资源服务在音视频入库时尽力补齐时长和视频尺寸，保留已经保存的原始文件。旧资源作为生成参考时，资源服务先验证归属、读取本地文件并保存缺失字段，再允许提交上游。检查最多执行 12 秒，响应任务取消，禁止读取网络地址；失败后不会创建新的上游生成请求。已完整的字段不重复检查。

macOS 发布通过 `scripts/package-media-runtime-macos.sh` 从 FFmpeg 固定源码提交 `894da5ca7d` 构建独立 ffprobe，下载包 SHA256 固定在脚本中。关闭自动依赖探测和网络协议，只启用本地 `file`、`pipe` 以及所需音视频容器和解析器，静态链接 FFmpeg 库。打包拒绝 Homebrew 或其他非系统动态库；工具、LGPL 许可证、源码与构建说明、校验清单随 `Contents/Resources/agent-host/media-runtime/` 分发。

正式 Mac 构建在原生目标架构执行 `scripts/test-media-runtime-macos.sh`：将真实工具复制到带中文和空格的位置，分别从 GUI 和 CLI 的可执行位置，在 PATH 没有 ffprobe 时读取实际 WAV，验证资源时长已保存。arm64 与 Intel 的运行结果分别由对应原生构建提供；交叉构建只证明编译与动态依赖检查，不能替代目标架构执行。

Windows 使用 `licenses/ffmpeg-windows.json` 固定的 BtbN FFmpeg 8.1.3 构建，同时携带 ffmpeg 和 ffprobe；原生包检查要求无系统媒体工具时仍可转换短视频并读取时长、尺寸，见 [Windows 视频运行包](./windows-media-runtime.md)。Windows 与 macOS 的版本和构建方式分别记录。

Linux DEB 继续通过系统 ffmpeg 依赖提供 ffprobe。直接解压包需要用户提供 ffprobe 或显式配置 `CANVAS_FFPROBE_PATH`；检查工具不可用时必须明确失败。浏览器探测是否可移除，应以对应安装包真实验证为准，不能用某个平台的源码测试替代其他安装方式。
