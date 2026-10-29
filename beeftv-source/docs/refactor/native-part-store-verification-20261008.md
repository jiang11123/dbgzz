# 原生音视频短引用

官方 pi-durable 1.0.4 在 generation prepare 阶段判断自动压缩，然后才调用 beforeRequest。pi-ai 的文本估算按字符数 / 4；将 WAV/MP4 的 base64 放进文本工具结果会把 15 秒音频误算成大量文本，触发不必要的摘要请求。没有公开自定义 token 估算选项；提高模型 contextWindow 不能作为修复。

`native-part-store.mjs` 把已校验的 Go 原生音视频 part 保存到宿主 DATA_DIR/native-parts。工具结果只写 `BEEFTV_MEDIA_REF_V1` 和有界的 SHA256/mime/source 信息；实际模型请求发送前才加载原字节。官方队列、SQLite、恢复和自动压缩流程保持原实现。

## 信任与保存

- 只有 backend media 工具适配器能写入，不从模型文字、路径或 URL 写缓存。ID 是严格 64 位小写 SHA256；单个 part 保持 8 MiB 上限、单请求保持 32 MiB 上限。
- bytes 与 manifest 通过同目录临时文件、fsync、rename 保存；新目录 0700、文件 0600。拒绝非普通文件、symlink 和异常 manifest。既有损坏引用不能被后续 write 静默修复。
- 读取校验 ID、manifest、mime、大小、来源绑定和真实 bytes SHA。同 SHA 可绑定多个经过 Go 工具发出的来源；引用中自报的来源必须已在 manifest 登记。
- 原生载荷只能从之前的 media_overview/inspect/check 工具调用及对应工具结果解析；普通消息或其他工具 marker 不授予媒体访问。`trustedMediaSources` 返回当前 canvas/node 或 asset/version 元数据，由宿主实际 fetch 前逐项请求 Go overview 再检查当前权限及版本；验证成功后同步适配器才扩展 native URL。
- 旧 `BEEFTV_MEDIA_PART_V1` 内嵌格式可读取，保证旧会话兼容；新 Durable 工具结果写短引用。图片继续使用官方 image block。
- 此目录是正式会话历史的媒体引用，不能当作普通临时缓存无差别清理。引用缺失、篡改或来源版本变化均拒绝发送，不退回猜测性文本。

## 已验证

`bun test native-part-store.test.mjs media-content.test.mjs`：5 项通过、33 个断言。720KB 音频 result 的文本不到 2000 字符、官方 `estimateMessageTokens` 不到 500 token，transcript 不含原 base64；fresh store 重开可以恢复原字节，实际发送 native URL 与原字节完全一致。覆盖目录/文件权限、原子保存无临时残留、path/URL reference、bytes/manifest/source/mime 篡改、其他工具 provenance 拒绝以及旧格式兼容。

media worker 已在正式 bundled Node 24.15.0 上通过同一真实 Go/SQLite → actual default Durable host → native JPEG/WAV/MP4 端到端测试（9.597 秒）：保留默认 200k contextWindow，5 次主请求 / 5 次总请求，自动 compaction 为 0；JPEG/WAV/MP4 实际网络字节与 Go inspect 的 SHA 完全一致，音视频 part 均超过 50 KiB。修复前同一 strict fixture 已实际失败（3 次自动 compaction），没有通过提高 contextWindow 或省略摘要调用来绕过问题。详细回执由 media worker 的 `native-media-default-receipt.md` 保存。
