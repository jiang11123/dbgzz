package generation

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestProviderReadsDoNotConsumeEntireGenerationWindow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
	defer cancel()
	ctx = WithRuntime(ctx, Runtime{Call: CallMeta{RequestKind: "poll"}})
	for _, tc := range []struct {
		method, path, kind string
		max                time.Duration
	}{
		{http.MethodGet, "/videos/original", "poll", 45 * time.Second},
		{http.MethodGet, "/videos/original/content", "download", HTTPTimeout},
		{http.MethodGet, "/signed/video.mp4", "download", HTTPTimeout},
	} {
		req, _ := http.NewRequestWithContext(WithRequestKind(ctx, tc.kind), tc.method, "https://example.com"+tc.path, nil)
		if got := generationRequestTimeout(req); got != tc.max {
			t.Fatalf("%s %s timeout = %s, want %s", tc.method, tc.path, got, tc.max)
		}
	}
	short, stop := context.WithTimeout(ctx, time.Second)
	defer stop()
	req, _ := http.NewRequestWithContext(short, http.MethodGet, "https://example.com/videos/original", nil)
	if got := generationRequestTimeout(req); got > time.Second || got <= 0 {
		t.Fatalf("caller deadline was extended: %s", got)
	}
	req, _ = http.NewRequestWithContext(ctx, http.MethodPost, "https://example.com/videos", nil)
	if generationRequestTimeout(req) < 59*time.Minute {
		t.Fatal("paid submission waiting window was shortened")
	}
}

func TestVideoDownloadReportsDeliveryBeforeFetching(t *testing.T) {
	var events []string
	ctx := WithRuntime(context.Background(), Runtime{Stages: stageRecorder{events: &events}})
	_, _, err := RunVideoDownload(ctx, "original", DefaultVideoPollPolicy(), func(context.Context) ([]byte, string, error) {
		if len(events) != 1 || events[0] != "正在取回生成结果" {
			t.Fatalf("download began without a delivery stage: %v", events)
		}
		return []byte("video"), "video/mp4", nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
