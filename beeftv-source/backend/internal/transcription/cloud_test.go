package transcription

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCloudTranscribeMultipartAndTimestamps(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audio.wav")
	if err := os.WriteFile(path, []byte("audio fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/audio/transcriptions" || r.Header.Get("Authorization") != "Bearer test-only" {
			t.Error("wrong route or authorization")
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		defer r.MultipartForm.RemoveAll()
		if r.FormValue("model") != "hy-asr-3.0-preview" || r.FormValue("response_format") != "verbose_json" || r.FormValue("language") != "zh" {
			t.Error("wrong multipart fields")
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			t.Error(err)
		} else {
			file.Close()
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"language":"zh","segments":[{"start":0.25,"end":1.75,"text":"你好"}]}`))
	}))
	defer server.Close()
	client := NewClient(server.URL + "/v1")
	client.Model, client.APIKey = "hy-asr-3.0-preview", "test-only"
	segments, language, err := client.Transcribe(context.Background(), path, "zh")
	if err != nil || calls != 1 || language != "zh" || len(segments) != 1 || segments[0].StartMs != 250 || segments[0].EndMs != 1750 {
		t.Fatalf("result=%+v language=%s err=%v calls=%d", segments, language, err, calls)
	}
}

func TestCloudTranscribeRejectsOversizeRedirectAndCancellation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audio.wav")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := file.Truncate((25 << 20) + 1); err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; http.Redirect(w, r, "/leak", 307) }))
	defer server.Close()
	client := NewClient(server.URL)
	client.Model, client.APIKey = "hy-asr-3.0-preview", "test-only"
	if _, _, err := client.Transcribe(context.Background(), path, ""); err == nil || !strings.Contains(err.Error(), "25 MB") || calls != 0 {
		t.Fatalf("oversize: %v calls=%d", err, calls)
	}
	if err := file.Truncate(4); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.Transcribe(context.Background(), path, ""); err == nil || !strings.Contains(err.Error(), "307") || calls != 1 {
		t.Fatalf("redirect: %v calls=%d", err, calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := client.Transcribe(ctx, path, ""); err != context.Canceled || calls != 1 {
		t.Fatalf("cancel: %v calls=%d", err, calls)
	}
}
