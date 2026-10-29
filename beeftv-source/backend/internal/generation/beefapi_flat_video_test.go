package generation

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBeefAPIFlatFrameVideoDispatchAndResume(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "1")
	for _, name := range []string{"grok-imagine-video-1.5", "kling-video-v3"} {
		t.Run(name, func(t *testing.T) {
			creates := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer synthetic" {
					t.Error("provider credential missing")
				}
				switch r.URL.Path {
				case "/v1/videos":
					creates++
					if r.Method != "POST" || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
						t.Error("gateway must receive a single JSON create")
					}
					var body map[string]interface{}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Fatal(err)
					}
					if body["model"] != name || body["duration"] != float64(5) || body["resolution"] != "720p" || body["generate_audio"] != false {
						t.Errorf("controls changed: %#v", body)
					}
					image, _ := body["image"].(map[string]interface{})
					if image["url"] != "https://example.com/frame.png" {
						t.Error("reference image missing")
					}
					if _, exists := body["size"]; exists {
						t.Error("Sora size field leaked into gateway request")
					}
					if name == "grok-imagine-video-1.5" && body["aspect_ratio"] != "16:9" {
						t.Error("Grok ratio missing")
					}
					if name == "kling-video-v3" && body["aspect_ratio"] != nil {
						t.Error("Kling first-frame request must derive its ratio")
					}
					_ = json.NewEncoder(w).Encode(map[string]string{"id": "original"})
				case "/v1/videos/original":
					_ = json.NewEncoder(w).Encode(map[string]string{"status": "completed"})
				case "/v1/videos/original/content":
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("original video"))
				default:
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL})
			policy := DefaultVideoPollPolicy()
			policy.Sleep = func(context.Context, time.Duration) error { return nil }
			input := Input{Mode: "video", Prompt: "a red ball", Config: Config{BaseURL: server.URL + "/v1", APIKey: "synthetic", InterfaceType: "chat-completion", Model: name, Size: "16:9", VQuality: "720", VideoSeconds: "5", VideoGenerateAudio: "false"}, ReferenceImages: []Media{{URL: "https://example.com/frame.png"}}}
			for _, attempt := range []context.Context{ctx, EnrichCallMeta(ctx, CallMeta{ProviderRequestID: "original"})} {
				result, err := RunVideoTaskWithPolicy(attempt, input, policy)
				if err != nil || result["mode"] != "video" {
					t.Fatalf("result=%v err=%v", result, err)
				}
			}
			if creates != 1 {
				t.Fatalf("resume submitted %d creates", creates)
			}
		})
	}
}

func TestBeefAPIFlatFrameVideoRejectsExtraMedia(t *testing.T) {
	for _, name := range []string{"grok-imagine-video-1.5", "kling-video-v3"} {
		for _, input := range []Input{
			{ReferenceImages: []Media{{}, {}}},
			{ReferenceVideos: []Media{{}}},
			{ReferenceAudios: []Media{{}}},
		} {
			input.Config = Config{Model: name, VideoSeconds: "5", VQuality: "720"}
			if _, err := BeefAPIVideoRequestBody(input); err == nil {
				t.Fatal("unsupported media accepted")
			}
		}
	}
}

func TestGatewayTerminalFailureKeepsOriginalTaskAndFailureCategory(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/videos/original-task" {
			t.Error("terminal recovery must only query the original task")
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "failed"})
	}))
	defer server.Close()
	ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL})
	ctx = EnrichCallMeta(ctx, CallMeta{ProviderRequestID: "original-task"})
	policy := DefaultVideoPollPolicy()
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	_, err := RunVideoTaskWithPolicy(ctx, Input{Mode: "video", Config: Config{BaseURL: server.URL, Model: "grok-imagine-video-1.5"}}, policy)
	failure := ClassifyError(err)
	if failure.Category != CategoryAsyncFailed || failure.Uncertain || failure.TaskID != "original-task" || strings.Contains(failure.UserMessage(), "Seedance") {
		t.Fatalf("terminal failure misclassified: %#v", failure)
	}
}

func TestGatewayUnsupportedControlsAreRejectedBeforeCreate(t *testing.T) {
	for _, input := range []Input{
		{Config: Config{Model: "grok-imagine-video-1.5", VideoSeconds: "4", VQuality: "480"}, ReferenceImages: []Media{{}}},
		{Config: Config{Model: "grok-imagine-video-1.5", VideoSeconds: "11", VQuality: "720"}, ReferenceImages: []Media{{}}},
		{Config: Config{Model: "kling-video-v3", VideoSeconds: "5", VQuality: "1080"}},
		{Config: Config{Model: "kling-video-v3", VideoSeconds: "2", VQuality: "720"}},
	} {
		if _, err := BeefAPIVideoRequestBody(input); err == nil {
			t.Fatalf("invalid controls accepted: %#v", input.Config)
		}
	}
}

type videoRepairCapture struct{ creates int }

func (p *videoRepairCapture) Intercept(req *http.Request) (bool, []byte, string, error) {
	if req.Method == http.MethodPost {
		p.creates++
		return true, nil, "", HTTPError{StatusCode: 400, Body: `{"error":{"code":"invalid_request","message":"synthetic boundary rejection"}}`}
	}
	if strings.HasSuffix(req.URL.Path, "/content") {
		return true, []byte("original video"), "video/mp4", nil
	}
	return true, []byte(`{"status":"completed"}`), "application/json", nil
}

func TestExecuteRepairsStaleHostedVideoProtocolBeforeValidation(t *testing.T) {
	for _, name := range []string{"grok-imagine-video-1.5", "kling-video-v3"} {
		for _, base := range []string{"https://beeftv.app", "https://enterprise.beefapi.com/v1", "https://custom.example"} {
			port := &videoRepairCapture{}
			ctx := WithRuntime(context.Background(), taskRuntime(func(r *Runtime) { r.Images = port }))
			input := Input{Mode: "video", Prompt: "a red ball", Config: Config{BaseURL: base, APIKey: "synthetic", Model: name, InterfaceType: "chat-completion", VideoSeconds: "5", VQuality: "720", Size: "16:9"}}
			_, err := Execute(ctx, input)
			if base == "https://custom.example" {
				if err == nil || port.creates != 0 {
					t.Fatalf("custom route changed: %v", err)
				}
			} else if port.creates != 1 || ClassifyError(err).Category != CategoryInvalidParams {
				t.Fatalf("%s %s: creates=%d err=%v", name, base, port.creates, err)
			}
		}
	}
}
