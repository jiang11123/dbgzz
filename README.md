# 豆奶画布 3.0

<img src="build/icon.png" width="112" height="112" alt="豆奶画布 · 奶蛙老师" />

面向 Windows 的本地 AI 创作画布，把文字、图片、视频、素材和豆包多账号放在同一个工作区。由奶蛙课堂维护，基于 BeefTV 二次开发；非豆包或 BeefTV 官方产品。

**[下载最新版](https://github.com/jiang11123/dbgzz/releases/latest) · [使用教程](docs/user-guide.md) · [更新记录](CHANGELOG.md) · [来源与许可](NOTICE.md)**

## 下载安装

1. 打开 [Releases](https://github.com/jiang11123/dbgzz/releases/latest)，下载 `dounai-canvas-Setup-3.0.0-x64.exe`。
2. 退出旧程序后运行安装包，从桌面打开“豆奶画布”。普通用户无需安装 Node.js、Go 或其他开发工具。
3. 点击主页左上角的豆包账号按钮，选择“添加豆包账号（扫码）”，完成登录。
4. 新建画布，添加原始文字、图片或视频节点，在模型选择器中选择豆包账号，或使用自行配置的 API 模型。

本次提供 Windows x64 安装版。安装包不包含作者的登录会话、密钥或项目数据，目前没有发布者代码签名。

## 主要功能

| 功能 | 使用方式 |
| --- | --- |
| 文字、图片、视频与素材画布 | 新建画布，添加节点并连接上下游 |
| 豆包多账号 | 左上角账号管理中扫码添加、查看状态和管理账号 |
| 原始节点调用豆包 | 在节点的模型选择器中选择“豆包账号” |
| 独立豆包文字、图片、视频节点 | 默认隐藏；在添加豆包账号附近开启“显示独立豆包节点” |
| 自定义 API 模型 | “模型配置”中添加渠道；豆包账号与 API 默认模型分开 |
| 软件更新 | 正式安装版启动时及每 15 分钟检查，左下角下载并安装 |

豆包页面模型、额度、登录状态、验证码和网络都会影响生成。软件内标注“正在开发”的入口及上游模型不可用的能力，不代表已经支持。Grok 图片编辑可用性仍取决于所配上游权限。

## 升级与本地数据

“豆奶画布”沿用原“豆包工作站”的应用标识和 `doubao-video-workspace` 数据目录。升级前请退出旧程序，备份用户数据目录与下载素材，再覆盖安装；不要先删除旧数据。

已经下载旧版的用户需先手动安装本版本，之后才能接收软件内的更新提示。更新需要联网连接 GitHub；发布者修改本地代码或仅推送源码不会触发客户端升级。[自动更新与发布说明](docs/automatic-updates.md)。

2.0 系列及 Dola 修复版保留在 [历史版本](https://github.com/jiang11123/dbgzz/releases)。3.0 的操作方式以 [当前教程](docs/user-guide.md) 为准；[2.0 教程归档](docs/archive/2.0-user-guide.md) 供历史版本使用。

## 源码与构建

Electron 宿主位于 `src/`，对应的画布、Go 后端、Agent 和协议源码位于 `beeftv-source/`，无需从上游仓库取得另一个未发布分支。大型运行时和安装包通过 Releases 分发。

源码构建需要 Node.js 22、npm、Bun、Go 1.25+、支持 CGO 的 Windows C 编译器及 Agent/媒体运行时。阅读 [构建说明](docs/build-3.0.md)，普通使用者直接下载安装包即可。

```powershell
git clone https://github.com/jiang11123/dbgzz.git
cd dbgzz
npm ci
npm run rebuild
cd beeftv-source/web
bun install --frozen-lockfile
cd ../..
npm run build:beeftv
npm run build
npm run local
```

## 来源与反馈

- [来源与修改说明](NOTICE.md)、[BeefTV 许可](beeftv-source/LICENSE)、[第三方许可](beeftv-source/THIRD_PARTY_NOTICES.md)。保留原有许可和署名，不扩大上游授予的权利。
- [提交问题](https://github.com/jiang11123/dbgzz/issues)：提供版本、系统、操作步骤和脱敏截图，请勿上传密码、Cookie、API Key 或完整用户数据目录。
- 本地网关供同机客户端使用，请勿将内部端口直接暴露到公网。
