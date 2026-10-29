---
name: publish-beeftv-skill
description: 当用户要求把创作方法、已有 Skill 或文件投稿到 BeefTV 技能市场，或查询本次稿件状态时使用。支持外部 Codex、Claude Code 等有终端能力的 Agent；无需运行 BeefTV 桌面应用。
---

# 整理并投稿创作方法

帮助作者整理内容、准备私有草稿并提交审核。文件投稿与对话投稿使用同一套服务，审核通过后才会公开。

1. 确定此次投稿的范围。只整理方法、必要引用和用户选定的示例，不打包整个项目、画布素材、聊天记录或账户配置。内置助手用 `skill.draft` 和 `skill.publish.prepare` 准备本地草稿，随后由产品中的确认操作继续；不要代为调用上传或送审接口。
2. 外部助手在一个明确目录中准备 `SKILL.md` 和必要文件。首版不接收脚本；发现脚本时解释缺少的能力，保留原包，不删除脚本后声称功能完整。
3. 在目录外准备 metadata JSON：name、description、license、versionLabel，及必要的 sourceUrl、requirements、showcase。优先沿用作者已明确的许可；来源或改编授权不清楚时询问作者，不自行授予开源许可。
4. 使用 `beeftv skills inspect DIRECTORY --metadata METADATA_FILE` 获取确切文件清单、contentHash 和 archiveSha256。向用户展示这些文件、说明、许可及将上传的示例。只有用户明确确认上传范围后，才继续上传。
5. 为此次投稿指定目录外的私有 `--state` 文件，不提交到 Git。运行 `authorize`，把输出的 verificationUrl 和 userCode 交给用户在浏览器授权，按返回的 interval 再 `poll`。不读取、复制或打印状态文件内的 accessToken/deviceCode；不使用模型 API Key 或桌面 Cookie。
6. 使用匹配 inspect 结果的 `upload DIRECTORY --metadata METADATA_FILE --state STATE_FILE --confirm-upload --content-hash HASH --archive-sha256 HASH`。这只生成私有草稿，不代表公开或已送审。
7. 运行 `preview --state STATE_FILE`，向用户展示作者、元信息、实际文件和示例。用户明确确认这版公开投稿后，再用对应 revision 与 previewDigest 执行 `submit --confirm-submit`。
8. 用 `status` 获取真实审核状态和回执。授权过期重新授权并继续同一状态文件；上传回执丢失时重试原请求，不创建重复草稿。预览或内容改变后需要新的对应确认。可用 `revoke` 撤销投稿授权。

命令均以 `beeftv skills` 开头。已有明确确认对同一文件和版本继续有效，不反复询问；确认不能授权其他文件、后续改版或自动通过审核。只报告服务器回执支持的状态：已上传、待确认、已送审、已发布或被退回。
