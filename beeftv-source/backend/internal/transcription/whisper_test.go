package transcription

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/editing"
)

func TestDecodeVerboseJSON(t *testing.T) {
	payload := []byte(`{
		"task": "transcribe",
		"language": "zh",
		"duration": 6.12,
		"text": " 大家好  ",
		"segments": [
			{"id": 0, "start": 0.0, "end": 2.015, "text": " 大家好 "},
			{"id": 1, "start": 2.5, "end": 6.12, "text": "   "},
			{"id": 2, "start": 4.12, "end": 6.121, "text": "今天天气不错"}
		]
	}`)
	segments, language, err := DecodeVerboseJSON(payload)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if language != "zh" {
		t.Fatalf("language = %q, want zh", language)
	}
	if len(segments) != 2 {
		t.Fatalf("segments = %d, want 2 (blank segment filtered)", len(segments))
	}
	if segments[0].StartMs != 0 || segments[0].EndMs != 2015 {
		t.Fatalf("seg0 = %d-%d, want 0-2015", segments[0].StartMs, segments[0].EndMs)
	}
	if segments[0].Text != "大家好" {
		t.Fatalf("seg0 text = %q, want 大家好 (trimmed)", segments[0].Text)
	}
	if segments[1].StartMs != 4120 || segments[1].EndMs != 6121 {
		t.Fatalf("seg1 = %d-%d, want 4120-6121", segments[1].StartMs, segments[1].EndMs)
	}
}

func TestDecodeVerboseJSONInvalid(t *testing.T) {
	if _, _, err := DecodeVerboseJSON([]byte(`{not json`)); err == nil {
		t.Fatal("decode invalid payload: want error")
	}
	segments, _, err := DecodeVerboseJSON([]byte(`{"text":"","segments":[]}`))
	if err != nil {
		t.Fatalf("decode empty segments: unexpected error %v", err)
	}
	if len(segments) != 0 {
		t.Fatalf("decode empty segments: got %d, want 0", len(segments))
	}
}

func TestBuildSRT(t *testing.T) {
	if got := editing.FormatSRTTimestamp(-5); got != "00:00:00,000" {
		t.Fatalf("timestamp %q", got)
	}
	segments := []Segment{
		{StartMs: 0, EndMs: 2015, Text: "大家好"},
		{StartMs: 2500, EndMs: 6121, Text: "今天天气不错"},
	}
	srt := BuildSRT(segments)
	want := "1\n00:00:00,000 --> 00:00:02,015\n大家好\n\n2\n00:00:02,500 --> 00:00:06,121\n今天天气不错\n\n"
	if srt != want {
		t.Fatalf("srt mismatch:\n got %q\nwant %q", srt, want)
	}
}

func TestExtForMIMEAndTranscribable(t *testing.T) {
	transcribable := []string{"video/mp4", "audio/wav", "audio/mpeg", "video/webm", "audio/flac", "video/quicktime", "audio/aac", "audio/ogg"}
	for _, mime := range transcribable {
		if !IsTranscribableMIME(mime) {
			t.Fatalf("IsTranscribableMIME(%q) = false, want true", mime)
		}
		if strings.TrimPrefix(ExtForMIME(mime), ".") == "bin" {
			t.Fatalf("ExtForMIME(%q) fell back to .bin", mime)
		}
	}
	for _, mime := range []string{"image/png", "text/plain", ""} {
		if IsTranscribableMIME(mime) {
			t.Fatalf("IsTranscribableMIME(%q) = true, want false", mime)
		}
	}
}

func TestClientTranscribeRejectsEmptySpeech(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/inference" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if _, _, err := r.FormFile("file"); err != nil {
			t.Fatalf("file: %v", err)
		}
		if r.FormValue("response_format") != "verbose_json" {
			t.Fatalf("format %q", r.FormValue("response_format"))
		}
		w.Write([]byte(`{"language":"zh","segments":[{"start":0,"end":1,"text":"   "}]}`))
	}))
	defer server.Close()
	dir := t.TempDir()
	wav := filepath.Join(dir, "audio16k.wav")
	if err := os.WriteFile(wav, []byte("RIFF"), 0600); err != nil {
		t.Fatal(err)
	}
	client := NewClient(server.URL)
	client.HTTP = server.Client()
	if _, _, err := client.Transcribe(context.Background(), wav, "zh"); err == nil || !strings.Contains(err.Error(), "未识别出语音内容") {
		t.Fatalf("err=%v", err)
	}
}

func TestClientTranscribeReturnsSegments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"language":"zh","segments":[{"start":0.0,"end":1.5,"text":"你好"}]}`))
	}))
	defer server.Close()
	dir := t.TempDir()
	wav := filepath.Join(dir, "audio16k.wav")
	if err := os.WriteFile(wav, []byte("RIFF"), 0600); err != nil {
		t.Fatal(err)
	}
	client := NewClient(server.URL)
	client.HTTP = server.Client()
	segments, language, err := client.Transcribe(context.Background(), wav, "zh")
	if err != nil {
		t.Fatal(err)
	}
	if language != "zh" || len(segments) != 1 || segments[0].Text != "你好" || segments[0].EndMs != 1500 {
		t.Fatalf("segments=%+v language=%s", segments, language)
	}
}

type bufferMedia struct {
	mime string
	data []byte
}

func (m bufferMedia) Open(context.Context, string) (Media, io.ReadCloser, error) {
	return Media{MimeType: m.mime}, io.NopCloser(bytes.NewReader(m.data)), nil
}

func TestExecutorRejectsNonTranscribable(t *testing.T) {
	exec := &Executor{Media: bufferMedia{mime: "image/png", data: []byte("x")}}
	if _, err := exec.Run(context.Background(), "res", "", nil); err == nil || !strings.Contains(err.Error(), "音视频") {
		t.Fatalf("err=%v", err)
	}
}

func TestPrepareWAVWithRealFFmpeg(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dir := t.TempDir()
	src := filepath.Join(dir, "tone.wav")
	cmd := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", src)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	wavPath, cleanup, err := PrepareWAV(ctx, bytes.NewReader(data), "audio/wav")
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(wavPath)
	if err != nil || info.Size() == 0 {
		t.Fatalf("wav missing: %v %+v", err, info)
	}
}
