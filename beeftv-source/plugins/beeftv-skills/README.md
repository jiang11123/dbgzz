# BeefTV Skills 官方接入包

提供两个通用 Skill，以及只读的市场 MCP 连接。公共查询不需要模型 Key、投稿凭据或运行中的 BeefTV。投稿通过独立的 CLI 浏览器授权进行；MCP 不提供上传、审批或公开发布工具。

此目录是待审查的接入包源码，不代表公共目录已上架或生产服务已开放。生产地址在后端和官网完成部署、联调后才可对用户宣传。

- `plugin.json`、`mcp.json`：Agent Plugins 1.0 格式，Codex 使用。
- `.claude-plugin/plugin.json`、`mcp.claude.json`：Claude Code 适配，复用同一份 Skill。
- 仓库 `.agents/plugins/marketplace.json` 与 `.claude-plugin/marketplace.json`：各宿主的仓库来源入口。
- `skills/`：寻找技能、整理投稿的两个工作流，不打包整个社区目录。

本地构建 CLI：在仓库根目录执行 `go -C backend build -o ../.local/bin/beeftv ./cmd/beeftv`，然后运行 `.local/bin/beeftv skills help`。只读 MCP 位于 `/api/beeftv/skillhub/v1/mcp`；默认远程 HTTPS，测试时可显式指定本机市场。安装包不运行 shell hook 或 npm 生命周期脚本。

宿主校验使用其实际提供的命令：Claude Code 为 `claude plugin validate ./plugins/beeftv-skills --strict`；Codex 的清单以官方 Agent Plugins schema 和实际宿主版本为准。清单校验不等于已安装、已启用或进入官方精选目录。

规范来源：[OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins)、[Claude 插件清单](https://code.claude.com/docs/en/plugins-reference)。
