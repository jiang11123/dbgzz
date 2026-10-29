package generation

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/mediatools"
)

func upscaleTempFile(dir, name string, data []byte) (string, error) {
	path := filepath.Join(dir, name)
	return path, os.WriteFile(path, data, 0600)
}

func ValidateUpscaleVideoSource(ctx context.Context, data []byte) error {
	dir, err := os.MkdirTemp("", "beeftv-upscale-probe-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path, err := upscaleTempFile(dir, "source.mp4", data)
	if err != nil {
		return err
	}
	facts, err := mediatools.ProbeLocal(ctx, path)
	if err != nil {
		return err
	}
	if !facts.HasVideo || facts.DurationMs <= 0 || facts.DurationMs > 300_000 || !strings.Contains(","+facts.FormatName+",", ",mov,") && !strings.Contains(","+facts.FormatName+",", ",mp4,") {
		return errors.New("超分视频须为不超过 5 分钟的 MP4 或 MOV")
	}
	if facts.HasAudio {
		_, err = mediatools.ResolveFFmpeg()
	}
	return err
}

func PreserveUpscaleAudio(ctx context.Context, source, output []byte) ([]byte, error) {
	dir, err := os.MkdirTemp("", "beeftv-upscale-audio-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	sourcePath, err := upscaleTempFile(dir, "source.mp4", source)
	if err != nil {
		return nil, err
	}
	outputPath, err := upscaleTempFile(dir, "upscaled.mp4", output)
	if err != nil {
		return nil, err
	}
	sourceFacts, err := mediatools.ProbeLocal(ctx, sourcePath)
	if err != nil {
		return nil, err
	}
	outputFacts, err := mediatools.ProbeLocal(ctx, outputPath)
	if err != nil {
		return nil, err
	}
	if !outputFacts.HasVideo || outputFacts.DurationMs <= 0 {
		return nil, errors.New("超分结果没有有效的视频画面")
	}
	if !sourceFacts.HasAudio || outputFacts.HasAudio {
		return output, nil
	}
	bin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		return nil, err
	}
	result := filepath.Join(dir, "result.mp4")
	cmd := exec.CommandContext(ctx, bin, "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", outputPath, "-protocol_whitelist", "file,pipe", "-i", sourcePath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-t", strconv.FormatFloat(float64(outputFacts.DurationMs)/1000, 'f', 3, 64), "-movflags", "+faststart", result)
	mediatools.HideConsole(cmd)
	if err := cmd.Run(); err != nil {
		return nil, errors.New("原视频音轨补回失败，请取回原任务结果重试")
	}
	info, err := os.Stat(result)
	if err != nil {
		return nil, err
	}
	limit := MaxResponseBytes
	if runtime, ok := RuntimeFromContext(ctx); ok && runtime.Limits != nil {
		limit, err = runtime.Limits.GeneratedFileBytes(ctx)
		if err != nil {
			return nil, err
		}
	}
	if info.Size() > limit {
		return nil, errors.New("补回音轨后的视频超过资源大小限制")
	}
	facts, err := mediatools.ProbeLocal(ctx, result)
	if err != nil || !facts.HasVideo || !facts.HasAudio {
		return nil, errors.New("补回音轨后的视频校验失败")
	}
	return os.ReadFile(result)
}
