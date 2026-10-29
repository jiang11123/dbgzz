# 本地优先架构

BeefTV 的桌面构建是一个单用户、本地优先工作区。桌面端只启动一个 Wails 进程：Wails 承载前端，Go runtime 提供 loopback API 和 SQLite/本地资源目录。

## 运行边界

```text
Wails
  ├─ React/Vite 前端
  └─ Go loopback API
       ├─ workspace / projects / canvas / tasks
       ├─ local resources（SQLite 元数据 + dataDir/resources 文件）
       ├─ local task worker
       └─ configured model providers（仅在用户主动生成时访问）
```

本地模式由 `Service.NewLocal` 和 `isLocalWorkspaceMode()` 共同确定。它必须满足：

- 不注册登录、支付、财务、对象存储、SaaS 模型目录和云端分享路由。
- 不建立远程用户数据同步会话；`saveRemoteUserDataNow` 在本地模式直接返回。
- 计费采用 no-op lifecycle；任务成功、失败、取消和重试都不读取或修改计费订单。
- 素材优先写入 Go 本地资源目录；浏览器 IndexedDB 只作为服务不可用时的降级缓存。
- 本地素材选择器不枚举或写入外部插件素材源；外部模型调用仍只有在用户主动生成时发生。
- 画布、项目、素材、任务和模型配置都以本地工作区为唯一数据源。

## 数据流

1. 用户导入素材：文件写入本地资源服务，SQLite 保存资源元数据。
2. 用户编辑画布：Zustand 状态经过本地 repository 持久化到 SQLite/本地工作区文件。
3. 用户提交生成：任务进入本地队列；参考媒体先转换为本地 `resource:<id>` 引用。
4. 模型返回结果：结果写入本地资源，再由任务物化器幂等登记素材并绑定画布/项目。
5. 刷新或重启：从本地工作区和资源目录恢复，不依赖账号或云端基线。

模型供应商仍可能是外部 API，这是“生成调用出口”，不是应用数据同步。应用不会把画布、素材库或任务记录上传到 SaaS 存储。

## 模块职责

- `backend/internal/handler`：本地 HTTP 契约和路由级依赖注入。
- `backend/internal/localapp`：本地组合根；按工作区、项目、资产、任务、生成、Provider 和 Agent 端口装配。
- `backend/internal/app`：迁移期兼容适配器；新本地功能不得继续扩大这个单体入口。
- `backend/internal/repository`：SQLite 数据访问，不承载云端同步语义。
- `web/src/services/*-repository`：前端本地持久化入口。
- `web/src/services/user-data-sync.ts`：仅供 hosted profile 使用；任何调用方必须经过 `isLocalWorkspaceMode()`/`hasRemoteUserDataSyncSession()` 守卫。
- `web/src/hooks/use-external-asset-sources.ts`：本地 profile 直接返回空外部来源，防止 Eagle 等插件在素材选择器打开时发起远程读取。

## 修改守则

新增功能时先决定它属于“本地工作区”还是“托管兼容层”。本地功能不得直接调用 `user-data`、`wallet`、`payments`、`/admin` 或远程资源导入接口；需要外部模型时只通过 provider transport，不新增云端持久化。

## 验证

```bash
BEEFTV_GO_DIR=/path/to/go ./scripts/verify-beeftv-local-release.sh
BEEFTV_GO_DIR=/path/to/go ./scripts/build-beeftv-release.sh
```

浏览器验收脚本位于 `web/scripts/beeftv-local-*-audit.mjs`，覆盖路由网络边界、素材上传、刷新/重启恢复、Agent 启动和模型配置。
