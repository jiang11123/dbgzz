package app

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	_ "image/png"
	localasset "infinite-canvas/backend/internal/asset"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

func canvasMediaDemuxer(mime string) string {
	switch mime {
	case "image/png":
		return "png_pipe"
	case "image/jpeg":
		return "jpeg_pipe"
	case "image/webp":
		return "webp_pipe"
	case "video/mp4", "video/quicktime":
		return "mov"
	case "video/webm":
		return "matroska"
	}
	return ""
}

func (w *taskWorkerCoordinator) processCanvasMedia(task *model.Task, ctx context.Context) error {
	s := w.service
	var input localtask.CanvasMediaInput
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || !cw.IsMediaOperation(input.Node.OperationID) {
		return w.failTimelineTask(task, "处理失败", "媒体处理参数无效")
	}
	var clean func()
	var artifact *os.File
	defer func() {
		if artifact != nil {
			_ = artifact.Close()
		}
		if clean != nil {
			clean()
		}
	}()
	resource, err := s.resourceDomain().RecoverOwned(task.UserID, task.ID+":0", func() (localasset.RecoveredArtifact, error) {
		source, body, err := s.OpenResource(task.UserID, input.ResourceID)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		defer body.Close()
		format := canvasMediaDemuxer(source.MimeType)
		if format == "" {
			return localasset.RecoveredArtifact{}, fmt.Errorf("此素材格式暂不支持自动处理")
		}
		params, ext, mime, err := cw.MediaCommand(input.Node, source.Width, source.Height)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		bin, err := mediatools.ResolveFFmpeg()
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		dir, err := os.MkdirTemp("", "beeftv-media-")
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		clean = func() { _ = os.RemoveAll(dir) }
		sourcePath := filepath.Join(dir, "source")
		file, err := os.Create(sourcePath)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		_, copyErr := io.Copy(file, body)
		closeErr := file.Close()
		if copyErr != nil {
			return localasset.RecoveredArtifact{}, copyErr
		}
		if closeErr != nil {
			return localasset.RecoveredArtifact{}, closeErr
		}
		output := filepath.Join(dir, "result"+ext)
		args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-f", format, "-i", sourcePath}
		args = append(args, params...)
		args = append(args, output)
		if err = w.progress(task, "本地媒体处理中", 20); err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		cmd := exec.CommandContext(ctx, bin, args...)
		mediatools.HideConsole(cmd)
		if err = cmd.Run(); err != nil {
			return localasset.RecoveredArtifact{}, fmt.Errorf("媒体处理失败，请检查源文件、裁切范围或音轨：%w", err)
		}
		artifact, err = os.Open(output)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		var facts mediatools.MediaMetadata
		if input.Node.MediaType == "image" {
			config, _, decodeErr := image.DecodeConfig(artifact)
			if decodeErr != nil {
				return localasset.RecoveredArtifact{}, fmt.Errorf("输出图片无效")
			}
			facts.Width, facts.Height = config.Width, config.Height
			if _, err = artifact.Seek(0, io.SeekStart); err != nil {
				return localasset.RecoveredArtifact{}, err
			}
		} else {
			facts, err = mediatools.ProbeLocal(ctx, output)
			if err != nil {
				return localasset.RecoveredArtifact{}, err
			}
			if input.Node.MediaType == "video" && !facts.HasVideo || input.Node.MediaType == "audio" && !facts.HasAudio {
				return localasset.RecoveredArtifact{}, fmt.Errorf("处理结果缺少所需媒体轨道")
			}
		}
		info, err := artifact.Stat()
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		return localasset.RecoveredArtifact{Kind: input.Node.MediaType, FileName: "canvas-process" + ext, MimeType: mime, Size: info.Size(), Width: facts.Width, Height: facts.Height, DurationMs: facts.DurationMs, Body: artifact}, nil
	})
	if err != nil {
		return w.failTimelineTask(task, "处理失败", err.Error())
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	value := map[string]any{"resourceId": resource.ID, "mimeType": resource.MimeType, "width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs}
	payload, err := json.Marshal(map[string]any{input.Node.MediaType: value, "resourceId": resource.ID})
	if err != nil {
		return err
	}
	task.Status = model.TaskStatusSucceeded
	task.Stage = "处理完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	now := time.Now()
	task.CompletedAt = &now
	if err := s.repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return err
	}
	if err := s.DeliverSucceededTask(*task); err != nil {
		_ = s.log(task.UserID, task.ID, "error", "媒体处理成功但交付待恢复", err.Error())
	}
	return nil
}
