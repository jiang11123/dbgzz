package transcription

import (
	"context"
	"fmt"
)

type Executor struct {
	Media  MediaOpener
	Client *Client
}

func reportProgress(progress Progress, stage string, percent int) error {
	if progress == nil {
		return nil
	}
	return progress(stage, percent)
}

func (e *Executor) Run(ctx context.Context, resourceID, language string, progress Progress) (Result, error) {
	if e == nil || e.Media == nil {
		return Result{}, fmt.Errorf("无法读取待转写媒体，可能已被删除")
	}
	media, reader, err := e.Media.Open(ctx, resourceID)
	if err != nil || reader == nil {
		return Result{}, fmt.Errorf("无法读取待转写媒体，可能已被删除")
	}
	defer reader.Close()
	if !IsTranscribableMIME(media.MimeType) {
		return Result{}, fmt.Errorf("仅支持音视频文件转写")
	}
	if err := reportProgress(progress, "等待转写服务", 15); err != nil {
		return Result{}, err
	}
	wavPath, cleanup, err := PrepareWAV(ctx, reader, media.MimeType)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		return Result{}, err
	}
	if err := reportProgress(progress, "正在转写…", 40); err != nil {
		return Result{}, err
	}
	client := e.Client
	if client == nil {
		client = NewClient("")
	}
	segments, languageOut, err := client.Transcribe(ctx, wavPath, language)
	if err != nil {
		return Result{}, err
	}
	if err := reportProgress(progress, "整理字幕…", 80); err != nil {
		return Result{}, err
	}
	return Result{Segments: segments, SRT: BuildSRT(segments), Language: languageOut}, nil
}
