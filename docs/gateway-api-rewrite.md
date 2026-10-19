# 豆包网关 · 改用官方 HTTP API（重写记录）

执行：2026-10-14 晚 · 起因：DOM 自动化方案在稳定性上走不通

## 一、为什么重写

第一版网关靠**驱动 DOM** 工作：往输入框打字、点发送按钮、抓页面渲染出来的回复。这个方案在与豆包页面的实际搏斗中暴露出一连串无法根治的问题：

| 问题 | 根因 |
|---|---|
| 提交后"未确认收到" | 输入框是 `contenteditable DIV` + 重叠 `TEXTAREA` 双层结构，打字落到了被丢弃的那一层 |
| 发送点击无效 | 发送按钮无标签、无 aria-label，且**仅在有文字时出现**，几何定位经常打到工具栏 |
| 连续请求失败 | 每轮都要重置会话以隔离上下文，重置后页面在"欢迎布局↔对话布局"间动画，坐标竞态 |
| 回复被截断 | 抓 DOM 只能拿到渲染完成的文本，且建议词会混入 |
| 慢 | 单次 3.5–35 秒，大量时间耗在等待 UI 稳定 |

## 二、参考了哪个开源项目

**[SeiShonagon520/doubao2api](https://github.com/SeiShonagon520/doubao2api)**（Apache-2.0）——读取了它的 `browser_client.py`，确认了正确做法：**不碰 DOM，直接调站内 HTTP API**。

其核心机制（本仓库据此用 TypeScript 重新实现，未复制代码）：

1. 调 `window.bdms.frontierSign(queryString)` 取 **X-Bogus 签名**
2. 在**页面内** `fetch('/chat/completion?…')` 发请求（Cookie/CSRF/设备指纹都是真实的）
3. **直接消费 SSE 流**，而不是抓渲染结果

会话隔离也变成结构性的：每次请求在 `client_meta.conversation_id` 里带自己的会话，天然不串。

## 三、本仓库的实现

新增 `src/main/doubao-api.ts`（约 400 行）+ `src/main/doubao-api.test.ts`（13 个用例）。

- `buildPayload()`：构造 `/chat/completion` 请求体（纯函数，可单测）
- `streamChat()`：页面内发起 fetch，SSE 帧写入 `window.__DSBUF[requestId]`，主进程轮询取走并解析
- `parseEvent()`：从 SSE 事件提取增量文本

跨进程流式没有走 preload/IPC，因为账号页面是**远端 origin**，页面本身够不到我们的 IPC；改为页面侧缓冲 + 主进程轮询，仍然能拿到实时增量。

### 删除的旧方案

- `src/main/doubao-session.ts`（DOM 抓取会话层，约 500 行）及配套测试
- `gateway.ts` 里两个临时调试接口 `/v1/diagnose`、`/v1/diagnose-submit`

`page-composer.ts` 保留 —— 跨账号发送与视频生成仍需要它操作**可见**页面，与网关路径无关。

## 四、实测对比

同一条"数到10"提示词：

| 方案 | 结果 | 耗时 |
|---|---|---|
| 旧（DOM） | 间歇失败，常报"未确认收到" | 3.5–35 s |
| **新（API）** | **完整正确** `1、2、3、4、5、6、7、8、9、10` | **3–6 s** |

隔离回归（12 轮，混入隔离对与普通问答）：

```
#1 PASS [4664ms] "巴黎"          #7  recall[222] 隔离OK [3651ms] "不知道"
#2 PASS [3767ms] "56"            #8  PASS [3262ms] "东京"
#3 PASS [3265ms] "好的"          #9  PASS [3905ms] "堪培拉"
#4 recall[111] 隔离OK "不知道"    #10 PASS [3140ms] "好的"
#5 PASS [3873ms] "H₂O"           #11 recall[333] 隔离OK [3889ms] "不知道"
#6 PASS [6530ms] "好的"          #12 PASS [4651ms] "12"
RESULT ok=9/12 leaked=0 errors=0
```

> 12 条全部正确（3 条 recall 按设计不计入 PASS 计数），**0 泄漏、0 错误**。

流式同样正常：`chunks=5`、`[DONE]` 正常、首个增量约 1.5–4.4 秒到达。

## 五、验证结果

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` main / renderer | ✅ exit 0 |
| `vite build` | ✅ |
| `node --test dist/main/main/**/*.test.js` | ✅ **54 passed / 0 failed** |
| Electron 集成检查 | ✅ **15/15 PASS** |
| 网关真实请求（非流式 + 流式） | ✅ 完整答案，3–6 秒 |
| 多账号会话隔离 | ✅ 0 泄漏 |

## 六、UI（已完成）

新增 `src/renderer/gateway-panel.tsx`，主窗口顶栏「API 网关」按钮打开独立面板窗口。

面板内容：

| 区块 | 说明 |
|---|---|
| 状态徽标 | 运行中 / 已停用 / 启动失败 |
| 接口地址、API Key | 一键复制 |
| 累计请求 / 默认模型 | 实时刷新（3 秒轮询 + `gateway:changed` 事件） |
| 账号池 | 每个账号的健康度、今日调用次数、冷却倒计时 |
| 设置 | 改端口 / API Key，保存并重启；启用/停用 |
| 试一句 | 面板内直接发真实请求，显示回复与耗时 |
| 实时日志 | 网关日志流 |
| 客户端接入 | 自动生成可直接粘贴的 curl 命令 |

配套 IPC：`gateway:status`、`gateway:open`、`gateway:restart`、`gateway:copy`、`gateway:changed`。

### UI 实测

面板在真实应用内打开并验证：

```
BEFORE = {"accountRows":5,"healthPills":["可用",...],"endpoint":"http://127.0.0.1:8788/v1","pill":"运行中"}
点击「发送」后
ANSWER   = "收到\n\n（3.1 秒）"      ← 真实模型回复
REQUESTS = "1"                        ← 计数器 0 → 1
账号池    = 账号3「今日 1 次」          ← 调用落到具体账号
```

截图：[gateway-panel-test.png](gateway-panel-test.png)

## 七、尚未完成

- **图片/视频生成**：`/v1/images/generations`、`/v1/videos/generations` 未做（协议已知：`/samantha/chat/completion`）。
- **深思考模式**：`doubao-think` 已映射 `need_deep_think=1`，未做端到端验证。
- **多轮上下文**：当前每次请求默认开新会话；`streamChat` 已支持传 `conversationId`，但网关层还没把多轮 `messages` 串成同一条会话。
