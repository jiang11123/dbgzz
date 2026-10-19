# 豆包工作台 2.0 · 多账号反代网关方案分析

> 目标：参考 chenyme/grok2api 的「多账号池 + 统一 API 网关」形态，把现有的「豆包工作站 dbgzz」升级为可被外部程序调用的豆包能力网关。
> 结论先行：**GitHub 上不存在"grok2api 的豆包版"**（没有把豆包多账号池做成成熟网关的项目），但存在 6~7 个可复用的积木；而**你自己的工作台已经具备最难的那一块**（真实浏览器 + 多账号独立登录态），所以最优路线不是"抄一个开源反代"，而是"把工作台里已有的 BrowserView 会话层抽出来，套上 grok2api 的网关外壳"。

---

## 一、先说结论：GitHub 现状

### 1.1 直接搜索的候选项目（截至本次查询）

| 项目 | 星 | 语言 | 形态 | 对我们有用的部分 | 适配度 |
|---|---|---|---|---|---|
| [chenyme/grok2api](https://github.com/chenyme/grok2api) | 7.8k | Go+React | **架构范本**：Go 网关 + React 管理台，Build/Web/Console 三套独立账号池，OpenAI+Anthropic 双协议出口 | 分层、账号池状态机、Admin 台、协议转换 | ★★★★★（只抄架构，不抄代码） |
| [wangchuxiaoji-oss/doubao2api](https://github.com/wangchuxiaoji-oss/doubao2api) | 276 | Python | **功能最全的豆包逆向**：QR 扫码登录→注入 Playwright 持久化上下文；/chat/completion 与 /samantha/chat/completion 双端点；SSE 事件表、content_type 枚举、思考链、联网搜索、文生图/视频/音乐、文件中转 | **协议字典价值最高**：完整 SSE/block_type 对照表、异步视频两段式流程、额度耗尽与风控错误码 | ★★★★★（当"协议参考手册"用） |
| [lza6/doubao-2api](https://github.com/lza6/doubao-2api) | 288 | Python/FastAPI | Playwright 生成 a_bogus 签名；多 Cookie 轮询；Docker | 最小可用的签名方案与多账号轮询雏形；README 坦白了 Playwright 重、冷启动 30–60s | ★★★☆☆ |
| [Bitsea1/doubao-free-api](https://github.com/Bitsea1/doubao-free-api) | 222 | TypeScript | LLM-Red-Team 系"free-api"套路：\`Authorization: Bearer sessionid1,sessionid2\`，逗号拼接即多账号 | **鉴权/多 token 的对外协议设计**，Node 生态与工作台同栈 | ★★★★☆ |
| [SeiShonagon520/doubao2api](https://github.com/SeiShonagon520/doubao2api) | 21 | Python | 本地浏览器常驻 + 浏览器内 fetch 桥接，多账号池热切换 + 额度自动轮换 + 三级验证码容灾 + Admin 面板(9090) + Windows 一键脚本 | **与我们思路最像的一个**：用"浏览器当会话载体"绕开签名逆向；账号池 failover 与 captcha 状态机可直接借鉴 | ★★★★★（思路同源） |
| [linyf-B/doubao-relay](https://github.com/linyf-B/doubao-relay)（仓库名已改 local-media-gateway） | 24 | Node.js | 本地网关 127.0.0.1:8787：豆包/即梦/可灵多方案账号池，OpenAI 兼容 /v1/images、/v1/videos、/v1/chat，CDP 抗风控，内置管理页；无 Docker | **最接近"豆包版 grok2api"的成品**，Node 栈，可作为网关层蓝本 | ★★★★★ |
| [abcd341501/seedance-study](https://github.com/abcd341501/seedance-study)（dola-pool） | 6 | Python | dola.com 号池 → OpenAI 兼容视频 API：cookie 文件号池 + 并发信号量 + SQLite 任务持久化 + 按 Key 日额度/并发/时长 | **号池调度与任务状态机的设计**；且明确写了"国内版 doubao.com 对 Python 客户端有风控，只跑国际版 dola.com" | ★★★★☆ |
| [giaoimgiao/Doubao-Image-Proxy](https://github.com/giaoimgiao/Doubao-Image-Proxy) | 37 | Node.js | 只做豆包生图 SSE 解析 + 跨格式转码 | 生图 SSE 的轻量参考 | ★★★☆☆ |
| [ihimily/doubao-nomark](https://github.com/ihimily/doubao-nomark) | 1.1k | JS | 无水印图片/视频下载（浏览器扩展） | 素材落盘/去水印参考 | ★★★☆☆ |
| [itsharex/doubao-api-free](https://github.com/itsharex/doubao-api-free) | 23 | Java | a_bogus 签名 / 动态 msToken / 多账号轮询，OpenAI 兼容 | 参数清单（device_id / fp / tea_uuid / web_id / msToken） | ★★☆☆☆ |

### 1.2 关键判断

1. **没有"拿来即用"的项目**。上述豆包项目全是单机、单进程、Playwright/CDP 驱动，没有一个提供 grok2api 那种成熟的号池运维（配额、并发、冷却、健康度、审计）。它们最大的价值是**协议知识**，不是代码。
2. **豆包 ≠ Grok**。grok2api 能纯 HTTP + SSO token 池，是因为 Grok 的接口没有强前端签名；豆包网页端有 \`a_bogus\` 签名 + \`msToken\` 设备指纹 + SecSDK 滑块（错误码 \`710022004\`/\`shark\`）。**纯 Cookie 池必然要做签名，签名必然要跑浏览器**——既然一定要跑浏览器，那"用你自己的 Electron BrowserView"就比"再装一个 Playwright"划算得多。
3. **你已经有最强的那块拼图**：\`src/main/account-platform.ts\` 里每个账号一个 \`persist:doubao_XX\` 分区，就是天然的独立登录态 + 独立设备指纹容器；\`src/main/canvas-bridge.ts\` 已经证明了"在页面里 fetch + 解析 SSE + 下载结果"这条链路在你的工作台里跑得通。

---

## 二、现有工作台盘点（2.0 的起点）

| 资产 | 位置 | 2.0 里怎么用 |
|---|---|---|
| 多账号独立分区 | \`src/main/account-platform.ts\`（\`persist:doubao_01\`…） | **账号池的物理载体**，直接复用，零改造 |
| 账号元数据 | \`database.ts\` → \`accounts\`(id/name/platform/note/session_name/is_logged_in/sort_order) | 需扩展：健康度、冷却、额度、最近错误 |
| 页面内执行能力 | \`canvas-bridge.ts\`（\`runInPage\` / \`page.evaluate\` 等价物） | 抽成通用 \`doubao-session\` 适配层 |
| 已有本地 HTTP 服务 | \`canvas-bridge.ts\` 监听 \`127.0.0.1:3219\`（/health、/accounts、/tasks、/tasks/:id/video） | 证明"工作台可以当本地服务"；2.0 另起一个网关端口 |
| 任务状态机 | \`CanvasBridgeStatus\`（queued→assigned→submitting→generating→downloading→completed/needs_attention/failed） | 直接复用为网关的任务模型 |
| 账号调度雏形 | \`pickAvailableAccount()\` | **需要重写**：现在硬编码"名字含'旺仔'"的账号优先，2.0 必须换成真正的策略 |
| 额度/风控识别 | canvas-bridge 内正则匹配"免费次数用完/额度不足" | 抽成统一的错误码映射表 |

**结论：2.0 不是重写，是"抽层 + 加壳"。**

---

## 三、推荐架构

\`\`\`
       外部客户端（OpenAI SDK / LobeChat / 脚本 / 你自己的 Agent）
                          │  Authorization: Bearer <LOCAL_KEY>
                          ▼
    ┌──────────────────────────────────────────────────────────┐
    │  网关层 Gateway (新增, 127.0.0.1:8788)                     │
    │  /v1/models  /v1/chat/completions  /v1/images/generations  │
    │  /v1/videos/generations  /v1/tasks/{id}  /admin/*          │
    │  ── 协议转换 · 鉴权 · 限流 · SSE 透传 ──                     │
    └──────────────────────────┬───────────────────────────────┘
                               ▼
    ┌──────────────────────────────────────────────────────────┐
    │  账号池调度 Pool Scheduler (新增)                          │
    │  健康度评分 · 加权轮询 · 冷却/熔断 · 并发信号量              │
    │  粘性会话(conversation→account) · 额度耗尽降级              │
    └──────────────────────────┬───────────────────────────────┘
                               ▼
    ┌──────────────────────────────────────────────────────────┐
    │  会话适配层 DoubaoSession (从 canvas-bridge 抽出)          │
    │  登录态探测 · 页面内 fetch(自动带 a_bogus/msToken)          │
    │  SSE 解析(content_type/block_type) · 结果下载 · 风控识别    │
    └──────────────────────────┬───────────────────────────────┘
                               ▼
        Electron BrowserView × N（persist:doubao_01 … N）
        每个账号 = 独立 Cookie + 独立设备指纹 + 真实浏览器环境
\`\`\`

### 3.1 为什么这样切

- **不做纯协议逆向**：\`a_bogus\` 是字节前端 JS 动态生成的，官方一改就废（lza6 的 README 自己列了"尚未实现纯 Python 签名"为限制）。
- **不引 Playwright**：工作台已经是 Electron，再装一个 Chromium 是纯浪费（内存 + 打包体积 + 登录态割裂）。
- **页面内发请求**：和 [SeiShonagon520/doubao2api] 同思路——在页面上下文里 \`fetch()\`，字节自己的 hook 会补 \`a_bogus\` + \`msToken\`，指纹与真实浏览器完全一致，风控面最小。
- **离线可用**：账号常驻 BrowserView，命中缓存后响应快；冷路径（未登录/掉线）才拉起页面。

### 3.2 核心数据模型（新增表）

\`\`\`sql
-- 账号池运行时状态（内存为主，落库做持久化）
CREATE TABLE account_pool_state (
  account_id   INTEGER PRIMARY KEY,
  health       TEXT    NOT NULL DEFAULT 'unknown', -- healthy | cooling | quota_exhausted | captcha | logged_out
  weight       INTEGER NOT NULL DEFAULT 1,
  inflight     INTEGER NOT NULL DEFAULT 0,          -- 当前并发
  cooldown_until TEXT,                              -- 冷却截止
  last_ok_at   TEXT,
  last_error   TEXT,
  error_count  INTEGER NOT NULL DEFAULT 0,
  daily_used   INTEGER NOT NULL DEFAULT 0,          -- 当日已用次数（按本地 0 点重置）
  daily_reset_at TEXT
);

-- 网关对外 Key（可选，做多客户端/配额时用）
CREATE TABLE gateway_keys (
  key TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
  daily_limit INTEGER NOT NULL DEFAULT 0,           -- 0 = 不限
  concurrency INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT, enabled INTEGER NOT NULL DEFAULT 1
);

-- 网关任务（生图/生视频这类异步任务）
CREATE TABLE gateway_tasks (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,          -- chat | image | video
  account_id INTEGER, api_key TEXT,
  prompt TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,                             -- queued|running|succeeded|failed|cancelled
  result TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
\`\`\`

### 3.3 账号调度策略（grok2api 的核心，必须自己写）

1. **健康度分级**：\`healthy → cooling(限流/临时错) → quota_exhausted(当日额度用尽, 次日 0 点复活) → captcha(需人工过验证) → logged_out(需重新登录)\`
2. **选号**：只从 \`healthy && inflight < maxConcurrency && now > cooldown_until\` 里按 \`weight\` 加权随机；**永不选 captcha / logged_out**。
3. **粘性会话**：同一个 \`conversation_id\`/\`user\` 尽量钉在同一账号，避免多轮上下文丢失；新会话才重新选号。
4. **失败重试**：可重试错误（限流、网络）→ 换号重试 1 次并把原账号置冷却；不可重试错误（内容审核、参数错）→ 直接返回，不换号。
5. **额度探测**：解析页面文本/SSE 错误，命中"免费次数用完/额度不足"→ \`quota_exhausted\`（次日重置）；命中 \`710022004\` → \`captcha\`，并把该 BrowserView 置顶显示给用户手动过验证（沿用 SeiShonagon520 的"第三道防线"）。
6. **并发**：每账号一个信号量（默认 1~2，豆包网页端并发高容易被风控），全局并发 = 可用账号数 × 单号并发。

### 3.4 对外接口（OpenAI 兼容 + 管理面）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | \`/v1/models\` | 暴露 \`doubao\`、\`doubao-think\`、\`doubao-expert\`、\`seedream\`、\`seedance\` 等别名 |
| POST | \`/v1/chat/completions\` | 文本/多模态，支持 \`stream:true\`（SSE 透传），支持模型别名回退 |
| POST | \`/v1/images/generations\` | 文生图 / 图生图（\`@图1\` 占位符复用工作台已有的多参考图能力） |
| POST | \`/v1/videos/generations\` | 文生视频 / 图生视频，返回 \`task_id\`（异步两段式） |
| GET | \`/v1/tasks/{id}\` | 查询任务状态与结果 URL |
| GET | \`/health\` | 账号池可用数、各账号状态 |
| GET | \`/admin\` | 管理页：账号池、实时日志、试生成、成片记录（可先做极简版） |

鉴权：\`Authorization: Bearer <LOCAL_API_KEY>\`，只监听 \`127.0.0.1\`，**默认不开公网**。

### 3.5 关键协议要点（来自 doubao2api 的逆向文档，实现时对照）

- 聊天端点：\`POST /chat/completion?aid=497858&device_platform=web&...\`（hook 自动追加 \`a_bogus\`）
- 生成端点：\`POST /samantha/chat/completion\`（图片/视频/音乐）
- 视频是**异步两段式**：先拿 \`fin_reason.async_task.id\` → 再 \`POST /samantha/chat/async/stream\` 长连接等结果（1–3 分钟）
- SSE 事件：\`2001 CMPL / 2002 ACK / 2003 FIN / 2005 ERR / 2010 VERBOSE\`
- \`content_type\`：\`2001\` 文本、\`2008\` 思考链、\`2010\` 图片输出、\`2021\` 视频输出、\`10000\` 主回答、\`10040\` 思考块
- 风控：\`710022004\` = 人机验证；\`msToken\` 存 \`.bytedance.com\` 域，必须由浏览器 hook 注入，**不要自己造**

---

## 四、落地路线图（建议按 P0→P4 迭代）

| 阶段 | 内容 | 交付物 | 预估 |
|---|---|---|---|
| **P0 抽层** | 把 \`canvas-bridge\` 里的"页面内执行 + SSE 解析 + 结果下载"抽成 \`src/main/doubao-session.ts\`；新增账号健康探测（打开账号→判断登录态/额度）；把 \`pickAvailableAccount\` 的硬编码"旺仔"策略换成可配置策略 | 单测 \`doubao-session.test.ts\`、\`account-pool.test.ts\`；\`npm run typecheck\` 通过 | 2–3 天 |
| **P1 网关骨架** | 新增 \`src/main/gateway.ts\`（\`127.0.0.1:8788\`）：\`/health\`、\`/v1/models\`、\`/v1/chat/completions\`（先非流式，再流式） | curl 能跑通对话；网关单测 | 2–3 天 |
| **P2 账号池** | 调度器（健康度/加权/冷却/粘性/重试）、\`account_pool_state\` 表、额度与 \`710022004\` 识别、掉线自动重登提示 | 多账号压测脚本：N 个账号轮转，单号超额自动切换 | 3–5 天 |
| **P3 媒体能力** | \`/v1/images/generations\`、\`/v1/videos/generations\`（复用 canvas-bridge 的提交与下载）、\`/v1/tasks/{id}\` | 端到端：prompt → 出片 → 落盘 → 返回 URL | 3–5 天 |
| **P4 管理面与打包** | \`/admin\` 极简管理页（账号池状态、日志、试生成）；\`electron-builder\` 打包；README 与免责声明 | 安装包 + 文档 | 2–3 天 |

**验收标准（每阶段）**：\`npm run typecheck\` + \`npm run build\` 必过；网关改动必须有 \`scripts/check-*.cjs\` 或 vitest 覆盖；**真实账号额度测试要手动触发，不进 CI**。

---

## 五、风险与红线

1. **封号风险**：逆向接口本身不稳定，官方改版即失效；多账号高频调用会触发风控。→ 单号并发压到 1–2，全局 QPS 设上限，默认只监听 127.0.0.1。
2. **合规**：所有参考项目都在 README 里写明"仅供个人学习研究，禁止商用/禁止对外提供服务"。**2.0 应保持"本机自用工具"定位**，不要做成对外售卖的中转站，否则既有法律风险也有被封风险。
3. **不要用 sessionid 当对外 Bearer**（doubao-relay 明确警告过）：sessionid 泄露 = 账号直接被接管。对外只发自己生成的 \`LOCAL_API_KEY\`。
4. **Electron 单进程**：所有账号共用一个主进程，BrowserView 数量多时内存会涨。建议加"空闲账号休眠"（保留分区、销毁视图，下次按需重建）。
5. **流式与长连接**：视频/深度思考会挂几分钟，网关必须处理客户端断开、SSE 心跳保活（\`: keep-alive\`），否则 Nginx/客户端会超时断开。
6. **打包体积**：\`tools/video2x\` 已经把安装包撑大了；网关层不要引入 Playwright 等重量级依赖。

---

## 六、一句话建议

> **别去 fork 一个开源豆包反代。** 把工作台现有的 \`BrowserView + persist 分区\` 会话层抽成 \`doubao-session\`，上面套一层 \`账号池调度 + OpenAI 兼容网关\`（照 grok2api 的分层，照 linyf-B/doubao-relay 的接口面），协议细节查 wangchuxiaoji-oss/doubao2api 的文档，账号池容灾思路抄 SeiShonagon520/doubao2api 和 abcd341501/seedance-study。**这条路复用你已有的最强资产，工作量集中在"调度器 + 协议转换"这两块，2 周左右可以出可用版本。**
