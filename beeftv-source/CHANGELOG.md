# Changelog

All notable public changes to BeefTV are documented in this file.

## Unreleased

- Built-in BeefAPI can be connected from the desktop app without pasting a key.
- Prepared the first audited public source snapshot.
- Added reproducible local builds, automated quality checks, and multi-architecture container publishing.
- Standardized public artifacts, runtime identifiers, documentation, and repository links on the BeefTV name.

## v2.0.2

- 支持已配置 Seedream 渠道的图层拆分和关联组图，生成结果分别保存到画布。
- 修复助手生成多图后无法检查结果的问题；整片制作暂不支持图层拆分或组图，会在生成前提示。
- 改善创作助手的任务恢复、停止与进度显示，修复读取当前画布和选择审片素材的问题。
- 参考图上传遇到临时故障时有限重试，中断后继续原上传记录。
- 修复部分外接视频渠道的多图请求，以及临时 DNS 错误导致的任务查询中断。
- 助手宽表格可在侧栏内横向滚动。
- 修复 Windows 已运行 BeefTV 时再次打开技能安装链接失败的问题；链接仍只打开指定版本的安装确认页。

已知限制：影音模型仍可能漏报剪点或写错同音词，字幕与画面需结合原片核对；助手成片的角标排版和局部文字修改仍需人工检查。

## v2.0.1

- 新增可复用的画布工作流，可编辑模板、绑定输入、选择多图结果并执行媒体处理；内置账号支持 Topaz 图片和视频超分。
- 修复任务恢复时的画布更新丢失、多图生成数量匹配和工作流取消后的任务核对，保留已生成结果与后续编辑。
- 诊断包补充跨启动记录、助手执行和素材检查，支持通过 CLI 离线分析；修复助手退出时的授权错误及跨域请求问题。
- 技能市场支持固定版本安装、文件查看、启停、回退和私人改写；作者可在客户端继续草稿，分别确认私有上传和公开送审。
- 技能链接打开指定版本的安装确认页，并显示审核摘要；文字技能无需配置多模态模型。
- 新版安装包和自动更新改用 Cloudflare R2 下载源，旧客户端保留更新入口，继续校验签名和完整文件。

已知限制：影音模型仍可能漏报剪点或写错同音词，字幕与画面需结合原片核对；助手成片的角标排版和仅修改片尾文字仍需人工检查。

## v2.0.0

- 内置助手可准备分镜、整理参考素材和生成方案，在确认后继续检查结果、剪辑和导出成片及可编辑工程。
- 新增默认多模态模型选择，用于影音审查；未配置时仍可使用其他创作工具，并明确提示无法完成的媒体检查。
- 增加参考素材读取、独立影音检查与局部修改工具，保存检查记录，便于核对结果和继续编辑。
- 技能市场支持浏览和安装固定版本；可通过网页、CLI 或外部助手准备投稿，上传和公开送审分别确认。
- 大参考素材支持分片上传和中断后继续，上传、下载、校验和保存分别显示进度。
- 修复生成结果回到画布、旧节点占用和重复下载问题；大画布导出使用原生保存入口。
- 改善剪辑预览、低帧率视频回放和竖版字幕，更新项目许可入口与第三方许可、源码说明。

已知限制：影音模型仍可能漏报剪点或写错同音词，字幕与画面需结合原片核对；助手成片的角标排版和仅修改片尾文字仍在继续验证。

## v1.7.27

- Music 3.0 默认生成 44.1 kHz、256 kbps 的 MP3；设置仅展示实际支持的格式，已有 FLAC 设置自动调整为 MP3。
- 企业音乐生成期间持续保持连接，收到完整音频后再保存；连接中断或错误内容不会被当作生成成功，也不会自动重复生成。
- 桌面更新清单和安装包使用广州 COS 下载源，安装前继续校验签名、文件大小和哈希。

## v1.7.26

- 修复开启“减少动态效果”时，删除模型渠道的确认框无法显示的问题。
- 参考图片上传失败时，准确说明本次尚未开始生成，允许稍后主动重试。
- 提交结果仍未知的任务继续保留原记录，避免把查询或取回变成重复生成。
- 深度捕捉组件下载前显示大小并等待确认，优先使用国内下载源，停顿时切换备用源；重启后由用户决定是否继续任务。
- 存储设置集中管理深度组件与参考素材对象存储，支持测试上传、读取和清理；自定义渠道可选择参考素材的传输方式。
- Midjourney 每次生成固定四张图片，四张结果分别保存，重新打开画布仍可查看。

## v1.7.25

- 生成前保存完整参数和参考素材；提交结果不确定时先查询原任务，避免重复生成。已完成结果可继续取回，并限制同时下载数量。
- 优化画布对象命名、参考素材选择和视频设置；参考视频缩略图按需加载，减少大量素材时的等待与内存占用。
- 修复模型菜单定位、明暗主题对比和提示词字号设置；环境自检补充浏览器存储与运行环境检查，诊断内容按账号隔离。
- GPT Image 2.5 开放完整质量与尺寸选项，默认使用低质量档位；成功图片可恢复原图下载，避免未完成回执覆盖结果。
- 支持连接本机及局域网模型服务，并在未设置代理环境变量时继续使用系统代理设置。
- 修复国内视频参数与水印设置，更新对象存储依赖；桌面包补齐媒体探测工具，macOS 安装镜像改进挂载兼容性。

## v1.7.24

- 修复视频未预载时长时「截取尾帧」退化为首帧的问题，解码失败自动回退拉取 H.264 播放副本并弹出截取完成提示；Windows 桌面端启用原生暗色标题栏与深色启动底色。
- 侧栏新增「更新失败排查」，支持打开日志文件夹并在诊断包中导出脱敏的 `update.log` 摘要；准备安装超时区分校验、解压和准备安装阶段。
- 历史媒体入库期间保留用户对画布节点和时间线的并发增删改；修复旧版桌面 WebView 打开画布时因数组方法兼容问题崩溃。
- 外接视频模型需显式选择协议，Sora 协议在提交前提示不支持的多素材限制，新增可复用的 JSON 视频协议；支持 BytePlus 渠道自动识别火山方舟协议与 Dreamina 视频编辑、续写和自动时长。
- H3 首尾帧、角色多视图与 Styles 模式明确比例限制提示；收起 H3 Max 中间帧入口并保留历史残留参数的清理按钮。
- 区分本机凭据错误与磁盘空间不足报错，区分请求尚未发出与提交结果未确认（409），断点续传仅在强校验匹配时复用缓存字节。

## v1.7.23

- 修复画布内旧版未入库媒体节点拦截新生成结果回写，以及点击「继续取回」闪一下又退回报错的问题；生成完成或继续取回时自动补齐画布素材绑定。
- Windows 安装向导简化为一键安装，默认创建桌面快捷方式并在完成后打开软件；直写目标目录消除杀毒软件扫描临时目录导致的“错误 32”，支持直接选盘符根目录、自动关闭运行中的旧版进程，并修复安装界面中文乱码。

## v1.7.22

- 所有视频渠道统一优先取回上游结果；下载中断或链接失效时刷新原任务链接，内置 BeefAPI 还可切换备用文件，无需重新生成。
- 修复工作流多个结果在链接更新后取错素材的问题，并按实际文件识别视频、图片和音频。
- H3 Max、Max Turbo 的时长输入支持小数秒，H3 Max 支持中间帧与参考顺序设置；修复高级设置菜单被弹层遮挡的问题。

## v1.7.21

- 视频生成完成后优先下载上游结果，减少取回等待；下载失败时自动取回同一视频的备用文件，不重新生成。
- 下载中断或长时间没有进展时及时切换备用地址；取消取回会停止当前下载。

## v1.7.20

- 新增 MiniMax H3 和 H3 Max，与 H3 Max Turbo 一起提供人民币报价。
- H3 支持 2K/4K、首尾帧和多图、视频、音频参考；前 5 张参考图免费，超过后显示按张费用。
- 修正 H3 视频请求的画面比例，关键帧视频沿用图片比例。
- 深度动作捕捉等待时间与后端保持一致，重启后恢复原任务；已生成的视频可以继续取回。

## v1.7.19

- 下载更新后只解压一次，并显示校验、保存、解压和准备安装的进度。失败时能看到原因，可以重试。
- 更新前不再把以前导入失败留下的记录当成还没保存。保存失败时可以返回处理、再试一次，或确认后继续更新；继续更新可能丢掉还没保存的修改。
- Windows 安装时如果目录被占用，会自动重试，并显示中文说明和错误码。安装失败时会尽量恢复原来的程序。
- 开启「减少动态效果」后，默认模型菜单会留在屏幕内，可以正常打开和选择。

## v1.7.18

- 新增 MiniMax H3 Max Turbo 视频模型，支持 480p、768p、1080p，显示当前人民币秒价。
- 支持首尾帧、仅尾帧和指定配音；生成结果沿用画布保存与原任务恢复。

## v1.7.17

- 修复 macOS 视频播放器点击全屏无反应的问题。
- 生成结果取回时显示进度、大小和速度，视频生成完成后的下载也会显示；下载中断会自动重试，「继续取回」不会重新生成或再次扣费。
- 结果下载完成后才放回画布，并且只更新相关节点，不会覆盖其他编辑。
- 结果长时间无法写入画布时会结束等待并提示继续取回，不再一直转圈；已生成结果的后台下载支持停止与继续。
- 批量出图时，排队等待不再消耗自动重试次数，只有真正发出的请求才计数。
- 修复 BeefAPI 视频模型被当作文本模型调用而报错的问题；模型很多时设置页和下拉不再卡顿。
- 修复部分 BeefAPI 图片模型因旧协议配置从出图列表消失的问题。
- 诊断包补齐漏掉的任务记录，并附带脱敏的模型配置摘要，便于排查默认模型和渠道删除问题。
- 画布列表、编辑器和文件夹中的删除操作都会先确认。
- 首页新增新手引导，创作入口增加「3D 导演台」和「Beef Agent」。
- 改进字幕与时间线编辑、素材分类与批量操作、模型目录刷新，以及桌面更新失败后的恢复。
- Windows 安装包可以选择安装位置；临时文件被占用时不再阻止存储迁移。
- 内置助手的旧会话保留为只读记录，继续发送消息会自动开启新会话并接上之前的内容。
- 旧会话接续后即使首轮失败、断线或重启，也会复用同一条接续会话并保留上下文。

## v1.7.16

- 音频和视频节点的字幕窗口支持云端自动转写，可读取已连接 BeefTV 账号的转写模型。
- 支持 hy-asr-3.0-preview，识别结果可编辑、保存到画布并导出 SRT；保留本地 whisper.cpp 转写。
- 转写模型与配音、音乐生成模型分开显示，避免使用不匹配的接口。
- 云端转写中断且结果不确定时不自动重复提交，避免重复计费。

## v1.7.15

- 调整工作区侧栏、画布工具与素材面板，保留主题、更新和帮助入口。
- 删除生成中节点时增加确认；切换画布或账号后，旧确认不会误删其他画布内容。
- 版本记录保留本机草稿，可预览和下载；恢复历史版本前先保留当前草稿。
- 修复素材引用菜单意外关闭、点击穿透与键盘导航问题。
- 历史视频仅在悬停或聚焦时加载预览，离开后取消下载。
- Windows 随包提供视频转码工具；无法直接播放的视频按需准备兼容预览，保留原件。
- 改善国内网络下的视频结果取回；正常线路失败后读取同一任务的备用接口，无需重新生成。
- 修复 Windows 连接、画布媒体和滚轮交互问题。
- 新增 Ubuntu 24.04 x64 桌面包，支持随包 CLI 和 MCP。

## v1.7.14

- 兼容通道的助手回复长时间没有新内容时自动尝试恢复，保留已完成操作，仍可随时停止。
- 视频节点自动显示首帧时不再改动画布，避免已准备的生成方案因此过期。
- 修复画布上按 Backspace 意外离开，以及离开或切换画布时删除内容未及时保存的问题。
- 生成方案显示未能开始的具体原因与等待状态；长任务显示已等待时间。
- 同轮多次局部编辑按各画布接续版本，恢复时保留原操作身份；外部删除与本地编辑冲突时保留本地内容并提示处理。
- 修复大画布读取被截断的问题，助手可分页读取完整节点、连线和时间线。
- 修复切换助手模型后仍使用旧模型的问题；恢复未完成轮次时继续使用原模型。
- 修复完全访问模式下工作区画布搜索错误过滤，导致找不到其他画布的问题。
- 旁白剪辑可检测实际停顿，并再次听取裁剪后的音频核对尾字与保留内容。
- 修复素材读取补齐资源后已成功，助手仍显示先前失败提示的问题。
- 删除素材记录时保留画布和历史仍在使用的资源，避免影响已有作品。
- 模型配置支持搜索选择，保留自定义服务和暂不可用的模型设置。
- 改进 BeefTV MCP 的连接状态和管理入口、侧栏收起与社交入口，并提供应用内中文更新说明。

## v1.7.13

- 连接入口改为「连接 BeefTV」，新登录授权和钱包控制台使用 beeftv.app；保留已连接企业账号。
- 创作助手支持图片、视频和音频参考、运行中补充内容与固定版本技能，并使用持久会话恢复中断工作。
- 助手可将已上传素材绑定到画布参考节点；技能选择器支持直接安装 ZIP 和 Markdown 技能。
- 内置助手可选择只读、当前画布或完全访问；跨画布编辑可整轮撤销。
- 切换助手权限后仍可读取已授权的会话素材；修复多图再次生成时新结果被旧画布覆盖的问题。
- 助手可裁剪、排列素材，添加旁白和字幕，并在本地渲染视频预览。
- 助手对话直接显示成片版本，可播放、下载，并在重开对话后恢复。
- 模型回复失败时保留已完成操作，提供继续处理入口。
- 外部 Agent 通过 MCP／CLI 使用完整业务工具，无需在 BeefTV 重复选择执行权限。
- 补齐节点移动、删除、移除连线和模型目录；修复失败更新留下安装缓存的问题。

## v1.7.12

- Seedance 2.0、2.5 统一名称，模型列表不再重复展示真人素材型号。
- 模型选择和助手生成确认显示当前报价。
- 保留旧项目的模型设置，仍可继续使用。

## v1.7.11

- 图片生成前先保存画布节点，保存冲突时停止提交，避免生成完成后找不到结果节点。
- 图片已生成但画布更新失败时保留原任务，可重新加载资源，无需再次生成。
- 修复桌面端“重新加载资源”不可用，以及恢复任务后一直显示生成中的问题。

## v1.7.10

- 真人视频模型统一显示为 Seedance 2.0-真人、Seedance 2.5-真人，模型选择、设置和名称搜索保持一致。
- API 模型 ID、价格与渠道路由保持不变。

## v1.7.9

- 新增 Seedance 2.0、2.5 真人素材版，选择模型时显示价格，标准版保留原价。
- 修复模型目录刷新、分镜工作台恢复设置时可能自动切换到不同收费档位的问题。
- 生成与重试前检查真人素材版的可用状态和报价，助手确认卡片同步显示单价。

## v1.7.8

- 修复部分视频点击预览后页面崩溃、无法播放的问题。
- 修复恢复设置时已关闭的视频声音开关被重新开启的问题。
- 修复 Windows 下载更新包后无法完成校验的问题。

## v1.7.7

- 生成前检查渠道能否读取参考素材，需要在线链接时可直接填写并继续生成，或切换渠道。
- 处理参考素材时显示准备阶段，完成后再提交生成任务。
- 修复部分视频渠道的音频、水印等开关参数导致任务无法解析的问题。

## v1.7.6

- 统一素材库、生成历史与画布素材选择的布局，改进窄窗口显示和应用加载画面。
- 上传素材后切换页面仍会完成上传，返回页面不会重复创建素材。
- 永久删除生成历史前增加确认，批量删除失败的项目可单独重试。
- 提供旧回收站素材恢复入口，保留此前归档的素材。
- 改进素材详情中的图片缩放与视频播放控件。

## v1.7.5

- 桌面更新支持断点续传与自动重试，显示下载进度、速度和剩余时间，并提供更明确的网络错误提示。
- 修复桌面端资产详情中的音视频无法播放：通过本地资源鉴权后读取媒体，重启后仍可播放已保存的作品。
- 修复视频生成完成后，相对下载地址被误判为无效地址的问题。
- 新增可由用户配置地址的全参视频协议，支持图片、视频与音频参考素材。
- 改进自定义模型目录的能力识别与加载超时。
- 修复 macOS 保存媒体时改名丢失扩展名的问题。

Windows v1.6.20–v1.6.22 的旧更新器无法识别新版目录结构，请关闭应用后手工解压新版完整安装包；保留原用户数据目录。v1.6.23 及后续版本可使用应用内更新。

## v1.7.3

- Add guided setup for OpenAI, Google Gemini, Volcano Ark and compatible model services, with searchable catalogs and manual model entry.
- Preserve selected models and explicit protocol settings when refreshing custom catalogs.
- Wait for completed generation results during model tests and preserve actionable authentication errors.
- Encrypt local provider settings, backup settings and custom task headers; omit credentials from the browser's persisted configuration cache.
- Require upgrades from released Windows installers and failed-launch rollback tests against the final Windows package before publication.

## v1.7.2

- Restore the bundled Windows MCP command-line tool and prevent MCP connections from accidentally opening another desktop window.
- Add separate Claude Desktop setup instructions and stop offering connections when installation files are incomplete.
- Keep Windows runtime discovery outside AppData so packaged MCP clients cannot reuse an old virtualized runtime file.
- Start the Windows assistant in the background without opening a Node console window.
- Explain blocked model-service addresses and DNS failures with actionable connection guidance.

- Automatically remove completed upgrade folders after the local workspace starts successfully, while preserving failed upgrades for recovery. Windows also removes its released lock file; macOS retains the empty lock for compatibility with older update helpers.

- Fix the canvas assistant being unavailable when following a default text model from a custom local channel.
- Keep explicit model capabilities, protocol restrictions, and channel credentials in effect when resolving assistant connections.

## v1.7.1

- Choose the canvas assistant model directly beside the message input.
- Start with GPT 6 Astra after connecting BeefAPI, and keep your chosen model when refreshing the catalog.
- Offer Astra, Opus 5.5, DeepSeek V4.1 Flash, and GLM 5.3 when available on the connected account.
- Save model changes before starting the next assistant request.

## v1.6.23

- Add a canvas assistant for drafting scenes, editing nodes, connecting references, and proposing image or video generation for confirmation.
- Keep assistant conversations and canvas changes recoverable across restarts, with conflict checks and per-turn undo.
- Let external agents connect through the bundled CLI and MCP using revocable read-only or read-write access.
- Share canvas operations and generation delivery across manual editing and agents, preserving original tasks during recovery.
- Unify media rendering and workspace backup paths while retaining existing projects, assets, and tasks.

## v1.6.22

- Add a director workbench for staging objects, cameras, motion paths, and shot previews.
- Keep director references and exported previews attached to the correct scene when switching or closing the workbench.
- Preserve shot prompts, camera motion, and independent paths when editing or duplicating scenes.
- Restore the canvas archive import entry in the project library.

## v1.6.21

- Keep copied media nodes on the canvas when regenerating them, including changing a copied video's resolution.
- Upload local Seedance reference media before generation, supporting large files and validating media limits before submission.
- Preserve reference dimensions and use the same media preparation path for built-in and protocol-based video generation.

## v1.6.20

- Keep media file extensions when saving or renaming downloads in the Windows file dialog, while preserving overwrite confirmation and cancellation.
- Use the actual media format for asset-library downloads, including MOV, SVG, WAV and M4A.

## v1.6.19

- Explain account quota shortages with actionable balance, token and plan guidance.
- Distinguish completed videos that could not be saved from generation failures, directing users to recover the original result without paying again.
- Preserve structured provider errors and request IDs through video creation, polling and manual result recovery.

## v1.6.18

- Continue polling the original video task after Windows socket resets or connection aborts instead of failing immediately.
- Retry interrupted media downloads without submitting a new paid generation, while preserving cancellation and retry limits.
- Explain Windows network disconnects clearly in saved task errors and include native Windows recovery regression checks in desktop releases.

## v1.6.17

- Restore the audio toggle for BeefAPI Seedance models so silent video requests explicitly disable audio.
- Repair missing task diagnostics columns when upgrading from preview databases that reused migration numbers, preserving existing projects and tasks.
- Distinguish local task storage failures from model parameter errors and explain when generation has not been submitted.
- Require two complete rounds of real generation acceptance across six image and video paths before publishing desktop updates.

## v1.6.16

- Recover transient video download disconnects using the original provider task, with bounded background recovery for supported video protocols.
- Add “取回结果” to failed video task details on the canvas and in desktop task history; query and download the original result without creating another paid generation.
- Treat lost submission receipts as unconfirmed instead of silently resubmitting; keep explicit rate limits and pre-dispatch rejections retryable.
- Show readable, sanitized task log summaries and prevent late task detail responses from reopening or replacing a different task.

## v1.6.15

- Preserve specific generation errors, request IDs, timings and bounded request history in copied diagnostics, including after reopening a task.
- Distinguish local input and response-size limits, provider failures, and errors while saving or applying generated results.
- Include task image settings, reference counts and limits without copying prompts, credentials or media addresses; preserve request evidence during background polling and clear it when retrying.

## v1.6.14

- Keep canvas task details up to date with the desktop backend while a task is running, including progress, logs and start/completion times.
- Stop detail polling after completion and cancel pending reads when closing or switching tasks; show a retry notice when details cannot be refreshed.

## v1.6.13

- Accept Windows PowerShell ZIP path separators when installing signed depth components while retaining traversal and duplicate-file protection.
- Use the configured Windows/macOS system proxy for optional depth-component downloads, matching the desktop updater and preserving explicit environment proxy/bypass settings.
- Include Windows x64 depth-video processing from v1.6.12 with signed optional runtimes. CPU inference is tested; NVIDIA CUDA support is a community testing preview with a one-time CPU fallback for device failures. First use downloads components, and CPU processing can be slow and memory intensive.
- Expand the director workspace with scene controls, camera following, aspect frames, screenshots and panorama generation history.
- Preserve director scene covers and task recovery context, and improve canvas crop and trim controls at low zoom.
- Check for desktop updates periodically and support downloading and installing from one action while saving work first.
- Prevent late uploads and screenshots from overwriting reopened director scenes; drain panorama result writers before switching workspaces.
- Stamp director cover and output edits before persistence so refreshed canvases retain their previews.
- Install the matching Chromium browser in CI and tolerate subpixel rounding in model-picker layout checks.

## v1.6.12

- Add Windows x64 depth-video processing with the fixed Small model, signed optional CPU/CUDA runtimes, resumable verified downloads, and process-tree cancellation.
- Validate CUDA with a real model probe and fall back once to CPU for device failures. CUDA hardware support is a community testing preview; CPU inference has been tested on Windows with 2-second and 15-second clips.
- Fix Windows PowerShell 5.1 runtime-builder encoding and align the worker's video-duration limit with the app.
- Serialize component installation and stop download verification and extraction when cancelled.
- First use downloads optional components; CPU processing can be slow and memory intensive. Apple Silicon Mac processing remains unchanged.

## v1.6.11

- Fix local reference images being rejected before submitting Wan 3.0 video tasks through BeefAPI.
- Share verified enterprise video contracts across the model catalog, reference validation, and request preparation; preserve explicit protocols for other models.
- Reject unsupported reference types and counts before submission, and retain actionable media guidance in task history.
- Honor installed protocol media declarations and include the shared contracts in container builds.

## v1.6.10

- Check reference-video frame rates on WhatsToken material-conversion routes, including ordinary, fragmented and mixed MP4 files.
- Explain frame-rate, unsupported-codec and asset-access errors with actionable guidance that survives task history reloads.
- Preserve authentication errors and request identifiers when formatting media errors.

## v1.6.9

- Fix built-in BeefAPI Seedance profiles selecting a package name instead of the installed video provider ID, which caused false "interface not installed" failures before submission.
- Repair existing enterprise profiles automatically and accept previously saved OpenAI Videos protocol aliases without bypassing disabled plugins.
- Verify imported and restored Seedance profiles against the shipped provider catalog and test legacy aliases through the installed plugin runtime.

## v1.6.8

- Read missing reference-video dimensions even when duration is already known, and reject unreadable or out-of-range video before submission.
- Validate local and inline video dimensions from the actual file instead of trusting stale metadata.
- Explain pixel-limit failures with the affected reference, actual dimensions and allowed range.

## v1.6.7

- Ask for confirmation before paid Seedance 2.0 standard and 2.5 reference-video generation on affected channels where the requested aspect ratio may not be honored.
- Show frame, edit and extension settings that follow the source media, and explain first-frame compatibility errors with actionable guidance.
- Preserve generated videos and show a notice when their measured aspect ratio differs from the submitted request.

## v1.6.6

- Preserve structured provider error codes when polling Seedance tasks, so temporary route outages do not ask users to change model settings.

## v1.6.5

- Preserve explicit Seedance 2.5 reference/edit/extend task intent in provider requests.
- Recognize temporary model route unavailability as an actionable provider error.

## v1.6.4

- Restore Seedance image, video and audio references for built-in BeefAPI models after catalog import and configuration reload.
- Migrate the old built-in zero-reference profile while preserving unrelated custom limits, and align Seedance submission with the Videos API.
- Recognize Seedance capabilities for OpenAI Videos model profiles in both frontend and backend validation.

## v1.6.3

- Preserve explicit first/last-frame roles and adaptive aspect ratios for Seedance 2.5, including official model aliases and BeefAPI Enterprise requests.
- Keep reference generation distinct from frame, edit and extension constraints; retain explicitly selected reference and extension modes.
- Add a supported-mode selector to the professional video canvas and explain when output parameters follow input media.
- Explain nested TaskTypeConstraint failures with actionable guidance and retain the same message and diagnostic IDs after task reload.

## v1.6.2

- Retire the unfinished built-in Agent product surface: the canvas dock, creation entry, home capability card, Agent query parameters, Agent settings and the `/agent/*` API are no longer reachable, so partially working Agent flows can no longer be entered by mistake.
- Enforce the retirement at the product boundary: generic task creation, task retry and the task worker refuse `cloud_agent`, `cloud_agent_step` and `agent_memory_compact` work instead of executing it as an ordinary paid text generation, and the periodic Agent memory compaction no longer runs in the background.
- Keep historical Agent runs, profiles, memories and tasks in place with no destructive migration.
- Manual creation and generation keep their existing authorization, quoting, approval, idempotency and cancellation behaviour on the canvas and in the creation workspace; canvas editing and connections, projects, assets, local storage, model channels, the built-in BeefAPI connection and the v1.6.0 depth workflow are unchanged. The retired Agent approval and memory endpoints are removed together with the rest of `/agent/*`.
- Remove the unused local `AgentPort` wiring, the test-only `generation.Engine`/`Deps` wrapper that had no production caller, and the unreferenced experimental `cmd/mcp` stdio entry.
- Simplify the core CI gates to the checks that guard the local product surface.
## v1.6.1

- Explain input and output moderation failures by text, image, video and audio, including copyright, privacy and counterfeit-content restrictions.
- Preserve specific failure guidance and request IDs when reloading task history; avoid attributing general moderation failures to real-person references.
- Distinguish upstream billing problems, configured usage limits, concurrency limits and model permissions, including errors wrapped in generic request codes.
- Keep uncertain submissions and unchanged moderation failures from automatically generating another request.

## v1.6.0

- Add depth action capture to the canvas video-processing menu on Apple Silicon Macs, with an optional local runtime and separately cached Small model weights.
- Download and verify depth components from the BeefTV release, with a Hugging Face fallback for model weights and visible task progress.
- Keep video first-frame posters visible until hover playback presents a decoded frame, preventing black flashes when playback starts or stops.
- Preserve current generation, reference-media, desktop-update, and task-retry contracts while integrating the new workflow.

## v1.5.9

- Validate reference image dimensions, aspect ratios, file sizes and audio/video duration using each model's configured capabilities before submitting.
- Preserve supported reference counts, resolutions and durations instead of silently dropping media or downgrading requested settings.
- Support local and inline reference audio for BeefAPI and native Ark channels, while retaining provider-specific audio-only rules.
- Show actionable reference conversion and request-size errors in both canvas nodes and task history, with safe diagnostics and no unsafe unchanged retries.

## v1.5.8

- Add a persistent light/dark switch to the workspace sidebar, with matching home, asset library, menus and settings surfaces.
- Restore canvas appearance controls with light, dark and custom modes; keep each canvas appearance independent from the workspace theme.
- New canvases follow the workspace theme unless an explicit default appearance is saved.

## v1.5.7

- Desktop update checks and downloads now use Cloudflare-hosted files, preserving signed manifests and package integrity verification.
- Publish immutable platform packages before switching the update feed, with verified downloads and protection against incomplete or older releases.
- Check Seedance reference audio total duration and explain gateway media validation failures with the affected clip and actionable limits.

## v1.5.6

- Validate Seedance reference audio/video duration before submission and preserve duration metadata for character voice samples.
- Explain material conversion failures with actionable duration limits and retain request identifiers for support.
- Keep existing task polling available and prevent unsafe resubmission while provider acceptance is uncertain.

## v1.5.5

- Desktop update checks and downloads now use the current user's static HTTP/HTTPS system proxy on macOS and Windows when no explicit environment proxy is configured.
- Keep a manual update check in the sidebar and show a retry action when checking fails, instead of hiding connection failures.
- Preserve proxy bypass rules, signed manifest verification and package integrity checks throughout redirected downloads.

## v1.5.4

- Generation failures now explain the cause and the next action across canvas nodes, task history and custom channels.
- Distinguish content moderation, account quota, provider billing, invalid parameters, rate limits, uncertain submissions and failed result downloads without guessing refunds or the offending input.
- Preserve safe error codes and request identifiers for support, including business errors returned with HTTP 200 and JSON errors inside media downloads.
- Prevent unsafe unchanged batch retries; edited prompts and reference media can be submitted as new attempts after moderation failures.
- Cover all 42 currently declared BeefAPI error codes with a shared frontend and backend regression contract.
- Improved the shared model picker with a viewport-safe, internally scrollable layout and consistent single-line model options.
- Removed redundant model icons, secondary descriptions, and stale option backgrounds from model selection UI.
- Restored native right-click paste behavior in canvas prompt editors and added regression coverage.
- Added regression coverage for generation output delivery, model picker overflow, and local generation error handling.
- Added a canonical local app update script to keep one installed BeefTV application instead of accumulating duplicate builds.

## v1.5.3

- Desktop builds show the installed version in the sidebar and check for published updates on startup.
- Signed updates can be downloaded in the app, then installed with an explicit restart while keeping local projects, assets, settings and connections.
- Pending canvas, director and timeline saves are checked before restarting; failed downloads or verification leave the current installation intact.
- Maintainers can build and publish signed macOS and Windows update packages from main. Existing installations need one manual upgrade to this version before in-app updates are available.

## v1.5.2

- Improved canvas node rendering and inline image cropping, annotation, and local redraw interactions.
- Rebuilt the recycle bin with a fixed two-row viewport, selection, recovery, and confirmed permanent deletion.
- Fixed project cover selection across media nodes and canvases, including fallbacks and centered empty placeholders.
- Added a short product demo and updated the README branding.

## v1.5.1

- Initial public BeefTV snapshot.
- Local-first AI video workspace with image, video, audio, text, asset, canvas, and model-channel workflows.
- BeefAPI remains a built-in local channel while its model catalog is discovered dynamically.
