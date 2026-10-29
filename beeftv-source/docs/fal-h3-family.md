# MiniMax H3 三款模型接入

本次按 Owner「都上吧」扩展正式 BeefAPI 模型：`minimax-h3`、`minimax-h3-max`、`minimax-h3-max-turbo`。复用 `/v1/videos` 创建、原任务查询和内容下载；目录更新后保留原默认模型与用户渠道。人民币价格由 BeefAPI 返回，客户端不再次加价或换汇。

三款均支持文生视频、首帧、尾帧、首尾帧和指定音频。H3 Max 与 Turbo 保持 1–15 秒整数、480p/768p/1080p；基础 H3 为 5–15 秒整数、480p/768p/2K/4K，2K 默认。按最新官方 schema，基础版 2K/4K 从原生 768P 放大，不标成原生高分辨率。

基础 H3 的普通参考图送往 `reference-to-video`，不会自动变成首帧。画布明确选择首帧或尾帧时走关键帧请求。多素材支持最多 9 图、3 视频、3 音频、合计 12 个；视频和音频各段 2–15 秒，各类型合计最多 15 秒。基础版关键帧与多素材参考不能混用。目录显示每秒人民币价格与前 5 张参考图免费、第 6 张起按张收费；客户端保留该报价，实际账单按提交快照结算。

H3 Max/Turbo 的另一套多素材参考接口有参考 Token 费用，本次常规生成模型不会声明此模式，也不会把参考图/视频悄悄丢掉变为普通文生视频。风格模型、训练和实时 Director 不在三款常规模型范围内。

唯一能力声明仍为 `backend/internal/providerpreset/video_contracts.json`，Go 与前端共享精确模型匹配。Go 生成与直接网页请求分别验证字段；任务恢复必须沿用原模型和任务 ID，保存和画布绑定走已有持久化流程。无需调整数据库。

官方来源：[基础 H3 接口 schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3/text-to-video)、[基础参考模式价格](https://fal.ai/models/minimax/h3/reference-to-video)、[H3 Max](https://fal.ai/models/minimax/h3-max/text-to-video/api)、[Turbo](https://fal.ai/models/minimax/h3-max-turbo/text-to-video/api)。真实验证总预算仍为 ¥20，包含此前 Turbo 验证；费用估算、企业结算与未获权限读取的供应商账单分别记录。

当前文档描述本次待合入改动，不代表新客户端包已经发布；v1.7.18 的历史验收和固定安装包不修改。
