# 豆包工作站 2.0（dbgzz）

面向 Windows 的本地豆包多账号工作站，支持独立登录会话、统一文字聊天、图片/视频生成、素材管理，以及本地 OpenAI 兼容 API 网关。

这是第三方桌面工具，非豆包官方产品。需要自行登录豆包，实际模型、额度和生成能力以登录账号的豆包页面为准。

**[下载安装包](https://github.com/jiang11123/dbgzz/releases) · [完整使用教程](docs/user-guide.md) · [更新记录](CHANGELOG.md)**

## 2.0 功能

| 功能 | 使用入口 |
| --- | --- |
| 多账号独立登录、切换和管理 | 顶部账号标签、“添加账号”、“设置” |
| 文字聊天、深度思考、流式 Markdown、历史会话 | “网关模式”聊天区 |
| 图片生成与参考图片 | “图片模式”、添加文件按钮、图片资产栏 |
| 视频生成、模型/比例/时长设置、确认与补充文字 | “视频模式”及当前会话输入框 |
| 图片/视频保存及视频尾帧提取 | 生成结果卡片 |
| 下载目录、账号快捷键 | “设置” |
| 日间/夜间主题 | 顶部主题按钮 |
| 本地文字及图片 API、账号池状态和日志 | “网关设置” |

## 下载与安装

1. 从 [Releases](https://github.com/jiang11123/dbgzz/releases) 下载 `dbgzz-Setup-2.0.0-x64.exe`。
2. 运行安装程序，选择目录，再从桌面打开“豆包工作站”。普通用户不需要安装 Node.js。
3. 点击账号标签完成豆包登录，或点击“添加账号”创建独立会话。
4. 切回“网关模式”开始文字聊天；按需启用图片或视频模式。

安装包不含作者的账号、登录状态或素材。目前安装包未签名，Windows 可能显示发布者未知，请确认下载来源。

旧版升级前请退出程序并备份完整用户数据目录及下载文件，然后运行新版安装包。不要先清除旧数据。见 [安装、升级与使用教程](docs/user-guide.md)。

## 本地 API 接入

保持工作站运行且至少一个豆包账号正常登录。打开“网关设置”，复制实际地址和 API Key 到本机 OpenAI 兼容客户端：

| 配置 | 默认值 / 来源 |
| --- | --- |
| Base URL | `http://127.0.0.1:8788/v1`，以界面显示为准 |
| API Key | 首次自动生成，从网关设置复制 |
| 文字模型 | `doubao`；深度思考使用 `doubao-think` |
| 模型列表 | `GET /v1/models` |
| 文字对话 | `POST /v1/chat/completions`，支持流式 |
| 图片生成 | `POST /v1/images/generations` |

这是部分 OpenAI 格式兼容接口，不保证全部接口或参数兼容。HTTP 视频生成尚未接入运行时回调，请用桌面“视频模式”。`doubao-pro`、`doubao-lite` 等是工具的模式别名，不表示独立官方模型权限。接入示例见 [教程](docs/user-guide.md#本地-api-接入)。

## 从源码运行

建议 Windows x64、Node.js 22 与 npm。原生依赖构建可能需要 Visual Studio Build Tools（C++ 桌面开发）及 Python。

```powershell
git clone https://github.com/jiang11123/dbgzz.git
cd dbgzz
npm ci
npm run rebuild
npm run build
npm start
```

```powershell
npm run dev          # 开发模式
npm run typecheck    # 主进程与界面类型检查
npm test             # 编译后运行主进程与界面测试
npm run package:win  # 构建 release/ 下的 Windows x64 安装包
```

## 本地数据与限制

- 登录会话、数据库、素材和设置保存在本机 Electron 用户数据目录，不随仓库和安装包分发。定位与备份见 [教程](docs/user-guide.md#备份与升级)。
- API 网关默认仅监听本机 `127.0.0.1`；旧画布桥接使用本机 `3219`，尚未统一 API Key 鉴权，请勿通过代理或端口映射公开。
- 网页结构、网络、验证码、额度和链接有效期可能影响运行，不能保证所有模型、时长、分辨率及无水印下载始终可用。Video2X 视频超分已移除。
- 当前未附开源许可证；公开源码不等于授予任意再分发或商业使用许可。

## 更新与反馈

- [完整更新记录](CHANGELOG.md)：保留 0.1.x 历史和 2.0 更新。
- [2.0.0 发布说明](docs/releases/2.0.0.md)：验证范围、已知限制及升级提醒。
- [提交问题](https://github.com/jiang11123/dbgzz/issues)：提供版本、系统、步骤、错误文本和脱敏截图，请勿上传密码、Cookie、API Key 或完整数据目录。
- [历史设计与执行记录](docs/2.0-execution-log.md)：供开发追溯，当前操作以使用教程为准。
