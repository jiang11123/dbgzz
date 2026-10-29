# 剪辑导出：语义计划与执行器

本页记录语义计划与 native 执行抽出之后的**实际调用关系**。`internal/editing.Compile` 是唯一内容语义；native 与 wasm 只把同一份计划降成不同 FFmpeg 步骤。测试里的 native spawn adapter 不是生产路径。

## 生产调用方

| 路径 | 语义计划 | 执行 | 说明 |
| --- | --- | --- | --- |
| 编辑器远程导出 `web/src/lib/plugins/builtin/editor/editor-export.tsx` → `renderRemote` | `POST /timeline/renders` → `task.CreateTimelineRenderTask` 准入后入队；worker `task_render.go` `processTimelineRender` 再调用 `editing.Compile`（sources=nil，不透明 `resource:` id） | `editing.Renderer.Render`：授权落盘 → ffprobe → `ApplySourceFacts` → `BuildFFmpegArgs` 一条 `filter_complex` | 生产主路径。前端只提交时间线快照。准入走任务域固定本机 schema（`local`/`ffmpeg`），不经过模型目录。app worker 再用 `asset.RecoverOwned`（任务 `id:0`）组合结果资源。 |
| 编辑器离线降级 `editor-export.tsx` → `exportLocalMp4`；预览面板 | `POST /api/timeline/render-plan` → `CompileTimelineRenderPlan` → `editing.Compile`（浏览器提交不透明 nodeId 元数据） | `lowerCanonicalPlan` → `exportTimelineToMp4` 每次 **new FFmpeg()** wasm worker → `executeTimelineRenderPlan` | 规划失败必须上抛，不得改走 TS 语义编译。取消 `terminate()` 自己的 worker。 |
| 画布时间线成片 `canvas-timeline-dialog.tsx` `runExport` | 同上 `POST /api/timeline/render-plan` | 同上 wasm | 收集可见视频/图片/音频（含静音音轨），字幕来自返回计划。 |
| 画布合并/裁切/提音 `canvas-video-merge.ts`、`canvas-video-segment.ts` | 无 TimelineRenderPlan | `canvas-ffmpeg-session.ts` 串行租约 + ffmpeg.wasm | 与时间线导出走两套 wasm 生命周期。见下节实际可共用点。 |

生产前端**没有** native spawn engine。`warmFFmpeg` / `loadFFmpeg` 只给画布媒体工具预热 idle worker。

`POST /timeline/render-plan` 只读：鉴权 + 限流，不排队、不落盘、不计费，不打开资源，不接受 ffmpeg 参数或本地路径。没有通用“跑一条命令”的接口。

## 语义层 vs 执行器

`editing.Compile` / `editing.Plan`（version=1）拥有：片段选择与顺序、空隙与片尾时长、裁剪起点、时长、静音、音量、淡入淡出、字幕文本/SRT、输出宽高帧率。执行器不得自行挑选或丢弃内容。

两端声明一致的行为：

- 隐藏轨道省略；静音独立音轨留在计划里 `muted=true`，混合时音量 0，源仍要提供。
- 片尾空隙取 `max(project.DurationMs, 所有计入片段的结束点)`，含音频和字幕。
- 无音轨视频在探测后 `hasAudio=false`，空隙/静音段用静音。
- 图片片段保留；重叠视频/图片编译失败。
- 用户输出选项（宽高/帧率/采样率/是否烧录字幕）留在计划 `output`。执行器只能改输出文件名和字幕图像文件；冲突的宽高/帧率/采样率/烧录开关必须失败。
- 未知片段类型、非正媒体时长、空/重复 ID、错误的时间线版本、不可能的编码器参数（奇数宽高、超限帧率/采样率/时长）在编译期失败，不能丢掉内容后仍导出成功。隐藏轨道继续整轨省略。
- 两端混音都是 `amix=normalize=0`，不加 limiter。图片片段的输出必须有界（native 与 wasm 都带输出 `-t`）。
- 字幕烧录失败（缺 SRT、libass 找不到可用字体）不能当作成功。

仅执行器不同：

| | Native（`editing.BuildFFmpegArgs`） | Browser wasm（`lowerCanonicalPlan`） |
| --- | --- | --- |
| 命令形态 | 一条 `filter_complex` | 逐步中间文件：trim / gap / concat / mix / burn |
| Seek | 视频段输入 `-ss`（`-ss` 在 `-i` 前） | trim 把 `-ss` 放在 `-i` 之后做输出 seek 并重编码 |
| 字幕 | SRT + libass `subtitles=filename=render-subtitles.srt` | 先按计划字幕栅格化 PNG 再 overlay；无图像时才走 `subtitles=` + libass |
| 源标识 | 授权后的 resource id | 浏览器 nodeId；永远不是本地路径 |

`web/test/timeline-ffmpeg-native.test.ts` 的 `createNativeEngine` 用 `spawnSync("ffmpeg")` 跑 wasm 风格步骤，验证与 Go native 共用 `fixtures/editing/*.plan.json`。默认 `BEEFTV_NATIVE_FFMPEG_TEST!==1` 时 skip。这不是生产集成：桌面任务仍走 `task_render.go` → `editing.Renderer`。

浏览器真实 worker 夹具：`web/test/timeline-worker.browser.test.ts`（mock `/api/timeline/render-plan` 返回同一份 six-second-mix 计划）。需 `BEEFTV_BROWSER_WORKER_TEST=1`。

Go native 夹具：`backend/internal/editing/native_ffmpeg_test.go`。本机有 ffmpeg/ffprobe 时探测实际输出时长、音轨和烧录，缺工具则 skip。

## 画布 merge/trim/crop/extractaudio 与计划的实际关系

核过 `canvas-video-merge.ts`、`canvas-video-segment.ts`、`canvas-video-segment-args.ts`、`timeline-to-ffmpeg.ts`。这些工具**没有**走 `editing.Compile` / `TimelineRenderPlan`。本轮没有构造 `TimelineClip`，也没有把画布工具改接入时间线计划。

实际可共用点（已存在，不是新接口）：

1. **wasm 时间线 trim 与画布 trim 都是输出 seek**：`buildSegmentTrimArgs` 和 `lowerVisual`（视频）都是 `-i` 之后 `-ss/-t` 再 libx264 重编码。Go native 时间线是输入 seek（`-ss` 在 `-i` 前）。这是执行器差异，不能靠发明片段去抹平。
2. **编码器预设接近**：画布 trim/crop/merge 回退和 wasm 时间线都用 `libx264` + `veryfast` + `crf 20`；Go native 成片是 `crf 23`。用途不同（节点工具 vs 成片），保持现状。
3. **可用性检查**：画布工具用 `assertUsableSegmentOutput` 看容器里是否真有 vide/soun；native 成片用 ffprobe 校验音视频轨、有限正时长，并按容器/编码容差核对计划时长。都拒绝空壳成功。

不能共用、也不应硬接计划的点：

- `mergeVideos` 是整段 concat demuxer（先 copy 再统一转码），没有空隙、音量、字幕、输出尺寸合同。
- `cropVideo` 是源像素空间裁切；计划没有 crop 几何。
- `extractVideoAudio` / `removeAudioFromVideo` 是单文件提音/去音；不是计划里的独立音频轨或 `muted`。
- 画布工具走 `withFFmpegLease`；时间线 wasm 导出各自 `new FFmpeg()`。生命周期已经分开。

## 画布 FFmpeg 租约

`mergeVideos` / `trimVideoSegment` / `cropVideo` / `extractVideoAudio` / `removeAudioFromVideo` 全部经过 `withFFmpegLease`。时间线 `exportTimelineToMp4` 仍各自 `new FFmpeg()`，不进入该租约。

## Lead 组合根接线

未改 `bootstrap/runtime.go`、`app/service.go`。当前 app 用 lazy constructor，不往 Service 加字段：

```go
func (s *Service) nativeRenderer(userID string) *editing.Renderer
```

`Renderer.Sources` 由 `renderSourceOpener` 实现：`Open(ctx, sourceID)` → `asset.Service.Open` 的 ReadCloser。授权失败映射为「无法读取时间线引用的媒体，可能已被删除」。

生产接线建议（后续统一 root）：

- 在 localapp/bootstrap 构造 `editing.Renderer{Sources: opener}`，opener 关闭在当前用户与 `asset.Service`。
- `processTimelineRender` 继续：`editing.Compile` → `asset.Service.RecoverOwned`（身份 `taskID:0`，缺字节时才 `Renderer.Render`）→ 任务完成态。
- 不要把 editing 接到 `app.Service` 方法集，也不要让 editing import `internal/app`。
- 无 operations 新注册：时间线创建仍走 HTTP `/timeline/renders` 与 `/timeline/render-plan`。
- 入队由 `internal/task.CreateTimelineRenderTask` 完成：`editing.Compile` 校验时间线，随后复用任务域 drain / 项目归属 / 配额 / `clientOperationId` 回放。`app.CreateTimelineRenderTask` 只做转发。
