# Agent 本地剪辑与预览验收（2026-10-08）

状态：本地实现并通过下列目标测试，未提交、未部署。主任务最终完整后端 `go test -p 1 ./... -timeout 15m` 通过，exit 0；完整宿主 97 项、前端助手 62 项及构建/lint 通过，见整合验收文档。

## 已验证的用户路径

`canvas.timeline.update` 保存已有授权素材的 v2 时间线；`canvas.timeline.render` 从指定 revision 的已保存时间线建立免费本地任务；既有 FFmpeg worker 渲染；`task.get` 返回已物化的 video outputs；创建空 video 节点后，`canvas.task.bind` 使用既有绑定机制显示视频；撤销本轮恢复原时间线并移除预览节点。

真实 SQLite 测试限制为一个连接，上传实际蓝色视频源并读取渲染后的实际文件，验证 1 秒成品、非空字节、任务输入冻结、同一 operation ID 重放仅产生一个任务、回执失败时任务插入回滚、旧 revision 拒绝、未引用任务无法查询。没有请求付费生成接口。

## 关键安全与兼容规则

- Timeline 的 node-only source 由已有画布节点和 owned asset/resource 转成 canonical DirectMedia；保留 NodeID 和真实 assetId。模型给出的 assetId 不作为归属依据；新外部 URL 或未经画布授权的资源拒绝。
- 渲染创建使用 operation transaction 所绑定的 repository 和现有 task domain，避免 SQLite 单连接在事务内重新访问主数据库。没有新增任务循环。
- task.get 新增既有 outputs/resultState 投影。原生渲染保留原顶层 resourceId，同时提供 canonical video，复用 DeliverSucceededTask 物化资产。
- 空节点绑定只允许用户自己的、当前画布的、已成功的 local/ffmpeg timeline_render。普通任务原有绑定行为保持；内部 AllowEmptyVideo 不接受 JSON 输入，且 adapter 每次重新计算。
- 已有任务、已有素材、非 video 节点、外部 provider、付费类型任务、外部画布或 owner、尚未成功的任务不能使用空节点绑定分支；异常 map/slice 内容不会导致 panic。
- 撤销对多次写入同样检查 operation receipts 的完整 revision 范围以及未声明字段变化；人工改动后的文档不被整轮覆盖。

## 测试记录

在 `backend` 下：

```sh
go test ./internal/app ./internal/canvas ./internal/agentops -run 'TestCanvasRenderAtomic|TestTimelineRender|TestEmptyRenderBinding|TestAssistant' -timeout 120s
```

通过：app 4.999 秒；canvas、agentops 命中缓存（之前分别 0.451、0.500 秒）。包含真实渲染、查询、绑定、撤销和上述负例。

此前串行包测试 operations 42.024 秒、assistantturns 1.532 秒、editing 5.819 秒通过；最终 `go test ./internal/agentops -timeout 120s` 全包 32.937 秒通过，`git diff --check` 通过。并行编辑期间的一次 agentops 构建读取到尚未写入的 AllowEmptyVideo 字段，重跑后通过；早期全包并发运行受到多个测试进程争用而超时，不能据此宣称完整后端全包验收通过。

Pi：SDK 和官方兄弟包固定为 1.0.4，目标测试 42 项通过；官方 extension 装配入口保留，本次媒体转换在实际 HTTP dispatch 执行。Durable 未迁移，本文件不代表 Durable 验收。

## 尚未验证

此处只验收真实后端用户路径，没有正式桌面应用点击录像、生产读回或部署回执。前端预览使用已有 canvas video 节点能力；页面体验由主任务负责。
