package depthcapture

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

func (s *Service) Process(ctx context.Context, task *model.Task) error {
	if task == nil {
		return ErrBadInput
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !Supported(s.goos, s.goarch) {
		return s.failUnlessCanceled(ctx, task, stageUnavailable, ErrUnsupportedOS.Error())
	}
	input, err := ParseInput(task.InputJSON)
	if err != nil {
		return s.failUnlessCanceled(ctx, task, stageFailed, err.Error())
	}
	if s.media == nil {
		return s.failUnlessCanceled(ctx, task, stageFailed, ErrMissingVideo.Error())
	}
	resource, reader, err := s.media.Open(task.UserID, input.ResourceID)
	if err != nil || resource == nil || reader == nil {
		return s.failUnlessCanceled(ctx, task, stageFailed, ErrMissingVideo.Error())
	}
	defer reader.Close()
	if !strings.HasPrefix(resource.MimeType, "video/") {
		return s.failUnlessCanceled(ctx, task, stageFailed, ErrNotVideo.Error())
	}
	if OverDuration(resource.DurationMs) {
		return s.failUnlessCanceled(ctx, task, stageTooLong, ErrTooLong.Error())
	}
	started := time.Now()
	platform := PlatformID(s.goos)
	var cudaPython, cudaToolDir, cudaModelRuntime string
	choice, err := ChooseDevice(ctx, s.goos, s.goarch, s.nvidia != nil && s.nvidia(ctx), func(probeCtx context.Context) error {
		if progressErr := s.progress(task, "验证 CUDA 深度模型", 2); progressErr != nil {
			return progressErr
		}
		var resolveErr error
		cudaPython, cudaToolDir, cudaModelRuntime, resolveErr = s.resolveRuntime(probeCtx, task, platform, "cuda")
		if resolveErr != nil {
			return resolveErr
		}
		return s.cudaProbe(probeCtx, cudaPython, cudaToolDir, cudaModelRuntime)
	})
	if err != nil {
		return s.failUnlessCanceled(ctx, task, stageComponent, err.Error())
	}
	python, toolDir, modelRuntime := cudaPython, cudaToolDir, cudaModelRuntime
	if choice.Device != "cuda" {
		if s.goos == "windows" && choice.Device == "cpu" {
			s.requireCPUComponents()
		}
		python, toolDir, modelRuntime, err = s.resolveRuntime(ctx, task, platform, choice.Variant)
	}
	if err != nil {
		return s.failUnlessCanceled(ctx, task, stageComponent, err.Error())
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.progress(task, "准备视频", 8); err != nil {
		return err
	}
	workDir, err := s.mkdirTemp("", "beeftv-depth-*")
	if err != nil {
		return s.failUnlessCanceled(ctx, task, stageFailed, ErrTempDir.Error())
	}
	defer os.RemoveAll(workDir)
	inputPath := filepath.Join(workDir, "input.mp4")
	inputFile, err := os.OpenFile(inputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return s.failUnlessCanceled(ctx, task, stageFailed, ErrPrepareInput.Error())
	}
	_, copyErr := io.Copy(inputFile, reader)
	closeErr := inputFile.Close()
	if copyErr != nil || closeErr != nil {
		return s.failUnlessCanceled(ctx, task, stageFailed, ErrReadInput.Error())
	}
	outputDir := filepath.Join(workDir, "output")
	if err := os.MkdirAll(outputDir, 0o700); err != nil {
		return s.failUnlessCanceled(ctx, task, stageFailed, ErrPrepareOutput.Error())
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.progress(task, "加载深度模型", 15); err != nil {
		return err
	}
	if choice.Device == "cpu" {
		if err := s.progress(task, "使用 CPU 处理，可能耗时较长", 15); err != nil {
			return err
		}
	}
	runErr := s.run(ctx, python, toolDir, modelRuntime, choice.Device, inputPath, outputDir, func(line string) {
		switch {
		case strings.Contains(line, "[2/3]"):
			_ = s.progress(task, "分析视频", 35)
		case strings.Contains(line, "[3/3]"):
			_ = s.progress(task, "生成结果视频", 82)
		}
	})
	if ShouldRetryOnCPU(runErr, ctx.Err(), 0) && choice.Device == "cuda" {
		s.requireCPUComponents()
		choice = DeviceChoice{Variant: "cpu", Device: "cpu", FallbackReason: runErr.Error()}
		if err := s.progress(task, "CUDA 设备故障，改用 CPU（可能耗时较长）", 15); err != nil {
			return err
		}
		python, toolDir, modelRuntime, err = s.resolveRuntime(ctx, task, platform, "cpu")
		if err != nil {
			return s.failUnlessCanceled(ctx, task, stageComponent, err.Error())
		}
		if err := os.RemoveAll(outputDir); err != nil {
			return s.failUnlessCanceled(ctx, task, stageFailed, ErrCleanCUDA.Error())
		}
		if err := os.MkdirAll(outputDir, 0o700); err != nil {
			return s.failUnlessCanceled(ctx, task, stageFailed, ErrReprepareOut.Error())
		}
		runErr = s.run(ctx, python, toolDir, modelRuntime, "cpu", inputPath, outputDir, func(line string) {
			switch {
			case strings.Contains(line, "[2/3]"):
				_ = s.progress(task, "分析视频", 35)
			case strings.Contains(line, "[3/3]"):
				_ = s.progress(task, "生成结果视频", 82)
			}
		})
	}
	if runErr != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return s.fail(task, stageFailed, workerFailureSummary(runErr.Error()))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	matches, _ := filepath.Glob(filepath.Join(outputDir, "*_depth_preview.mp4"))
	if len(matches) != 1 {
		return s.failUnlessCanceled(ctx, task, stageOutput, ErrNoPreview.Error())
	}
	if err := s.progress(task, "保存到素材库", 92); err != nil {
		return err
	}
	file, err := os.Open(matches[0])
	if err != nil {
		return s.failUnlessCanceled(ctx, task, stageOutput, ErrOpenPreview.Error())
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() <= 0 {
		return s.failUnlessCanceled(ctx, task, stageOutput, ErrEmptyPreview.Error())
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	facts, err := s.probeOutput(ctx, matches[0])
	if err != nil || !facts.HasVideo || facts.Width <= 0 || facts.Height <= 0 || facts.DurationMs <= 0 {
		return s.failUnlessCanceled(ctx, task, stageOutput, "无法读取深度结果视频的实际尺寸和时长")
	}
	stored, err := s.media.SaveVideo(task.UserID, OutputName, info.Size(), facts.Width, facts.Height, facts.DurationMs, file, "depth:"+task.ID)
	if err != nil {
		return s.failUnlessCanceled(ctx, task, stageSave, err.Error())
	}
	result := Result{
		ResourceID:     stored.ID,
		FileName:       OutputName,
		Size:           stored.Size,
		DurationMs:     stored.DurationMs,
		Width:          stored.Width,
		Height:         stored.Height,
		Device:         choice.Device,
		FallbackReason: choice.FallbackReason,
		RuntimeVersion: "v1",
		ProcessingMs:   time.Since(started).Milliseconds(),
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.tasks == nil {
		return nil
	}
	return s.tasks.Complete(task, result)
}
