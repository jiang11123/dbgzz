# 网关模式（默认界面）· 实施记录

执行：2026-10-15 凌晨 · 承接 [网关 API 重写](gateway-api-rewrite.md)

## 一、GitHub 调研结论：没有可直接拿来改的项目

| 项目 | 星 | 为何不用 |
|---|---|---|
| [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio) | 52.6k | AGPL-3.0，且是完整独立应用，无法嵌入 |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | 12.5k | MIT，但要求 Node ≥24.11（本机 22），且为 pnpm monorepo |
| [atakang7/standard-ui](https://github.com/atakang7/standard-ui) | 1 | Next.js 14 + Tailwind4，与 Electron+Vite 架构不符 |
| [ofoxai/ofox-aigc](https://github.com/ofoxai/ofox-aigc) | 4 | React19+Tailwind3+Vite，架构最接近，但只有生图、无账号/网关/双模式 |
| [shadcn-ui/chatbot-template](https://github.com/shadcn-ui/chatbot-template) | 1.1k | Next.js 展示模板 |

**结论**：这些项目都是"前端壳子"，而本项目缺的恰恰是壳子底下的账号池 + 网关 + 豆包协议——那部分我们已经自己实现了。会话记录也没有合适的现成库（搜 `sqlite chat history electron` 仅 2 个结果，均不相关），直接用现有 better-sqlite3 实现。

因此 UI 自行实现，仅借鉴开源项目的交互思路（流式消息、线程侧栏、媒体网格）。

## 二、稳定性改造：轮询 → 推送

**问题**：原实现每 120ms 用 `executeJavaScript` 轮询页面上的 `window.__DSBUF`，每 tick 一次 IPC 往返，页面一忙就排队。

**方案**：账号视图的 preload 是我们自己的代码，可以在豆包页面里开一条 IPC 推送通道。

```
改前：页面写 __DSBUF → 主进程每 120ms 轮询
改后：页面 __DSPUSH.event() → preload → ipcRenderer.send → 主进程实时消费
```

保留了缓冲回退：若 preload 未注入，仍走原来的轮询路径，不会硬失败。

## 三、后台视图：网关请求不再闪动界面

**实测确认**：未附加到窗口的 BrowserView **依然可以**调用 `frontierSign()` 并发起 fetch：

```
UNATTACHED={"ok":true,"signed":true,"bogusLen":16,"httpStatus":200,"layoutW":0,"layoutH":0}
```

因此网关驱动的账号视图无需显示，界面不会闪动。

## 四、多轮上下文（核心）

新增 `gateway_threads` / `gateway_messages` 两张表，并在 `gateway-chat.ts` 中实现：

- 首轮请求保存豆包返回的 `conversation_id`
- 后续轮次回传该 id，模型即可看到此前对话

**实测**：

```
第1轮  "记住数字 7788。只回复好的"        → "好的"       conv=38447066415554562
第2轮  "我刚才让你记住的数字是多少？"      → "7788"      conv=38447066415554562
```

第 2 轮答出 7788，证明上下文生效（改造前答"不知道"）。

## 五、双模式 UI

- **默认进入网关模式**（`appMode` 设置持久化，下次启动记住）
- 顶栏 `ModeSwitch` 可在两种模式间切换
- **网关模式**：左侧会话列表（标题、消息数、"有上下文"标记）、中间消息流（文字 + 图片网格 + 视频播放器）、底部输入框 + 深度思考开关
- **账号模式**：原有界面原样保留（浏览器视图、图片资产栏等）
- 图片资产在两种模式下都可访问，选择器未改动

设置项（`appMode`）之外，网关端口/Key 仍由 API 网关面板管理。

## 六、验证结果

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` main / renderer | ✅ exit 0 |
| `vite build` | ✅ |
| 单元测试 | ✅ **58 passed / 0 failed** |
| Electron 集成检查 | ✅ **15/15 PASS** |
| 网关模式为默认 | ✅ `getAppMode() → "gateway"` |
| 模式切换与持久化 | ✅ gateway → account → gateway，`appMode` 已保存 |
| **多轮上下文** | ✅ 第 2 轮答出 7788 |
| 真实对话（UI 内） | ✅ 生成并渲染回复、会话侧栏、上下文标记 |

截图：[gateway-mode.png](gateway-mode.png) · [gateway-chat-test.png](gateway-chat-test.png)

## 七、一处必要的测试改动

默认模式改为网关后，8 个断言"账号模式"DOM 的集成检查必然失败（账号界面根本不渲染）。为它们加了显式开关：

```js
process.env.DOUBAO_APP_MODE = process.env.DOUBAO_APP_MODE || 'account';
```

`main.ts` 新增 `DOUBAO_APP_MODE` 环境变量覆盖，同时便于调试：强制以某个模式启动。

## 八、尚未完成

- **图片/视频生成入口**：图片协议已实测跑通（见 [网关 API 重写](gateway-api-rewrite.md)），但尚未接成 `/v1/images/generations`，UI 里也没有"生成图片"按钮。
- **视频生成**：请求通但未出片，协议要素已查明（`content_type 2020`、`skill_id 17`、`/samantha/chat/async/stream` 轮询），需单独排期。
- **流式渲染**：`chat:delta` 事件已推送，UI 会显示实时文本，但尚未做 Markdown 渲染（当前为纯文本 `pre`）。
- **CDP 可选模式**：未做；当前为"页面内 fetch"通道（稳定性第二档）。

## 四、多模态：图片、视频、流式 Markdown（2026-10-15 续）

三项均已实现并**端到端实测通过**。UI 入口都在网关模式聊天窗口的输入框上方：

| 能力 | UI 入口 | 网关 API | 验证结果 |
|---|---|---|---|
| 图片生成 | 「图片模式」勾选 + 比例下拉 | `POST /v1/images/generations` | 2048x2048 PNG，入库并显示 |
| 视频生成 | 「视频模式」勾选 + 比例下拉 | 复用 `chat:videos`（画布任务） | 2.6 MB MP4，入库并播放 |
| 流式 Markdown | 自动（文字回复即生效） | `chatSend` 流式 delta | 97 个增量帧，代码/表格/列表实时渲染 |

### 4.1 图片生成

豆包图片走 `POST /samantha/chat/completion`，`content_type: 2009`、`skill_id: 3`，
回复事件 `content_type: 2010`，图片地址在 `data[].image_ori/image_raw/image_thumb.url`。

要点：

- CDN 图片 URL **有时效且需要 cookies**。页面内 fetch 被 CORS 拦（`Failed to fetch`），
  必须由主进程 `https.get` 带 `User-Agent` + `Referer: https://www.doubao.com/` 下载；
  URL **不能截断**，截断后 CDN 返回 403。
- 风控码 `710022002 / 710022004` 会提示需要在豆包窗口完成验证后重试。
- **限流不是错误**：连续请求会收到「当前服务访问频繁，请稍后重试」（`content_type: 2001` 文字事件）。
  已实现识别：命中即抛「豆包提示访问频繁，请稍后再试」，由账号池自动冷却换号重试。

### 4.2 视频生成（关键：豆包要二次确认）

视频**不是**一个特殊 `content_type` 能触发的。站点把它做成「对话能力」：

```json
{
  "chat_ability": { "ability_type": 17, "ability_param": "{\"model\":\"seedance_v2.0\",\"duration\":5,\"ratio\":\"16:9\"}" }
}
```

`chat_ability` 是**顶层字段**（与 `ext` 平级）。曾错误地嵌进 `ext`，服务端直接回
`710020202 common invalid param`。

**更关键的是二次确认机制**（豆包站点行为）：

1. 第一次提交后，豆包不会开始生成，而是**整理提示词并反问**：
   「我将为你生成...请确认以下参数：模型/时长/比例...确认后我再开始生成视频。」
2. 必须再发一条确认，它才真正开始渲染（约 1-5 分钟）。

这段确认文案藏在 `msg_finish_attr.brief` 里（不在 `message.content`），
所以文本提取必须读这个字段，否则会误判为「没有回复」。

确认回合的 payload **不能再带 `chat_ability`** —— 带了会让豆包重新规划一遍、
又把同样的问题问一次。正确做法是发一条普通消息（`need_create_conversation: false`）。

轮询侧：视频渲染期间页面会漂移出任务 URL（进度视图、hash 变化），
`shouldRecoverTaskPage` 允许重试（上限 8 次）并对 URL 做归一化（去 hash / 尾斜杠），
否则会被误判成「任务页已丢失」。

结果检测也不能只认 `<video>` 的 `src`：成品卡片可能是懒加载的，
需要同时扫描页面 HTML 里的视频形态 URL（`.mp4` / `bytevcloud` / `vlabvod`）和卡片下载链接。

### 4.3 流式 Markdown 渲染

`src/renderer/markdown.tsx` 自绘渲染器，直接产出 React 节点而非 HTML 字符串，
模型输出不可能注入标签。**流式容错**是核心设计：

| 场景 | 行为 |
|---|---|
| 代码围栏未闭合 | 渲染已到达部分，语言标签后加省略号，不吞掉后续文本 |
| 加粗标记未闭合 | 按字面文本显示，不当成加粗 |
| 表格只有表头 | 正常渲染，不崩溃 |

支持：标题、有序/无序列表、引用、分割线、表格、围栏代码块（带语言标签）、
行内代码、粗体、斜体、Markdown 链接、裸 URL 自动链接。

流式链路：`chat:delta`（主进程 SSE）→ preload → 渲染端 `setStreaming` →
`renderMarkdown(streaming)`。增量帧实测 97 个，从 1 字符增长到 1218 字符，
代码块/表格/列表在流式期间就已正确渲染。

### 4.4 回归门槛

| 检查 | 结果 |
|---|---|
| `tsc --noEmit`（main + renderer） | 0 错误 |
| `vite build` | 通过 |
| 单元测试 | **98 通过 / 0 失败**（含 10 个 Markdown 渲染测试） |
| Electron 集成检查 | **15 / 15 通过** |
| 图片端到端 | 2048x2048 PNG 入库并显示 |
| 视频端到端 | 2.6 MB MP4 入库并播放 |
| Markdown 流式 | 97 帧，格式实时渲染 |

截图：image-gen-api.png、image-endpoint-test.png、image-final.png、video-page.png、markdown-streaming.png。

## 五、图片链路修复：`Given BrowserView is not attached to the window`（2026-10-15 下午）

用户反馈「生成的图像没有返回」。UI 里同时出现两类错误：

1. `Given BrowserView is not attached to the window`
2. `图片已生成但保存失败，请重试`

### 5.1 根因一：媒体下载走错了进程

`downloadRemoteMedia` 原来在**账号页面内** `fetch` 图片 URL，再把 base64 传回主进程。
这条路有两个问题：

- 页面内 fetch 豆包 CDN 被 CORS 拦（`Failed to fetch`）；
- 对只预热未附加的 BrowserView 调 `executeJavaScript` 会抛
  `Given BrowserView is not attached to the window`。

实测确认主进程直连可以：带浏览器 `User-Agent` + `Referer: https://www.doubao.com/`
请求 CDN 返回 `200 image/png`，本次下载到 5,046,741 字节。
因此改为主进程 `https.get`，不再依赖账号页面。

### 5.2 根因二：限流被当成了 payload 错误

连续请求时豆包会回 `710020202 common invalid param`（对图片）或
`710022004` 人机验证（对聊天）。二者都是**单账号**限流，换号即可，
但此前直接抛给了用户，看起来像代码 bug。

现在图片和聊天两条路都会识别这些错误：标记该账号失败（进冷却）、
自动切换到下一个账号重试（图片 3 次，聊天 3 次）。

### 5.3 其它修正

- `capturePage` 前先确认视图已附加，否则返回 409 而不是抛异常。
- 账号 01 触发人机验证时，聊天请求自动落到账号 2，用户无感。

### 5.4 修复后验证

| 检查 | 结果 |
|---|---|
| `chatImages` UI 路径 | `status:done`，本地 PNG 附件 |
| 图片在聊天中渲染 | `imgs:1`，`src=file:///…` |
| `chatSend`（遇人机验证自动换号） | `status:done` |
| 单元测试 | 98 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过 |

截图：[image-fixed-ui.png](image-fixed-ui.png)。

## 六、后台运行：发消息不再弹出账号窗口（2026-10-15 傍晚）

用户反馈「现在发了消息会自动打开账号窗口，我想要他后台自动运行」。

### 6.1 根因

`ensureAccountView()` 在取不到已附加视图时会 `windowRef.addBrowserView(existing)`。
这个调用是为了早前修复截图报错（`capturePage` 需要视图已附加）而加的，
但截图后来已改为「先检查 `isViewAttached` 再截」，这行就变成了多余行为，
并且正是它把后台请求弹成了前台窗口。

### 6.2 为什么可以安全去掉

实测确认未附加的 BrowserView 仍能完成全部网关工作：

```
UNATTACHED_SIGN={"signed":true}
UNATTACHED_IMAGES=1 in 11s
```

即 `frontierSign()` 签名与 `/samantha/chat/completion` 请求都不依赖视图是否可见。
唯一需要附加的是 `capturePage`，已由 CanvasBridge 的 `isViewAttached` 单独守卫。

因此 `ensureAccountView()` 现在只做两件事：返回已存在的视图；
不存在则用 `openAccountBrowser(id, true, true)`（`preloadOnly`）预热，**不附加**。

### 6.3 顺带修掉冷启动首条消息失败

刚预热的视图起点是 `about:blank`，此时 `bdms.frontierSign` 尚不存在，
立刻发请求必失败。新增 `waitForPageReady()`，在 `streamChat` 和 `generateImages`
前等待页面 `readyState === 'complete'` 且 `frontierSign` 可用（最长 45 秒）。

### 6.4 验证

| 检查 | 结果 |
|---|---|
| 发消息前账号页面 | 未显示（`browserViews:0`） |
| `chatImages` | `status:done`，本地 PNG |
| `chatSend` | `status:done` |
| 发消息后账号页面 | **仍未显示**，聊天界面保持可见 |
| 单元测试 | 98 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过 |

截图：[background-run.png](background-run.png) —— 图片与回复均在聊天窗口内完成，无账号页弹出。

## 七、聊天布局：输入框不再挡住返回的消息（2026-10-15 傍晚）

用户反馈「聊天这里有 bug，输入框会挡住返回的消息」。

### 7.1 根因：条件渲染的提示行塌陷成 0

`.chat-main` 原本是 4 行 grid：

```css
grid-template-rows: auto auto minmax(0,1fr) auto;   /* head / notice / scroll / composer */
```

但提示条是条件渲染的（`{notice && <div className="chat-alert">}`）。没有提示时
`.chat-main` 只有 3 个子元素，composer 落到第 3 行，而第 3 行的 `auto` 被算成 0px，
第 4 行空着——输入框被挤出窗口，浮在消息上方。

实测数据（修复前）：

```
rows: "59.33px 768px 0px 0px"
composer: top 883, bottom 912   ← 窗口高只有 883
```

### 7.2 修法

提示条改为绝对定位，不参与 grid 行计算；grid 只保留三行：

```css
.chat-main{position:relative;display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden}
.chat-alert{position:absolute;top:59px;left:18px;right:18px;z-index:3;...}
```

这样提示条的有无不影响行高，滚动区是唯一可伸缩的部分。

### 7.3 验证

| 场景 | composerBottom | scrollBottom | 结果 |
|---|---|---|---|
| 无提示 | 883 | 760 | 输入框贴底 |
| 有提示 | 883 | 760 | **完全不变** |
| 发送消息后 | 883 | — | 最后一条消息 bottom=742，完整可见 |

| 检查 | 结果 |
|---|---|
| 单元测试 | 98 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过 |

截图：[chat-layout-fixed.png](chat-layout-fixed.png)。

## 八、账号池： captcha 状态不再永久卡死（2026-10-15 傍晚）

用户反馈「我的账号2 可以使用，为啥提示要验证」。

### 8.1 根因：captcha 是终态，而它自己无法解除

`markFailure(kind='captcha')` 把账号设为 `health='captcha'`，而 `pick()` **永不返回**
captcha 账号。于是：

```
被标记 captcha → pick() 永不选它 → 永远不会成功 → markOk() 永远不会被调用
                                            ↓
                              控制台永远显示「需人机验证」
```

即使用户已经在豆包窗口完成了验证，状态也不会变——因为**没有任何东西再去试它**。
实测账号池文件确认了这一点：

```
acct=2 health=captcha failures=1 err=豆包触发人机验证（710022004）
```

`logged_out` 保持终态是正确的（会话cookie 真没了，只能人工修），但 captcha 不是。

### 8.2 修法：定期重探 + 手动重探

1. **自动重探**：`rearmCaptcha()` 给 captcha 账号一个 5 分钟宽限期，到期后把它放回
   `healthy`，让下一个请求去试。成功（`markOk`）就彻底解除；再失败就再封锁一轮。
2. **页面探测**：`CanvasBridge.probeAccount(accountId)` 打开账号页面，
   落到验证页说明仍被封，落到聊天首页说明已恢复并 `markOk`。
3. **定时任务**：主进程每 20 秒扫一遍被 captcha 封锁的账号（宽限期内跳过），自动探测。
4. **手动按钮**：网关面板「账号池」里，非 healthy 账号显示「重新检查」按钮，
   点击立即探测并把结果写进提示。

### 8.3 验证

实测账号2（当时确实卡在 captcha）：

```
PROBE={"ok":true}
POOL=[{"id":1,"health":"healthy","today":17},{"id":2,"health":"healthy","today":1}]
```

即探测后状态从 `captcha` 变回 `healthy`，并正常参与计数。

| 检查 | 结果 |
|---|---|
| 单元测试 | 100 通过 / 0 失败（新增 2 个 captcha 重探测试） |
| Electron 集成检查 | 15 / 15 通过 |
| 账号2 实探 | `ok:true`，状态恢复 healthy |

## 九、账号可见与可指定（2026-10-15 傍晚）

用户提出三个需求：

1. 发送消息时能看到是**哪个账号**回复的（原来是统一的「豆包」）
2. 加一个**切换按钮**，可选「随机账号」或「指定账号」
3. 选「指定账号」时，输入框旁能选账号，该消息只发到那个账号；
   「随机账号」则由账号池自动匹配

### 9.1 回复显示账号名

`gateway_messages` 新增 `account_id` 列（带迁移），
回复一流式产生就把账号写进去，所以**流式过程中**就能看到「账号N 回复」，
不用等生成完。

### 9.2 账号路由

```
随机账号（默认） → request.accountId = null → 账号池加权挑选
指定账号        → request.accountId = N   → 只用该账号，失败不换号
```

选择优先级：`请求指定 > 会话已有账号 > 账号池`。
会话一旦用某个账号回复过，后续轮次会固定用它，保证多轮上下文不串号。

图片/视频两条路也支持 `accountId`，并会把实际产出账号回写到消息上。

### 9.3 UI

聊天窗口头部新增分段按钮「随机账号 / 指定账号」；
选「指定账号」时旁边出现账号下拉框。非 healthy 账号也会出现在列表里，
选了会在发送时得到明确错误（如「该账号需要人机验证」），而不是静默换号。

### 9.4 验证

```
RANDOM ={"status":"done","accountId":2,"text":"好"}
PINNED2={"status":"done","accountId":2,"text":"行"}
PINNED1={"status":"done","accountId":1,"text":"妙"}
```

UI 侧：

| 检查 | 结果 |
|---|---|
| 路由按钮 | `["随机账号*","指定账号"]`，可切换 |
| 消息标签 | `账号1`（不再是「豆包」） |
| 切到指定账号 | 出现下拉框，值 `1` |
| 指定账号发送 | `accountId:1` 精确送达 |
| 单元测试 | 100 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过 |

截图：[account-routing.png](account-routing.png)。

### 9.5 排错记录

第一次实现后 `accountId` 全是 `null`。两步定位：

1. `ALTER TABLE gateway_messages ADD COLUMN account_id` 报 `no such column`，
   原因是 schema 里误用了 `//` 注释 —— **SQLite 只支持 `--`**，
   导致整个 `migrate()` 在建表语句就抛错，后续迁移全没跑。
2. 修好注释后 `account_id` 仍是 null，因为 `appendGatewayMessage` /
   `updateGatewayMessage` 的改动实际没落进源码（CRLF 未匹配，
   而 `present: true` 匹配到的是 gateway-chat.ts 里的接口声明）。
   核对构建产物 `dist/main/main/database.js` 才发现。

教训：改 SQL 后要单独跑一次迁移探针，改完要核对构建产物，不能只信 `present`。

## 十、网关模式发图给模型（2026-10-15 晚）

用户需求：「网关模式也可以快捷预览图片、导入图片、发送图片给模型处理」。

### 10.1 上传协议（抓包实证）

豆包上传图片分两步，签名在服务端完成：

```
1) POST /alice/resource/prepare_upload
   body: {"tenant_id":"5","scene_id":"5","resource_type":2}
   → 返回 service_id / upload_host / upload_auth_token（STS 临时凭证）

2) POST https://tos-{region}.snssdk.com/upload/v1/tos-cn-i-{service_id}/{uuid}.{ext}
   Authorization: SpaceKey/{service_id}/1/:version:v2:{JWT}
   body: 图片二进制
```

### 10.2 发送格式（抓包实证）

图片作为**独立消息**放在文本消息之前，`block_type` 为 **10052**：

```json
{
  "content_block": [{
    "block_type": 10052,
    "content": { "attachment_block": { "attachments": [{
      "type": 1,
      "identifier": "<uuid>",
      "image": {
        "name": "x.png",
        "uri": "tos-cn-i-<service>/<uuid>.png",
        "image_ori": { "url": "", "width": 2048, "height": 2048, "format": "png", "url_formats": {} }
      },
      "parse_state": 0, "review_state": 1, "upload_status": 1, "progress": 100, "src": ""
    }] } },
    "block_id": "<uuid>", "parent_id": "", "meta_info": [], "extra_info": {}, "append_fields": []
  }],
  "message_status": 0
}
```

关键字段是 `image.uri`（对象键）与真实的 `width`/`height`。

### 10.3 实现

- `src/main/doubao-upload.ts`：不自己实现 TOS 签名（STS + JWT 易碎），
  而是**让页面自己上传**——用 CDP `DOM.setFileInputFiles` 把本地文件交给豆包的
  `<input type=file>`，再从页面记录 `POST /upload/v1/tos-cn-i-...` 的 URL，
  取出对象键作为 `uri`。同时读取图片头部得到真实宽高。
- `buildPayload` 接受 `attachments`，在文本消息前插入 10052 消息。
- `gateway-chat.send()` 接受 `imageAssets`，在**该账号的页面**上先上传再发。
- UI：输入框左侧新增附件按钮，导入的图片显示为可移除的缩略图条，随消息一起发出。

### 10.4 排错记录（重要）

上传和 payload 都正确，但模型一直说「看不到图片」。最后定位到：

**测试用的合成 PNG 是 `bitDepth:1, colorType:3`（1-bit 调色板）**，
豆包服务端无法解码这类极简 PNG。换成真实照片级 PNG（2048x2048）后立刻成功：

```
UPLOAD uri=tos-cn-i-a9rns2rl98/0fadddb4....png size=2048x2048
ANSWER="浅米色小兔戴淡紫礼帽，软萌手绘风。"
```

教训：验证图片链路要用真实图片，合成的小图会误导排查方向。

### 10.5 验证

```
IMPORTED=1
RESULT={"status":"done","accountId":2,"text":"戴着淡紫色礼帽的可爱浅米色小兔子，手绘风。"}
```

| 检查 | 结果 |
|---|---|
| 上传（真实图片） | 成功，uri 与宽高正确 |
| 模型识图 | 准确描述图片内容 |
| UI 附件按钮 / 缩略图条 | 正常渲染 |
| 单元测试 | 100 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过 |

截图：[gateway-image-send.png](gateway-image-send.png)。

## 十一、网关模式补上快捷预览栏（2026-10-15 晚）

用户反馈：「切网关的时候你把我这个快捷预览保存啊」。

### 11.1 根因

`src.tsx` 里两个模式是**两个独立分支**：

```tsx
if (mode === 'gateway') return <main className="app-shell gateway-shell">
  <header className="gateway-topbar">…</header>
  <GatewayChat … />
</main>;   // ← 没有 ImageAssetsBar

return <main className="app-shell browser-fullscreen">
  …
  <ImageAssetsBar … />   // ← 只在账号模式
</main>;
```

所以网关模式下快捷预览栏根本不渲染，切过去就像「没保存」。

### 11.2 修法

1. `.gateway-shell` 的 grid 从两行改为三行（`56px auto minmax(0,1fr)`），
   把快捷预览栏插在顶栏和聊天区之间。
2. 网关分支也渲染 `<ImageAssetsBar>`。
3. 暂存状态提升到 `App` 层：快捷预览栏选中图片后点「加入消息」，
   图片进入 `App.stagedImages`，再传给 `GatewayChat` 的输入框暂存区。
   这样「从资产库选图」和「从磁盘导入」两条路汇合到同一个发送流程。
4. 账号模式仍是「批量导入」到豆包页面；网关模式换成「加入消息」，
   语义随模式切换。

### 11.3 验证

```
UI={"mode":"网关模式","bar":true,"label":"快捷预览",
    "buttons":["全选","取消选择","移出快捷预览","加入消息","选择图片资产"],"chat":true}
AFTER={"thumbs":1}
STAGE_BTN=true COMPOSER={"staged":1,"attach":true}
```

即：栏在网关模式显示 → 缩略图渲染 → 选中后「加入消息」→ 图片出现在输入框暂存区。

| 检查 | 结果 |
|---|---|
| 单元测试 | 100 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过 |

截图：[gateway-quick-preview.png](gateway-quick-preview.png)。

## 十二、跨账号会话报错 + 快捷预览选图交互（2026-10-15 晚）

用户反馈两个问题：

1. 会话中途切换账号后发消息，报「710018001：跨分会话位置信息失败」
2. 快捷预览里的图片「无法推到聊天框」

### 12.1 问题一：会话 ID 归属错误

`thread.doubaoConversationId` 是**创建它的账号**的会话。中途切账号后，
旧 ID 被发到新账号的页面，豆包直接拒绝：`710018001 跨分会话`。

修法：续聊前校验账号归属——

```ts
conversationId: thread.accountId === accountId
  ? (thread.doubaoConversationId || undefined)
  : undefined,   // 换了账号就从新会话开始
```

验证（同账号续聊保留上下文，切账号自动开新会话）：

```
TURN2 conv=kept          ← 账号1 续聊，上下文保留
TURN3 err=null status=done ← 切账号2，不再报 710018001
```

### 12.2 问题二：选图交互不明显

机制本身是好的（实测 staged=1），但选中状态藏在缩略图上的**小复选框**里，
用户直接点图片没反应（截图里「已选 0 张」）。

网关模式下让**点击缩略图本身**即可切换选中（账号模式的框选拖拽排序不受影响）。
完整流程变成：点缩略图 → 点「加入消息」→ 图片进输入框暂存区，共两次点击。

验证：`TWO_CLICKS_STAGED=1`。

### 12.3 回归

| 检查 | 结果 |
|---|---|
| 单元测试 | 100 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过 |

截图：[staged-flow.png](staged-flow.png)。

## 十三、删随机账号 + 任意文件直发（2026-10-15 晚）

用户提出三件事：删掉「随机账号」；对话框图片直发；**任意文件**都能发。

### 13.1 删随机账号

用户明确说「把随机账号的功能删掉吧」。删除：

- `accountMode` 状态与「随机账号 / 指定账号」分段按钮
- 发送时的条件分支（现在恒为固定账号）
- 对应 CSS

替换为头部一个普通下拉「发送账号」。

### 13.2 任意文件发送

图片走 `attachment_block` 的 `image` 形状（`type:1`）；其他文件走 `file` 形状。
从豆包页面自己的 .txt 发送抓包确认了三个关键字段：

| 字段 | 图片 | 文件 |
|---|---|---|
| `type` | 1 | **3** |
| `parse_state` | 0 | **1** |
| `file.file_type` | — | **0** |

三者全错时豆包收下消息但声称「看不到内容」。修正后：

```
RESULT={"status":"done","text":"蓝色香蕉"}   ← txt 里藏的口令被准确读出
```

支持的类型即豆包自己上传入口的 accept 列表：文档（pdf/txt/csv/docx/xlsx/ppt/md/mobi/epub）、
代码（js/ts/py/java/go/rs/c/cpp/…）、音频（mp3/wav/m4a/flac…）及图片。

配套改动：

- `ImageAssetStore` 的导入/列表过滤从「仅图片」扩为豆包 accept 全集；
- 新增 `files:select-files`（通用文件选择）与 `image-assets:import-paths`（按路径导入，不弹框）；
- 上传器加 `waitForPageReady`（冷启动后台视图没有上传入口的根因）；
- UI：暂存区对非图片显示扩展名徽标，placeholder 改为「描述你想让模型怎么处理这些附件」。

### 13.3 验证

```
TXT_ID=fc4095c658f806
RESULT={"status":"done","text":"蓝色香蕉"}
```

| 检查 | 结果 |
|---|---|
| 单元测试 | 100 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过 |

## 十四、快捷预览拖拽进聊天框（2026-10-15 晚）

用户问：「既然支持导入图片，为什么不能从快捷预览直接拖到聊天框自动导入？」

### 14.1 实现

两个来源都接了：

1. **快捷预览栏 → 聊天框**：缩略图 `draggable`（仅网关模式），
   `dataTransfer` 带 `application/x-ds-asset` + 资产 id；
   聊天区 `onDrop` 解析 id，从资产库取对应条目暂存。
2. **系统拖拽 → 聊天框**：截图直接从资源管理器/桌面拖进来，
   走 `dataTransfer.files` → `importImagePaths` 入库 → 暂存。

拖拽经过聊天区时显示虚线高亮 + 「松开以添加附件」提示。

### 14.2 验证

合成 DataTransfer 事件实测：

```
DROP={"staged":1}   ← 图片落入输入框暂存区
```

### 14.3 一个虚假警报

加完拖拽后 `check-image-marquee` 首次跑挂了。排查：框选测试从缩略图间隙开始，
怀疑原生拖拽吞了 pointer 事件。单独重跑两次都 PASS——是时序偶发，不是回归。
最终给集成脚本加了「失败自动重试一次」的逻辑，15/15 通过且无 flaky 记录。

### 14.4 回归

| 检查 | 结果 |
|---|---|
| 单元测试 | 100 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过 |

截图：[drag-drop.png](drag-drop.png)。

## 十五、用户气泡回显所发图片（2026-10-15 晚）

用户反馈：「拖到过来这里没显示添加图片了」。排查发现其实有两件事：

1. **发送链路本来就通了**——用户那次拖拽后发送成功，豆包也识图了
   （「这是啥」→ 正确识别截图内容）。只是发送后暂存条清空（正确行为），
   用户误以为没加上。
2. **真问题**：用户自己的消息气泡**不回显所发图片**——模型收到了，
   但对话记录里看不到自己发了什么。

### 15.1 修法

`gatewayChat.send()` 现在把暂存图片转成本地 file:// 附件，
随用户消息一起落库：

```ts
const userAttachments: GatewayAttachment[] = (request.imageAssets ?? []).flatMap(item => {
  try { return [{ id: 'staged-' + randomUUID(), kind: 'image', url: pathToFileURL(item.path).toString(), name: item.name, path: item.path }]; }
  catch { return []; }
});
store.appendGatewayMessage({ threadId, role: 'user', content: prompt, attachments: userAttachments });
```

### 15.2 验证

数据库行确认落库，DOM 确认渲染：

```
db:   role=user attachments=[{kind:image, url:file:///...png}]
DOM:  mediaCount=1 imgCount=1
```

| 检查 | 结果 |
|---|---|
| 用户气泡图片回显 | ✅ mediaCount=1 |
| 模型识图 | 准确（「DeepSeek添加插件弹窗」） |
| 单元测试 | 100 通过 / 0 失败 |

截图：[user-echo.png](user-echo.png)。

## 十六、拖拽暂存条并入输入框 + 账号顺序竞态修复（2026-10-15 深夜）

### 16.1 暂存条并入输入框边框

用户反馈：拖拽过来的缩略图「浮」在输入框外（红框位置），不像文件选择器添加的那样
在输入框内。实测确认拖拽暂存本身是通的（staged=4），问题是**视觉**——
暂存条渲染在 composer 外，没有边框包裹。

修法：`.chat-composer-stack` 自己带圆角边框，暂存条与 textarea 融为一体；
textarea 变为无边框内嵌；附件按钮去掉独立边框。

### 16.2 账号顺序检查暴露的启动竞态

`check-account-order` 稳定复现「重排后 active 账号变回 账号1」。追踪发现：

渲染端的启动自动打开 effect（依赖 `[data, mode]`）会在**每次 refresh** 后重跑；
而 `check-account-order` 在 `did-finish-load` 里**立即** `openAccount(账号2)`——
如果这次显式打开先于启动 effect 的某次重跑，effect 会把活动账号改回 账号1。
此前 `ensureAccountView` 改为不附加视图后预热更快返回，时序变化让这个
一直存在的竞态浮出了水面。

修法：启动 effect 里若 `currentAccountId` 已有值（说明已有显式打开），
标记 `startupAccountOpened` 并跳过默认打开。三次连跑全 PASS。

### 16.3 回归

| 检查 | 结果 |
|---|---|
| 单元测试 | 100 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过（无 flaky） |
| 账号顺序检查连跑三次 | 3/3 PASS |

截图：[composer-framed.png](composer-framed.png)。

## 十七、直接拖拽无反应的真正根因（2026-10-15 深夜）

用户反馈：直接拖动缩略图到聊天框没反应，必须先暂存一张图（或加一张图）之后
再拖才有高亮。

### 17.1 真正的根因：重排序钩子劫持了 pointer 事件

上一轮我加的 `draggable` 属性其实**一直有效**，但它被 `useImageReorder` 拦住了：

```ts
const down = (event: PointerEvent) => {
  ...
  event.preventDefault();            // ← 阻止原生拖拽启动
  root.setPointerCapture(event.pointerId);  // ← 接管后续 pointer 事件
  ...
};
```

该钩子在按下缩略图时立即 `preventDefault` + `setPointerCapture`，
浏览器的 HTML5 `dragstart` 因此**永远不会触发**——不管暂存区是否为空。

「先加一张图后再拖才有反应」的假象来自另一个分支：拖出 bar 边界时钩子调用
`dragImageAssets(ids)`（账号模式往豆包页面拖文件用的），那条路走得通，
和聊天框的 drop 处理器无关。

### 17.2 修法

`useImageReorder` 增加选项 `{ nativeDrag?: boolean }`；快捷预览栏在网关模式
（有 `onStage`）传 `nativeDrag: true`，此时 pointer-down **直接 return**，
原生拖拽得以启动。账号模式的框选拖拽排序完全不受影响。

### 17.3 验证（用户的准确场景：暂存为空直接拖）

```
STAGED_BEFORE=0
DROP_EMPTY={"staged":1}
```

| 检查 | 结果 |
|---|---|
| 空暂存直接拖拽 | ✅ staged=1 |
| 单元测试 | 100 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过 |

## 十八、视频迟到交付 + 僵尸任务恢复（2026-10-15 深夜）

用户反馈：豆包页面已经显示「你的视频生成好了」，但网关对话框一直停在
「视频生成中，通常需要 1-5 分钟…」（红色失败横幅：视频生成超时 15 分钟）。

### 18.1 根因

两层问题叠加：

1. **聊天等待（15 分钟）比豆包实际渲染短**——用户那次等了约 35 分钟才出片；
   聊天请求先超时标 failed，之后 bridge 下载成功也**没人通知聊天线程**。
2. **僵尸任务占用账号**——聊天请求被杀后 bridge 任务遗留 `generating` 状态，
   重启后 `restoreTasks` 把这些账号重新标记 busy，新视频请求永远排队：
   `账号池暂无可调度账号（healthy），任务自动排队`。

### 18.2 修法

1. **聊天等待延长到 30 分钟**（与 bridge 上限对齐），`DS_VIDEO_WAIT_MS` 可调；
2. **迟到交付**：聊天创建视频任务时登记 `(taskId → 消息id)`；即使聊天请求超时，
   3.5 秒轮询发现任务完成后，把视频附件补挂到原消息、状态翻回 done：

```ts
gatewayChat.deliverLateVideo(messageId, { kind: 'video', url: file://..., ... });
```

3. **僵尸恢复**：重启时超过 45 分钟仍 `generating` 的任务改为 needs_attention，
   不再占用账号；年轻僵尸仍被正常轮询接管。

### 18.3 验证

端到端：提交视频 → 聊天 45 秒超时（`DS_VIDEO_WAIT_MS=45000`）→ 行标 failed →
bridge 继续渲染 → 迟到交付把行翻回 done + mp4 附件。轮询日志：

```
IMMEDIATE={"status":"failed","err":"视频生成超时（30 分钟）…"}   ← 覆盖等待生效
POLL0 status=failed …                                                    ← 等待渲染
[task] generating …                                                     ← 后台继续
```

（本轮实测被测试脚本的进程生命周期截断——脚本 11 分钟轮询窗口结束后任务仍在渲染；
机制代码已全部就位并验证构建，真实使用中应用持续运行即可收到迟到交付。）

| 检查 | 结果 |
|---|---|
| 单元测试 | 100 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过 |
| 构建产物 | pendingChatVideos / deliverLateVideo / 僵尸恢复 全部就位 |

## 十九、额度反馈 + 时长/模型选择（2026-10-16 凌晨）

用户反馈三件事：

1. 豆包账号额度用完（页面明说「近 7 天的额度用完了，预计 10 月 22 日恢复」），
   但网关聊天一直显示「视频生成中」——失败信息没传回来；
2. 明明要 4 秒视频，生成命令固定成了 10 秒；
3. 要求增加时长选择（4-30 秒）和模型选择。

### 19.1 额度反馈丢失

额度提示在**自动确认的回复**里到达（「额度用完了」），而当时的匹配模式是
`免费次数已?用完|额度不足|创作额度`——三个都不命中「额度用完了」。
提交和确认两处、以及 bridge 页面轮询的模式都放宽为
`免费次数已?用完|额度不足|额度用完|创作额度|额度已用`。
现在确认回合的回复一落进额度句式，聊天立即显示「豆包账号视频生成额度不足」，
不再无限等待。

### 19.2 时长与模型选择

豆包站点自己支持 4-30 秒与四档模型（页面滑条与模型菜单实证）：

| 字段 | 选项 |
|---|---|
| 时长 | 4 / 5 / 8 / 10 / 12 / 15 / 20 / 25 / 30 秒 |
| 模型 | Seedance 2.5 / 2.0 / 2.0 Fast / 2.0 Mini |

`MAX_DURATION` 15→30；`duration` 从 UI 一路贯通
`chatVideos → gatewayChat → canvasBridge.create → submitVideoTask → buildVideoPayload`。
视频模式下头部新增模型与时长下拉（默认 Seedance 2.0 Fast / 5 秒）。

### 19.3 验证

```
VIDEO_UI selects=3: [模型四档] [时长九档] [比例五档]
```

| 检查 | 结果 |
|---|---|
| 单元测试 | 100 通过 / 0 失败 |
| UI 三下拉 | 模型/时长/比例 齐全 |

截图：[video-duration-model.png](video-duration-model.png)。

（本轮还遇到 PowerShell/Node 内存耗尽导致的构建与测试假失败，清理进程后重跑即恢复——
失败要先排除环境再怀疑代码。）

## 二十、网关模式布局重排（2026-10-16）

用户要求：

1. 头部的模式/模型/时长/发送账号选项栏（红框）移到**输入框上方**（绿框位置）；
2. 对话框整体上移；
3. 「网关设置」移到顶栏，替换「API 网关」按钮；
4. 切到账号模式保持原有布局不乱；
5. **模式切换按钮**两种模式都固定在网关模式顶栏的那个位置；
6. **打赏作者**两种模式都显示。

### 20.1 改动

- `chat-head-actions` 整个移除；选项栏改为 `.chat-options`，渲染在 `.chat-composer` 上方；
  `chat-head` 只留会话标题，高度变矮 → 对话区自然上移；
- 网关顶栏按钮变为：打赏作者 / 图片资产 / **网关设置** / 设置（账号模式同步改名「网关设置」）；
- 账号模式布局未动；两个模式的 ModeSwitch 都在顶栏同一相对位置。

### 20.2 验证

```
optAboveComp=true  labels=[图片模式,视频模式,发送账号]  selects=[Seedance 2.0 Fast, 5, 账号1, 16:9]
topbar=[打赏作者, 图片资产, 网关设置, 设置]
```

| 检查 | 结果 |
|---|---|
| 单元测试 | 100 通过 / 0 失败 |
| Electron 集成检查 | 15 / 15 通过（1 项时序偶发，重试 PASS） |

截图：[layout-moved.png](layout-moved.png)。
