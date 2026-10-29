# 媒体组件的许可与源码交付

BeefTV 保留现有 FFmpeg 媒体能力。根目录 `LICENSE` 中的新源码可用条款仅适用于其约定的新增原创内容；历史 MIT 内容及第三方组件继续适用原许可证。不能用一条额外声明覆盖第三方许可证。

## 组件与调用方式

| 组件 | 版本与许可 | 使用方式 |
| --- | --- | --- |
| 浏览器 `@ffmpeg/core` | 0.12.10，GPL-2.0-or-later | Worker 中运行，提供剪辑、裁剪、合并、音频处理及导出 |
| Windows FFmpeg/ffprobe | BtbN n8.1.3-18-g46d899d7a0-20261019，GPL-3.0-or-later | 独立命令行进程，通过参数和文件交换数据 |
| macOS ffprobe | FFmpeg 8.0.1，LGPL-2.1-or-later | 从固定源码编译，关闭 GPL 特性与外部库，独立进程探测媒体 |
| Windows 可选深度运行包 | 与桌面相同的固定 BtbN 构建；历史包还含 imageio-ffmpeg wheel 自带的 FFmpeg | Python 启动独立进程；后续构建移除未使用的 imageio-ffmpeg，保留 imageio |

原生命令行工具和浏览器 WASM 的使用方式不同，需要分别判断组合分发的许可要求。独立进程、Worker 或单独下载均不能自动证明兼容；第三方清单也不能替代对应源码交付。

## 已实现的交付

- 应用版本号 → 更新日志 → **第三方许可与源码**，可查看项目许可、第三方清单和 GPL/LGPL 全文。
- Web 构建将这些文件写入 `/licenses/`；桌面包同时放在 `agent-host/licenses/`，macOS 位于应用的 `Contents/Resources/` 下，可离线读取。
- `sources.json` 记录本次构建的平台、组件版本、许可和 WASM 文件哈希。`upstream` 是上游项目入口；`source` 仅记录本流水线实际生成的源码包，缺失时为 `null`，页面不生成不存在的下载链接。
- macOS 构建 ffprobe 时同时生成 `BeefTV-vX.Y.Z-ffprobe-darwin-{arm64,amd64}-sources.tar.gz`，包含未经修改的源码、许可证、实际构建脚本、参数和二进制哈希。正式桌面流水线将它与安装包一同上传到同版本 GitHub Release。
- 浏览器核心的源码包 `BeefTV-vX.Y.Z-ffmpeg-wasm-sources.tar.gz` 包含 21 份固定提交的源码归档、许可证、上游编译脚本和离线构建说明。正式桌面流水线先生成源码包，再将其下载信息写入各平台许可页，并与安装包一起上传。普通本地/Web 构建只在实际提供该源码包时写入下载信息。
- Windows 的版本、上游 ZIP、两个可执行文件、许可证与源码归档哈希统一固定在 `licenses/ffmpeg-windows.json`。桌面和深度构建都调用同一个媒体打包器，拒绝任意系统安装的 FFmpeg。两者随包保留 `LICENSE.txt`、完整 `manifest.json`，以及旧更新器要求的相同许可证副本 `LICENSE` 和 BeefTV 提供的 `README.txt`；深度运行包在压缩后再次校验 ZIP 内的六个文件，并将对应信息写入构建元数据。

可单独生成 macOS 源码包：

```sh
bash scripts/package-media-runtime-macos.sh darwin/arm64 ./media-runtime \
  ./ffmpeg-source.tar.gz ./BeefTV-vX.Y.Z-ffprobe-darwin-arm64-sources.tar.gz
```

这里记录哈希用于核对材料，不将工程校验等同于法律兼容性结论。

生成或检查 WASM 源码包：

```sh
python3 scripts/package-wasm-sources.py --version vX.Y.Z \
  --binary-dir web/node_modules/@ffmpeg/core/dist/esm
python3 scripts/package-wasm-sources.py \
  --verify dist/BeefTV-vX.Y.Z-ffmpeg-wasm-sources.tar.gz
```

固定版本清单在 `licenses/ffmpeg-wasm-sources.json`。源码选择依据上游 0.12.10 发布提交、依赖历史以及现有核心报告的版本：FFmpeg 5.1.4、Emscripten 3.1.40 的精确提交、x264 core 164 和 LAME 3.100 均吻合。源码包保留 `build/*.sh`、修改过的 `src/fftools` 和绑定代码；离线构建配方仅将上游下载步骤改为使用已归档文件。上游未提供签名构建证明，源码包不声称能逐字节复现 npm 产物。自行重编译并替换核心是另一个需要功能验证的操作。

Windows 桌面和深度运行包使用同一个入口：

```powershell
./scripts/package-media-runtime-windows.ps1 -Destination ./build/media-runtime
./scripts/build-depth-runtime-windows.ps1 -Variant cpu -FFmpegDir ./build/media-runtime
```

上游仅保留最近 14 个每日构建，因此打包器从 BeefTV 的[固定组件归档](https://github.com/glanderness/BeefTV/releases/tag/media-ffmpeg-windows-n8.1.3-20261019)下载同一 ZIP。也可通过 `-ArchivePath` 或环境变量 `BEEFTV_WINDOWS_MEDIA_ARCHIVE` 指定已保存的 ZIP；桌面构建会继承该环境变量，仍执行相同的哈希校验，不接受其他版本。

Windows 源码清单绑定 BtbN 固定构建配方、依赖镜像、FFmpeg 提交以及三份依赖缓存分片和一份补充源码归档。上述组件归档同时提供这些材料、构建说明与 `SHA256SUMS`，许可页链接到同一归档。更换构建时须一起更新对应材料；该归档不声称完整工具链可离线或逐字节重建。

## 发布责任

分发者应保留各组件的署名、许可和适用的源码材料，并提供与所分发二进制对应的源码、修改和必要构建脚本。上游主页或版本号本身不构成完整对应源码的交付。

历史 Gyan 预构建工具及 imageio wheel 内嵌 FFmpeg 的依赖源码、补丁和构建材料须按原二进制分别核对；不能用新 BtbN 源码、FFmpeg 主源码或 imageio Python 包的 BSD 许可替代。源码包归档也不自动证明组合分发的许可相容性。

深度组件通过 OpenCV 读取视频，并调用运行包 `bin/` 下的 FFmpeg 写出预览，不使用 `imageio-ffmpeg`。后续构建因此移除这个重复的可执行文件，并在搬移自检中实际读取视频，确认无需该 wheel。已经发布的旧运行包仍须按其实际内容核对，移除后续构建的依赖不等于补齐旧二进制的源码。

## 参考

- [FFmpeg 许可说明](https://ffmpeg.org/legal.html)
- [ffmpeg.wasm 官方许可问答](https://ffmpegwasm.netlify.app/docs/faq/)
- [BtbN Windows 构建配方](https://github.com/BtbN/FFmpeg-Builds/tree/63ac3265b0789ea16c7b1f8351cd2ad195a28722)
- [Remotion 第三方组件与 FFmpeg 说明](https://www.remotion.dev/docs/acknowledgements)
