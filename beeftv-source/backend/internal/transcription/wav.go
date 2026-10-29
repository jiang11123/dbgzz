package transcription

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// PrepareWAV writes the media stream to a temp file and converts it to 16 kHz
// mono PCM wav for whisper.cpp. The caller must invoke cleanup.
func PrepareWAV(ctx context.Context, reader io.Reader, mime string) (string, func(), error) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return "", nil, fmt.Errorf("音频预处理依赖未安装（需要 ffmpeg）")
	}
	tmpDir, err := os.MkdirTemp("", "beeftv-whisper-*")
	if err != nil {
		return "", nil, fmt.Errorf("创建临时目录失败: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }
	inPath := filepath.Join(tmpDir, "input"+ExtForMIME(mime))
	inFile, err := os.Create(inPath)
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("写入待转写媒体失败: %w", err)
	}
	if _, err := io.Copy(inFile, reader); err != nil {
		inFile.Close()
		cleanup()
		return "", nil, fmt.Errorf("读取待转写媒体失败: %w", err)
	}
	if err := inFile.Close(); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("关闭临时文件失败: %w", err)
	}
	wavPath := filepath.Join(tmpDir, "audio16k.wav")
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-y", "-i", inPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath)
	output, runErr := cmd.CombinedOutput()
	if runErr != nil {
		cleanup()
		detail := strings.TrimSpace(string(output))
		if len(detail) > 400 {
			detail = detail[len(detail)-400:]
		}
		return "", nil, fmt.Errorf("音频预处理失败（ffmpeg）: %s", detail)
	}
	return wavPath, cleanup, nil
}
