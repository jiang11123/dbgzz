package generation_test

import (
	"infinite-canvas/backend/internal/generation"
	"strings"
	"testing"
)

func TestLocalDiskFullSurvivesDeliveryClassification(t *testing.T) {
	for _, raw := range []string{
		`生成内容写入资源存储失败：write local resource: write C:\Users\private\video: There is not enough space on the disk`,
		`write local resource: write /home/private/video: no space left on device`,
		`database or disk is full`,
	} {
		f := generation.ClassifyText(raw)
		f = generation.WithDownloadFailure(f, "task-disk-full")
		if f.Category != generation.CategoryLocalDiskFull || !f.BlocksAutomaticRetry() || !strings.Contains(f.UserMessage(), "磁盘空间不足") || strings.Contains(f.UserMessage(), "private") {
			t.Fatalf("incorrect disk failure: %#v", f)
		}
		if generation.ClassifyText(f.UserMessage()).Category != generation.CategoryLocalDiskFull {
			t.Fatal("lost persisted classification")
		}
	}
	for _, raw := range []string{`{"error":{"message":"no space left on device"}}`, `{"error":{"message":"database or disk is full"}}`, `{"error":{"code":"local_disk_full","message":"write local resource: no space left on device"}}`} {
		if generation.ClassifyHTTP(500, "", raw).Category == generation.CategoryLocalDiskFull {
			t.Fatal("upstream disk mistaken for local disk")
		}
	}
	if generation.ClassifyAppError(500, 500, "local_disk_full", "本地磁盘空间不足，无法保存数据").Category != generation.CategoryLocalDiskFull {
		t.Fatal("local API reason lost")
	}
}
