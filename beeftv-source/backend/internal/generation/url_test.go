package generation

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestChannelAPIURLNormalizesConfiguredVersionPrefix(t *testing.T) {
	tests := []struct {
		base, path, want string
	}{
		{"https://api.example.com", "/chat/completions", "https://api.example.com/v1/chat/completions"},
		{"https://api.example.com/v1", "/chat/completions", "https://api.example.com/v1/chat/completions"},
		{"https://api.example.com/v1/", "/v2/videos", "https://api.example.com/v2/videos"},
		{"https://api.example.com/api/v3", "/videos", "https://api.example.com/api/v3/videos"},
	}
	for _, test := range tests {
		if got := ChannelAPIURL(test.base, test.path); got != test.want {
			t.Fatalf("ChannelAPIURL(%q, %q) = %q, want %q", test.base, test.path, got, test.want)
		}
	}
}

func TestChannelAPIURLForProtocolUsesGeminiDefault(t *testing.T) {
	got := ChannelAPIURLForProtocol("https://generativelanguage.googleapis.com", "/models/gemini:generateContent", model.ChannelInterfaceGeminiImage)
	want := "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestChannelAPIURLForProtocolUsesAgnesOriginPollPath(t *testing.T) {
	got := ChannelAPIURLForProtocol("https://apihub.agnes-ai.com/v1", "/agnesapi?video_id=video-1&model_name=agnes-video-2.5", model.ChannelInterfaceAgnesVideo)
	want := "https://apihub.agnes-ai.com/agnesapi?video_id=video-1&model_name=agnes-video-2.5"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestProviderDownloadURLNormalizesBeefAPIResultToConfiguredOrigin(t *testing.T) {
	tests := []struct {
		name, baseURL, resultURL, want string
	}{
		{name: "same origin", baseURL: "https://provider.example", resultURL: "https://provider.example/files/video.mp4", want: "https://provider.example/files/video.mp4"},
		{name: "BeefTV uses configured origin", baseURL: "https://beeftv.app", resultURL: "https://beefapi.com/v1/videos/task-1/content", want: "https://beeftv.app/v1/videos/task-1/content"},
		{name: "BeefTV lookalike stays external", baseURL: "https://beeftv.app", resultURL: "https://beeftv.app.attacker.example/video.mp4", want: "https://beeftv.app.attacker.example/video.mp4"},
		{name: "beef enterprise uses configured origin", baseURL: "https://enterprise.beefapi.com", resultURL: "https://beefapi.com/v1/videos/task-1/content", want: "https://enterprise.beefapi.com/v1/videos/task-1/content"},
		{name: "beef subdomain uses configured origin", baseURL: "https://api.beefapi.com", resultURL: "https://cdn.beefapi.com/video.mp4?token=result", want: "https://api.beefapi.com/video.mp4?token=result"},
		{name: "lookalike host stays external", baseURL: "https://enterprise.beefapi.com", resultURL: "https://beefapi.com.attacker.example/video.mp4", want: "https://beefapi.com.attacker.example/video.mp4"},
		{name: "custom provider does not rewrite beef", baseURL: "https://provider.example", resultURL: "https://beefapi.com/video.mp4", want: "https://beefapi.com/video.mp4"},
		{name: "insecure cross origin stays external", baseURL: "https://enterprise.beefapi.com", resultURL: "http://beefapi.com/video.mp4", want: "http://beefapi.com/video.mp4"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ProviderDownloadURL(test.baseURL, test.resultURL); got != test.want {
				t.Fatalf("ProviderDownloadURL(%q, %q) = %q, want %q", test.baseURL, test.resultURL, got, test.want)
			}
		})
	}
}

func TestApplyAuth(t *testing.T) {
	newReq := func() *http.Request {
		req, err := http.NewRequest(http.MethodPost, "https://example.com/v1/x", nil)
		if err != nil {
			t.Fatal(err)
		}
		return req
	}
	req := newReq()
	ApplyAuth(req, Config{APIFormat: "claude", APIKey: "secret"})
	if req.Header.Get("x-api-key") != "secret" || req.Header.Get("anthropic-version") == "" {
		t.Fatalf("claude auth = %v", req.Header)
	}
	req = newReq()
	ApplyAuth(req, Config{APIFormat: "gemini", APIKey: "gkey"})
	if req.Header.Get("x-goog-api-key") != "gkey" {
		t.Fatalf("gemini auth = %v", req.Header)
	}
	req = newReq()
	ApplyAuth(req, Config{APIKey: "tok"})
	if req.Header.Get("Authorization") != "Bearer tok" {
		t.Fatalf("bearer auth = %v", req.Header)
	}
}

func TestProviderDownloadURLRootRelativeResult(t *testing.T) {
	base := "https://api.example.com/v1"
	for _, test := range []struct{ raw, want string }{
		{"/v1/videos/task-fixture/content?alt=media", "https://api.example.com/v1/videos/task-fixture/content?alt=media"},
		{"//external.example/file", "//external.example/file"},
		{"video", "video"},
		{"/file#fragment", "/file#fragment"},
		{"https://cdn.example/file", "https://cdn.example/file"},
	} {
		if got := ProviderDownloadURL(base, test.raw); got != test.want {
			t.Errorf("result %q: got %q, want %q", test.raw, got, test.want)
		}
	}
}

func TestProviderRelativeResultDownloadsWithSameOriginAuth(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/videos/task-fixture/content" || r.Header.Get("Authorization") != "Bearer fixture-key" {
			t.Errorf("same-origin download path or authentication lost")
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write([]byte("fixture-video"))
	}))
	defer server.Close()
	body, _, err := GetProviderExternalBinary(context.Background(), Config{BaseURL: server.URL + "/v1", APIKey: "fixture-key"}, "/v1/videos/task-fixture/content")
	if err != nil || string(body) != "fixture-video" {
		t.Fatalf("relative output download failed: %v", err)
	}
}
