# 参考素材元数据审查复核

复核对象是集成提交 `9a044ca2` 中的元数据实现，再以 `607eca9f` 建立独立验证分支。以下区分源码判断、真实执行与尚未执行的平台，未消费模型额度。

## 取消与资源写锁

- `asset.EnsureMediaMetadata` 在入口和取得资源写锁后检查 `ctx.Err()`；`mediatools.ProbeLocal` 在 `Stat` 后、解析工具和创建进程前再次检查。不存在“已取消仍执行 12 秒 ffprobe”的代码路径。
- 新增 `TestAlreadyCanceledProbeDoesNotStartProcess` 使用会写启动标记的真实可执行脚本；预取消后返回 `context.Canceled`，启动标记不存在。本机 macOS 执行通过。现有 `TestProbeLocalStopsTimedOutProcess` 在 50ms 截止时间后终止实际子进程，通过。
- 写锁键由存储根、用户、资源 ID 组成。`TestMetadataLockDoesNotBlockAnotherResourceForSameOwner` 持有同用户另一资源的锁，同时完成实际 `EnsureMediaMetadata` 调用，通过。资源写锁等待本身不能立即响应取消，取得锁后会再次检查取消。
- 探测失败不会把资源写成 failed；只有检查成功才执行条件元数据 UPDATE。新增真实路由测试核对取消后资源仍为 ready、时长仍为 0、错误字段为空。
- 实际存在的小问题是 ensure 路由把未分类的 context 错误交给 `failService`，该函数统一返回 HTTP 500；没有按 GET/POST 分支，也没有此路径的 400/2001 投影。修复仅针对 ensure：取消返回 499 / `request_cancelled`，截止时间返回 408 / `timeout`。
- `TestEnsureMetadataRouteCancellationDoesNotMarkResourceFailed` 的取消和截止时间子用例均通过。`TestEnsureMetadataRouteProbesOwnedWAVOnly` 用真实 SQLite、真实本地 WAV 和原生 ffprobe 验证 owned 返回 200、时长 1000ms 已保存；foreign 返回 404 且时长保持 0。

## 播放列表网络限制

- 用启用了 http、https、tcp、tls 协议的完整系统 FFprobe 9.0.2 运行 `TestProbeLocalDoesNotFetchPlaylistURLs`，真实 HTTP 监听命中数为 0，播放列表被拒绝；不是使用假二进制。`TestProbeLocalNativeAndFailures`、`TestProbeLocalStopsTimedOutProcess` 同时通过。
- 固定 FFmpeg 8.0.1 源码提交 `894da5ca7d` 的 `libavformat/avio.c:220` 在协议不匹配显式白名单时立即返回 `EINVAL`；`:230` 仅在没有显式白名单时设置默认白名单。因此“显式 whitelist 追加到默认 http 协议”与该版本实现相反。
- 用实际构建的 Mac arm64 FFprobe 8.0.1 再次在无系统 ffprobe 的 PATH 下运行搬移验收：GUI/CLI WAV 入库、HLS HTTP 0 命中均通过。Mac 构建另关闭网络协议。
- Windows 随包完整 FFprobe 8.0.1 的原生 smoke 已增加同一真实 HLS 监听测试。当前 Mac 不能声明 Windows 原生测试通过，结果由对应原生 CI 提供。

## 更新与运行中的检查

`desktopupdate/helper.go` 先等待 `ParentPID` 退出，成功后才调用 `SwapInstall`。因此正常桌面更新中，旧应用继续受理点击检查的同时替换其运行包这一场景不可达。`TestHelperExitWhileParentAliveMakesInstallRetryable`、`TestSpawnedHelperReplacesInstall` 通过，但这些测试不等于任意手工删除运行包的压力测试。

没有据此加入可执行文件描述符、额外重试或第二套更新事务。手工删除工具仍会导致检查失败，保留素材，后续可重新检查。

## 运行记录

本机执行通过：

```sh
go test ./internal/handler -run 'TestEnsureMetadataRoute' -count=1 -v
go test ./internal/asset ./internal/mediatools -run 'TestMetadataLockDoesNotBlock|TestAlreadyCanceledProbe|TestProbeLocalDoesNotFetch' -count=1 -v
go test ./internal/desktopupdate -run 'TestHelperExitWhileParentAliveMakesInstallRetryable|TestSpawnedHelperReplacesInstall' -count=1 -v
bash scripts/test-media-runtime-macos.sh <actual-media-runtime-directory>
```

完整系统 FFprobe 的专项测试显式设置 `CANVAS_FFPROBE_PATH` 指向该工具；Mac 随包 smoke 清除此覆盖并移除 PATH 中的系统媒体工具。Intel Mac、Windows 和 Linux 安装包的原生执行状态应分别记录，不能从本机通过推断。
