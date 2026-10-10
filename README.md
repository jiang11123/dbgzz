# 豆包工作站（dbgzz）

基于 Electron、React 和 TypeScript 的本地豆包工作站，支持多账号独立会话、共享图片素材、批量消息同步、视频下载与视频库、Video2X 超分，以及本地画布桥接。

## Windows 安装

从仓库 Releases 下载 `dbgzz-Setup-版本号-x64.exe`，运行安装程序，再从桌面打开“豆包工作站”。首次使用需自行登录豆包。安装包不含任何已有账号、登录状态、图片素材或视频。

## 从源码运行

需要 Windows x64、Node.js 22 LTS 与 npm。原生依赖首次安装及构建可能需要 Visual Studio Build Tools（C++ 桌面开发）和 Python。

```powershell
npm ci
npm run rebuild
npm run build
npm start
```

开发模式：`npm run dev`。类型检查：`npm run typecheck`。

## 构建 Windows 安装包

```powershell
npm ci
npm run package:win
```

输出位于 `release/`。当前为未签名安装包，Windows 可能显示发布者未知。

## 视频超分

安装包不捆绑大型第三方引擎。请自行安装 [Video2X 6.x](https://github.com/k4yt3x/video2x/releases)，在视频库选择“配置 Video2X”，并安装 FFmpeg / ffprobe 加入 PATH；也可用 `VIDEO2X_PATH`、`FFMPEG_PATH`、`FFPROBE_PATH` 指定完整路径。超分需要支持 Vulkan 的 GPU。

源码模式也会自动查找 `tools/video2x/video2x.exe`。引擎的模型及 DLL 需一并保留。详见 [视频超分说明](docs/video-upscale.md)。

## 本地数据

登录会话、账号数据库、素材及本地设置保存在 Electron 的用户数据目录中，不随仓库分发。`exports/`、日志、缓存、第三方引擎和构建产物均排除在 Git 之外。

更多使用说明见 [共享工作台](docs/shared-workspace.md)。
