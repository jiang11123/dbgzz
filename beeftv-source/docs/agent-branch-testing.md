# 创作助手测试分支

本指南用于从指定 Git 提交安装测试版。测试版不会通过正式自动更新分发；安装后请先在新画布上试用。

## 可以测试什么

- 在画布右上角打开「助手」，用自然语言读取画布、批量创建节点、修改标题和提示词、连接节点。
- 在输入框左下角选择助手模型；选择会保存并用于下一轮对话，回复或切换对话期间暂时不能更换。BeefTV 连接授权成功后默认使用 GPT-6 Astra，可选目录中的 Astra、Claude Opus 5.5、DeepSeek V4.1 Flash 和 GLM 5.3；目录刷新会保留你的选择。自定义渠道仍可使用自己配置的文本模型。
- 刷新后继续对话，查看历史对话；对助手产生的画布修改使用「撤销这一轮」。画布后来被改过时，撤销会停止并保留当前内容。
- 请求图片或视频生成时，助手先显示生成提议。核对节点、模型和提示词并确认后，才会提交生成任务。
- 在设置中登记外部客户端，通过随包的 `beeftv` CLI 或 MCP，让 Codex、Claude Code、Cursor 读取或修改工作区。客户端权限在登记时选择，可在设置中吊销。

内置助手默认只修改当前画布。它不是通用电脑控制工具；外部 CLI/MCP 当前提供画布、素材和任务操作，不提供任意文件或 Shell 操作，也不直接替用户确认付费生成。

如果已选助手模型不再可用，请重新选择；助手不会自动换成其他模型。尚未单独选择时可跟随默认文本模型，但 BeefAPI 托管渠道仍只使用上述四款可用模型。模型列表读取失败时，可点击「重试更新模型列表」继续同步。

## 安装前

1. 使用交接消息中的分支和完整提交 SHA。已有仓库有改动时，新建工作树或单独 clone，不覆盖本地修改。
2. 保存工作、退出 BeefTV，备份数据目录：macOS 为 `~/Library/Application Support/BeefTV`，Windows 为 `%AppData%\BeefTV`。备份包含数据库、素材和本地配置，不能只备份可执行文件。不要把配置内容或密钥粘贴到聊天。
3. 检查 Git、Bun、Go 和编译工具。Bun 按 `web/package.json` 的 `packageManager` 安装，Go 版本按 `backend/go.mod`；macOS 需要 Xcode Command Line Tools，Windows 需要支持 CGO 的 GCC 和 WebView2。详细前置条件见[桌面构建](desktop-release.md)。
4. Agent 随包使用 **Node 24.22.1**。从 Node 官方发行源取得与目标系统、架构一致的运行时并校验官方 SHA-256。`BEEFTV_NODE_RUNTIME` 指向解压目录：macOS 下应有 `bin/node`，Windows 下应有 `node.exe`。不要指向不匹配的全局 Node。

## macOS

在仓库根目录执行，`BEEFTV_NODE_RUNTIME` 替换为本机已校验的目录：

```bash
export BEEFTV_NODE_RUNTIME="/absolute/path/to/node-v24.22.1-darwin-arm64"
export PATH="$BEEFTV_NODE_RUNTIME/bin:$PATH"
bun scripts/package-agent-host.mjs darwin/arm64 --verify-runtime
(cd web && bun install --frozen-lockfile)
./plugin-packages/build-packages.sh
./scripts/update-local-beeftv-app.sh
open /Applications/BeefTV.app
```

Intel Mac 使用 `node-v24.22.1-darwin-x64` 和 `darwin/amd64`。安装脚本会构建、验证签名并更新 `/Applications/BeefTV.app`，结束后清理中间 `.app`。无需全局安装 pi。

## Windows x64

在仓库根目录使用 PowerShell：

```powershell
$env:BEEFTV_NODE_RUNTIME = "C:\path\to\node-v24.22.1-win-x64"
bun scripts/package-agent-host.mjs windows/amd64 --verify-runtime
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-beeftv-windows-release.ps1
```

构建完成后启动 `backend\cmd\desktop\build\bin\BeefTV.exe`。需要复制到测试安装目录时，复制整个 `build\bin` 目录，保留 `agent-host`、`plugin-packages` 和 `cli`；仅复制 exe 无法运行助手。不要覆盖尚未退出的正式应用。

## 开始使用

1. 在设置中连接自己的 BeefAPI 企业账号，或配置支持工具调用的文本模型渠道。在「创作助手」中选好文本模型。测试分支不携带测试者的密钥。
2. 新建测试画布，打开「助手」，输入：

   > 请创建两个图片草案节点「雨夜咖啡馆」「窗边来客」，分别写上电影分镜提示词，把第一个连到第二个。只搭建草案，不生成图片。

3. 再输入：

   > 只把「窗边来客」改名为「雨中旅人」，其他内容保持不变。

4. 刷新或重启，确认节点、连线和对话保留。点击改名那轮的「撤销这一轮」，确认只恢复原名。
5. 要测试付费生成时，先请求「为雨夜咖啡馆提议生成一张图片」，检查提议后再确认。生成成功要以画布中的真实图片和任务结果为准；失败时保留原任务信息，不连续重复提交。
6. 测试外部 Codex 时，在设置的外部 Agent 接入处创建一个客户端，选择读写权限，使用界面给出的接入配置。凭据只保存在本机，不能发到群聊。先让 Codex 列出工具、读取这张测试画布，再做一次小范围改名并读回。测试后可吊销客户端。

遇到问题请记录：提交 SHA、操作系统、选用模型、复现步骤、截图、任务或请求 ID。安装成功、工具列表可读和真实画布修改是不同检查项，应分别记录结果。
