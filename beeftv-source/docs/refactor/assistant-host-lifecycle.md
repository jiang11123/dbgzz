# 切片：助手宿主进程生命周期抽到 `assistantruntime`

把内置创作助手宿主的子进程生命周期从 HTTP handler 抽到 `backend/internal/assistantruntime`。handler 只解码请求、投影响应；bootstrap 持有 Host 的寿命。

## 边界

- 新包：`backend/internal/assistantruntime`
- 中立合同：`backend/internal/assistant` 持有 Provider / UnavailableError / reason / Fingerprint。`app` 用类型别名保留既有调用方名称；渠道选择算法仍在 `app.Service.ResolveAssistantProvider`，经函数注入运行时。
- handler：`agent_host_lifecycle.go` 变为路由适配；`RuntimeDependencies.AssistantHost` 在路由注册时注入同一实例；`agent_proxy.go` 只通过本 Host 的自有端点探测与转发。缺失 Host 时明确返回 `host_unreachable`，不得在请求里 `New` 一个随后被丢掉的监督器。
- bootstrap：`Runtime` 持有 `*assistantruntime.Host`，桌面 `Start` 拉起、`Close` 回收。父运行时是唯一的 `Close` 所有者。
- 宿主进程：`agent-host/server.mjs` 只接受监督器注入的 `BEEFTV_AGENT_PORT` 或 `BEEFTV_AGENT_LISTEN_FD`，不再默认 `:18500`。实例 nonce 由 health 校验；公开字段只回 `instance` 证明。

## 监督器所有权

- 每个 Host 绑定 `127.0.0.1:0`，生成随机实例 nonce，把监听 FD（Unix）或端口（其他平台）钉进子进程环境。
- 端点只在 `/health` 证明 `instance == sha256(nonce)[:8] hex` 之后才暴露。新构造的 Host 不能认领旧端口上任何健康监听器。
- 父进程持有生命周期管道写端；后端 SIGKILL / `Stop` 关闭该管道后，子进程 stdin EOF 并有界退出。
- 生产路径不读取 `BEEFTV_AGENT_HOST_URL` 或继承的 `BEEFTV_AGENT_PORT` 作为运行时权威。测试可调用 `Host.TestingUseOwnedEndpoint`。
- 子进程不注入 `BEEFTV_OWNER_TOKEN`。继承的宿主凭据、供应商变量与 OPENAI/Anthropic 等环境密钥在权威注入前被过滤；空白权威值会清掉继承值。PATH 保留。
- `/assistant/status` 在供应商指纹变化且子进程忙碌时返回 `host_busy`，模型 id 取正在跑的 health.Model，不得把旧模型标成新模型已就绪。
- `/assistant/status` 探测超时或失败不是空闲证据：仍在跑的子进程必须保留。显式 `POST /assistant/host/restart` 才是用户重启。
- `/assistant/cancel` 需要写权限，并在转发前解析 `canvasId`、校验画布归属。只读客户端不能中止。

## 行为保留

- 每个子进程只 `Wait` 一次
- Windows 先 `Kill`，其他平台 `SIGTERM` → 5s → `Kill` → 3s
- 配置原子写、权限 0600；`GET /assistant/host/config` 只回 `hasKey`，不回密钥
- 未配置命令或模型未解析时，启动链 `Start` 是 no-op
- 空闲且供应商指纹变化才重启；忙碌时不打断
- 随包 Node 路径按 darwin `Contents/Resources/agent-host` 与 Windows 旁路 `agent-host` 解析，不回退 PATH
- `Ensure` / `Restart` / `Stop` / `Start` / `Launch` 在 Host 生命周期锁上串行，避免互相抢到半回收的子进程
- 官方 pi SDK 固定为 `@earendil-works/pi-coding-agent` / `pi-durable` / `pi-ai` 1.2.0

## 模型请求等待与失败

`agent-host/durable-session-owner.mjs` 的默认 `stream.timeoutMs` 为 **180000 ms**；SDK `stream.maxRetries` 与 Durable `retry.maxRetries` 均为 **0**。失败或超时后不自动发送新的模型请求，因为未收到结果不表示上游没有处理或计费。已完成工具与失败记录保留；正常工具执行后的下一次模型请求仍是同一轮的正常执行，不受禁止失败重试影响。用户明确发起的新请求按原权限和预算检查执行。

OpenAI-compatible 路径的 SDK timeout 覆盖到响应头返回。收到成功 SSE 响应头后，`model-stream-idle.mjs` 仍使用独立的 **95000 ms 无进展检测**：实际文字或工具进展重置计时，心跳和空事件不重置。这不是整轮或整段回复的总时限；两个计时器不新增 UI/API 配置项，也不改变媒体工具自身超时。

Stop 继续按请求身份立即取消，不等待上述计时器。取消、断流与超时都不自动证明退款；费用未知时先核对原请求，不盲目重复调用。公开 `turn_end` 和历史中的 `model_error` / `provider_error` 只返回稳定安全文案及原 reason；上游原始错误保留在内部诊断记录，本地预算错误原因保持不变。

## 依赖

`assistantruntime` 只依赖：

- 标准库进程/文件 API
- `internal/assistant` 的 Provider 合同
- 通过 `ProviderService` / `ResolveProvider` 注入的解析函数（`*app.Service` 满足该接口，但本包不得 import `internal/app`）
- 不依赖 gin、handler、agentops

`app` 可以依赖 `assistant` 做别名；新领域包不得反向 import `app`。

组合根把同一个 Host 放进 `RuntimeDependencies.AssistantHost`，生命周期路由与代理路由拿到同一指针。两个 `Host` 不共享子进程所有权。禁止按 `dataDir` 做进程级 Host 表。

独立路由注册也不创建 Host；需要助手的调用方必须注入有明确 Close 所有者的实例。缺失时保持不可用，避免开发入口产生无人回收的子进程。

## 验证

```bash
cd backend
go test ./internal/assistantruntime ./internal/handler ./internal/bootstrap ./internal/assistant ./internal/app
```

进程夹具覆盖 restart / stop / crash、父进程 SIGKILL 后管道 EOF、多 Host 隔离、拒绝认领外部监听器、并发 Ensure/Restart/Stop，以及 HTTP 层忙碌指纹、只读/外部画布取消与重复 status/start/stop 共享同一 Host。
