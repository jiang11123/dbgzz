# Skill 市场：Windows 与宿主验收

2026-10-18。测试使用隔离的 Go/Gin、SQLite 与包存储、合成作者和审核员。服务只监听回环；Windows 通过 SSH 反向端口转发访问。生产市场、真实稿件、钱包、用户项目和正式桌面安装均未修改。

## Windows 原生执行

- 系统：Windows NT 10.0.26200.0，amd64。
- CLI SHA256：`751e3be754498b930d5cc4d1506f51dab7b710a8d9582b69e1f4d8f73ac49c7c`，14,196,224 字节。合入最新 main 后重新构建，大小与 SHA256 完全相同。
- `privatefile-windows-test.exe -test.v`：`TestWindowsPublishingStateRefusesWorldReadableACL` 通过。核对当前用户所有者和受保护 DACL；放宽访问后校验拒绝。
- `skillhubcli-windows-test.exe -test.v`：五项测试通过，覆盖远端发现/显式安装、服务不可用、打包拒绝脚本/链接/私密文件、投稿确认和重试、凭据与状态隔离。
- 原生 CLI 对真实 Go 服务通过：search → show → fetch → 分别安装到 Codex/Claude Code 项目目录 → inspect → authorize → 合成作者批准 → poll → upload → preview → submit → 相同请求重试 → 独立审核员批准 → 已发布检索/下载 → revoke。
- 安装回执保持 `activated:false`。授权输出没有 deviceCode/accessToken。最终状态文件再次读回受保护 ACL。

这里验收的是 Windows 原生 CLI 和共享权限代码；没有把它表述为 Windows 桌面市场页面或新版安装包的 GUI 验收。

## Codex 原生插件与 MCP

使用当前桌面应用内置 `codex-cli 0.154.0-alpha.6.2` 的 app-server。临时副本仅替换 MCP URL 为回环测试服务；插件工作流、清单与 MCP 配置结构来自待审源码。

1. `plugin/list`、`plugin/read` 识别仓库市场与 `beeftv-skills`。
2. 在唯一测试市场安装插件，退出该宿主进程后，启动新进程与临时会话。
3. `mcpServerStatus/list` 返回服务版本 1.0.0 和恰好三个只读工具。
4. 通过宿主 `mcpServer/tool/call` 实际调用 `skill_search`、`skill_get`、`skill_read_file`。
5. 固定读回 `official-storyboard-text-1.0.0`；SKILL.md 为 1,352 字节、EOF=true，正文 SHA256 与清单一致。
6. 宿主列出两个插件工作流；测试结束后执行 `plugin/uninstall` 成功。

这验证了原生插件安装、重启和 MCP 调用，没有用模型回复代替工具回执，也没有声称做过 Codex 模型自主选择技能的行为评测。Homebrew CLI 0.133.0 无法读取本机桌面版已有的 mcp_tool hook 配置；保留配置，使用桌面应用自带运行时通过。这个本机版本差异不属于市场接口失败。

## Claude Code 原生连接

Claude Code 2.1.233 使用会话级 `--plugin-dir` 和显式 `--mcp-config`，未持久安装插件。关闭测试会话的 hooks，只许可三个指定只读 MCP 工具。

- 新会话 init 回执显示插件、两个工作流和 `beeftv-skills` connected。
- 实际模型分别调用搜索、指定版本详情和 SKILL.md 读取；三次工具调用与返回值均有回执。
- 最终回答引用准确的 `official-storyboard-text-1.0.0` 及文件中的首条指令，保留 `unverified`，未调用安装或投稿。
- 起初忽略用户设置会落到已撤销的 OAuth；采用用户既有配置后通过。未改登录或模型渠道。一次验证因工具许可字符串不匹配被拒绝；改为三个精确工具名后通过，不使用跳过全部审批的参数。

## 前端交接与发布条件

官网反重力 PR #18 基于 #17，页面检查与 CI 由该 PR 提供。当前字段差异及请求方法见同目录 `skill-market-agent-access.md` 的“官网 PR #18 的接入差异”。详情矩阵需读 discovery 响应外层，不能等待原 Release 出现 compatibility 数组。

此次通过的原生连接都指向本地测试服务。生产 API、官网授权/投稿/审核、桌面确认 UI、国内网络、官网唤起和公开 CLI 下载仍须各自部署后联调；源码 PR 与这些交付分别记录。

官方机制参考：[OpenAI 插件包](https://developers.openai.com/plugins/build/plugins)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude Code 插件](https://code.claude.com/docs/en/plugins)。
