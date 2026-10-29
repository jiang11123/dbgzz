# 时间线字幕转写

`internal/transcription` 拥有本地 whisper.cpp 转写：16 kHz 单声道预处理、HTTP `/inference`、verbose_json 解析、SRT。本包不得 import `internal/app`。

## 生产调用

画布 `POST /timeline/transcriptions` → `task.CreateTimelineTranscriptionTask` 入队。准入校验功能门控、归属素材和音视频 MIME，再复用任务域 drain / 项目归属 / 配额 / `clientOperationId` 回放；固定本机 schema 为 `local` / `whisper.cpp`，不经过模型目录。`app.CreateTimelineTranscriptionTask` 只做转发。worker `processTimelineTranscription` 校验 `CANVAS_WHISPER_BASE_URL` 与功能门控后，调用 `transcription.Executor.Run`。空识别、缺服务、非音视频都不能成功。

结果是任务 `ResultJSON`（segments + srt + language），不落新媒体文件。

## Lead 组合根接线

未改 `bootstrap/runtime.go`、`app/service.go`。当前 lazy constructor：

```go
func (s *Service) transcriptionExecutor(userID, baseURL string) *transcription.Executor
```

`Executor.Media` 由 `transcribeMediaOpener` 实现：`Open(ctx, resourceID)` → `asset.Service.Open`，带 MimeType。授权失败映射为「无法读取待转写媒体，可能已被删除」。

生产接线建议：

- root 注入 `transcription.Executor{Media: opener, Client: transcription.NewClient(baseURL)}`。
- `baseURL` 来自 `CANVAS_WHISPER_BASE_URL`；空值在 adapter 以原错误文案失败，不进入执行器。
- 功能门控 `timelineTranscription` 在任务域创建路径和 worker 领取路径各检查一次。
- 无 operations 新注册：入口仍是 HTTP `/timeline/transcriptions`。
