# 协议插件域拆分

本切片把协议插件的 registry、包校验、安装/卸载、并发缓存和启用合同从 `internal/app` 抽到 `internal/plugins`。`app.Service` 只保留可见委托、管理员鉴权和审计。这不是完整产品重构。

## 边界

- 域入口：`backend/internal/plugins`
- 生产权威：SQLite `SystemSetting` 键 `plugin_registry` 保存已提交的 registry 记录。平台可用性与卸载时的用户状态删除走同一条 `Store.CommitPluginRegistry` 事务。
- 包字节：内容哈希寻址的文件系统 blob。新文件先 fsync 再 rename，再 fsync 父目录后才提交数据库；已存在且内容哈希一致的 blob 直接复用。Windows 上目录 `FlushFileBuffers` 的 `ERROR_ACCESS_DENIED` 可忽略，其它错误仍失败。
- 启动：先对已加载权威做结构校验（ID 非空且唯一、清单为合法 JSON、`metadata.ID` 与记录 ID 一致、来源合法、路径无穿越；同时给出路径和哈希时必须一致），再与官方包对账；候选物化成功后才提交。适配器不可用可以启动；结构损坏则失败关闭并保留原字节。
- 内存：事务成功后才把已物化的 `plugins` / `protocol.Registry` 指针发布到 live；发布本身不再做会失败的 IO。
- 导出：`Package` 与变更共用 `mutationMu`，只返回 SHA-256 与登记哈希一致的 blob。运行时执行适配器来自 registry 的 Raw JSON，不读包文件。
- 旧 `plugin_registry.json`：一次性导入源。导入后不再用磁盘覆盖数据库。文件损坏或结构无效时失败并保留字节，且不写入权威行。
- 独立文件模式：`plugins.NewRuntime` 仍可供测试使用。生产 `app.newService` 在暴露适配器前绑定 Store。
- `internal/app` 适配：类型别名、`pluginRuntime` 包装、`pluginDomain()` 委托
- 官方声明式包身份、上传自定义渠道/插件能力保持不变
- 本切片不改上游 wire payload、媒体尺寸策略、协议包 ID

## 生产调用图

`HTTP handler` → `app.Service`（鉴权/审计）→ `pluginDomain()` → `plugins.Service`（策略）→ `plugins.Runtime`（在 `mutationMu` 下 stage blob、`CommitPluginRegistry`、publishLive）。`app.newService` 用 `plugins.NewRuntimeWithStore(dataDir, plugins.NewRepositoryStore(repo))` 构造 runtime。

## 调用方迁移

新代码应依赖 `internal/plugins` 的导出类型与 `plugins.Service`。`app` 上的 `PluginView` / `InstallPlugin` / `PluginStatesForUser` 等是过渡别名和委托，不要在这里补第二份实现。

仍留在 `app` 的原因：管理员鉴权、`appendAdminAudit`、`FeatureEnabled`（系统插件对普通用户可见性的配置读取）以及生成路径对 `protocolRegistry()` 的读取。`ProviderCatalog` / `ForUser` 由 `plugins.Service` 拥有；app 只做功能开关适配和类型别名。

## 下一阶段仍在 app 的依赖

- `protocolRegistry` / `canonicalProtocolID`：生成与渠道设置仍从 `app.Service` 读 registry
- `PluginsForUser` 薄门面：`FeatureSystemPlugins` 仍在 app/platform，过滤算法在 `plugins.Service.ForUser`
- HTTP handler、`RequireAdmin`、管理员审计
- `generation.OfficialPluginPackageDir` 与 `LoadOfficialFallbackRegistry`：官方包目录和启动回退 registry 仍在 generation，plugins 只调用目录解析
- 前端内置应用插件（Eagle、审美批改、编辑器壳等）本身仍不由协议 runtime 装载，只走管理策略
- bootstrap / localapp 仍通过 `app.NewLocal` 构造 runtime；本切片只把生产初始化绑到 Store

## 合同收紧

`Runtime.mutationMu` 覆盖 registry 提交、平台/用户状态持久化和包导出。宿主每次调用都会新建 `plugins.Service`，生命周期锁必须落在持久 `Runtime` 上。`SetUserEnabled`、卸载与 `Package` 共用这把锁。

上传安装、系统插件启用、卸载都先把包字节落到磁盘（新 blob 含父目录 fsync），再在一条事务里提交 registry 与平台状态（卸载同时删除用户/平台状态），成功后才发布 live。未提交的 blob 可以暂时孤儿存在，不得删除 live 或已提交记录仍引用的包。

读不了权威数据库、遗留 registry 格式损坏或结构无效时失败关闭，不返回空成功；无效首次导入不写权威行。

`List` 按 JSON 契约拷贝 metadata。拷贝失败返回不含原 map 的安全视图，不把可变别名交给调用方。
