# 素材 UI 写入边界

状态：前端素材创建/项目链接/分类/文件夹/删除写入接入已有 `asset.Library` 与 `internal/project` HTTP 合同。SQLite 为已提交事实；前端只保留显示和明确未提交草稿。不是完整重构完成证明。Lead 负责 backup worker 接线。

## 权威关系

| 状态 | 权威 | 说明 |
| --- | --- | --- |
| 已提交素材 / 工作区分类 | SQLite `asset.Library` | `PUT/DELETE /assets/:id`、`GET/POST/PATCH/DELETE /asset-folders`、`PATCH /assets/folder` |
| 已提交项目素材链接 / 项目内目录 | SQLite `internal/project` | `POST /projects/:id/assets`、项目 `asset-folders` |
| 未提交编辑 | 前端草稿（`userScope` 持久，含 version 和 upsert 内容快照或删除 tombstone） | 旧 epoch 不得自动 dispatch；新用户动作进入新 epoch 才可提交。草稿不代表 SQLite 已保存 |
| 浏览器纯本地素材库 | IndexedDB 资产 cache | 无 Go 资源库时的产品路径，不是服务端保存 |

服务端回执只合并用户提交后未改过的字段。后续本地 title/tags/data/metadata 保留。`PUT` 资产上的 `folderId` 只是素材归属，不是分类名称或层级。

草稿写入按 scope 串行、入队抓不可变快照；flush 观察已结束的写失败。版本高水位在 ack 后保留，旧回执不能确认新编辑。hydrate 等待期间的内存编辑优先于旧持久稿；旧 epoch 完成的 hydrate 只恢复所属 scope 的草稿，不投影到新页面。

## 运行时分流

以现有函数为准，不凭关键词替换：

| 运行时 | 判定 | 素材写入 | 工作区分类 |
| --- | --- | --- | --- |
| 浏览器纯本地（无 Go 资源库） | `usesBrowserLocalResourceStore()` | IndexedDB 仍是产品持久路径；`projectIds` 写在本地 metadata | IndexedDB `infinite-canvas:asset-folders` |
| 桌面有后端 | `isNativeDesktopRuntime()` 且本地运行时 | `PUT /assets/:id`、`POST /projects/:id/assets`、分类/文件夹 PATCH、`DELETE /assets/:id` | `/asset-folders` 与 `PATCH /assets/folder` |
| hosted | 非浏览器本地资源库 | 同上 typed API；禁止 `saveRemoteUserDataNow` 整批覆盖 | 同上 |

`isLocalWorkspaceMode()` 仍表示本地优先产品面（路由把项目详情送到画布）。桌面也是 local workspace，不能再用它跳过项目链接、分类 API 或素材库读取。Vite+Go 与纯浏览器共用 `usesBrowserLocalResourceStore()`，分类与纯浏览器素材库仍走 IDB。

## 读取

桌面/hosted 素材库列表与选择走 `workspace-asset-read.ts`：`usesWorkspaceAssetLibraryApi()` 为真时，已保存事实来自 `GET /assets?page=` 与 `POST /assets/batch`。收藏、最近使用、项目来源、生成历史在 SQLite 用 `payload_json` 元数据与 `updated_at` 过滤后再 Limit/Offset；`favoriteTotal` / `recentTotal` / `projectCounts` / `generatedTotal` 是未归档侧栏计数，`kindCounts` / `categoryCounts` / `folderCounts` 按当前 status 统计。UI、Agent、CLI 的 `asset.list` 走同一 `UserAssetPageFilter`。浏览器缓存只做展示投影和明确未提交草稿 overlay；草稿总量与侧面计数按受影响 ID 的 canonical before/after 各算一次，不随页码变化，也不整库拉取。分页导航用未叠加的 `canonicalTotal` / `canonicalHasMore`，展示总量用 overlay 后的 `total`；page 1 extras 不另开一页。清空回收站按已归档 canonical ID 分页处理，删完再查第 1 页，遇到仍被引用或失败就停并报告剩余数量。查询失败向上抛出。没有墓碑清单时，缓存里多出的 ID 只能标成未保存可恢复草稿，不能当成服务端仍存在。`resource:` 媒体必须按当前资源路由展示，不能沿用旧进程的绝对地址。

## 入口

- `ensureCanvasNodeAsset(options)`：入口捕获 `expectedScope`（可注入，backup worker 复用）；pending key 含 `userScope` 与 `epoch`；429 等待后、HTTP dispatch 前、store 投影前同一身份。结果含 `confirmed`。桌面/托管媒体只有 `resource:` 且非 pending 才 `PUT` 并返回 `confirmed: true`；本地-only key / pending 先 `addAsset` 成可恢复 upsert 草稿再 flush，返回 `confirmed: false`、`linkedToProject: false`，不宣称素材库已保存。浏览器本地 IndexedDB 仍是产品路径。
- `persistWorkspaceAssetLink`：浏览器本地走 IDB；其余先 upsert 素材再链接项目。失败向上抛出。成功才把 `linkedToProject` 交给调用方（ensure 在 persist 返回后才标记）。回执按提交版本 ack，按字段合并。
- `persistWorkspaceAssetChanges` / `deleteWorkspaceAsset`：同一分流。脏草稿走具体 PUT/DELETE；同一 `userScope+assetId` 串行；入队 epoch 与 live 不一致则放弃 dispatch 并保留草稿。删除意图保守记录 DELETE（404 幂等），已有服务端素材改过再删也会发出 DELETE。
- `registerMaterializedLocalAsset`：现有 `localWorkspace()` 注入点保留；`putAsset` 接收 `expectedScope`。
- Assets 页分类增删改/读取走 `workspace-asset-folders.ts`，不再用 `workspaceCapabilities().local` 把桌面打进 localForage。
- 导演台全景/模型/参考图/截图：入口一次捕获 `{userScope, epoch}`；AI 全景观察守卫同一身份，A→B→A 不得只比用户名。经 `uploadImage` / `uploadMediaFile` 与 `persistDirectorLibraryAsset`（内部 `persistWorkspaceAssetLink`）提交。桌面/托管只有 `resource:` 且非 pending 才算确认持久化；浏览器本地 IndexedDB 仍是产品路径。桌面退回 IndexedDB 时 `pendingRemoteUpload: true`，保留明确草稿，不宣称已保存。参考图 `persisted` 只跟 `ensure` 的 `confirmed`；cache-only `assetId` 对同一 id 做幂等 persist，不新建第二份素材。构图回写画布后返回 `{confirmed}`，未确认不得成功 toast。封面可保留本地草稿，不走 `ensure`，不宣称素材已保存。禁止 `saveRemoteUserDataNow`。身份 epoch 只向前递增。

## 禁止

- 用 IndexedDB flush 冒充服务端已保存
- 用 `saveRemoteUserDataNow` 覆盖服务端新数据
- 新建平行 ledger / 整批 ReplaceUserAssets
- 改 `hydrateBackendGeneratedOutputs`、canvas-generation-consumer、local-workspace-repository/journal/canvas store、资源配额或 schema 12 / schema 13

## Lead 接线

backup worker 把已捕获的 `CapturedUserScope` 传入 `EnsureCanvasNodeAssetOptions.expectedScope` 与 `persistWorkspaceAssetLink`。资源上传继续用现有 `meta.expectedScope`。
