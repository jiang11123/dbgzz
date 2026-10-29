package generation

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

func TestExternalVideoJSONCreatePollAndDownload(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, rejected := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "415 no retry"}[rejected], func(t *testing.T) {
			creates, polls, downloads := 0, 0, 0
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/video/generations":
					creates++
					if r.Method != "POST" || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Authorization") != "Bearer test-key" {
						t.Errorf("bad request %s %+v", r.Method, r.Header)
					}
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					images, _ := body["images"].([]any)
					if len(images) != 2 || body["duration"] != float64(5) || body["ratio"] != "16:9" {
						t.Errorf("body=%+v", body)
					}
					if rejected {
						w.WriteHeader(415)
						_, _ = w.Write([]byte(`{"error":{"code":"unsupported_media_type","message":"JSON required"}}`))
						return
					}
					_, _ = w.Write([]byte(`{"id":"original","status":"pending"}`))
				case "/v1/video/generations/original":
					polls++
					_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed", "data": []any{map[string]any{"url": server.URL + "/result.mp4"}}})
				case "/result.mp4":
					downloads++
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("original video"))
				default:
					t.Errorf("unexpected path %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			policy := DefaultVideoPollPolicy()
			policy.Sleep = func(context.Context, time.Duration) error { return nil }
			result, err := RunVideoTaskWithPolicy(context.Background(), Input{Mode: "video", Prompt: "move", Config: Config{BaseURL: server.URL, APIKey: "test-key", InterfaceType: "video-generations-json", Model: "seedance-2.5", VideoSeconds: "5", Size: "16:9", VQuality: "720p"}, Metadata: map[string]any{"videoEditOperation": "reference_to_video"}, ReferenceImages: []Media{{DataURL: "data:image/png;base64,aGVsbG8="}, {DataURL: "data:image/png;base64,d29ybGQ="}}}, policy)
			if creates != 1 {
				t.Fatalf("create count=%d", creates)
			}
			if rejected {
				if err == nil || polls != 0 || downloads != 0 {
					t.Fatalf("err=%v polls=%d downloads=%d", err, polls, downloads)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			video, _ := result["video"].(map[string]any)
			_, data, decodeErr := DecodeProviderDataURL(stringField(video, "dataUrl"))
			if decodeErr != nil || strings.TrimSpace(string(data)) != "original video" || polls != 1 || downloads != 1 {
				t.Fatalf("result=%+v decode=%v polls=%d downloads=%d", result, decodeErr, polls, downloads)
			}
		})
	}
}

func TestVideoJSONUnassignedImagesKeepConfiguredRatio(t *testing.T) {
	input := Input{Mode: "video", Config: Config{InterfaceType: "video-generations-json", Model: "seedance-2.5", Size: "16:9", VideoSeconds: "5"}, ReferenceImages: []Media{{DataURL: "data:image/png;base64,aGVsbG8="}, {DataURL: "data:image/png;base64,d29ybGQ="}}}
	request := ProtocolRequestFromInput(input)
	if request.AspectRatio != "16:9" || request.Images[0].Role != "" || request.Images[1].Role != "" {
		t.Fatalf("request=%+v", request)
	}
	registry := LoadOfficialFallbackRegistry()
	adapter, ok := registry.Resolve("video-generations-json")
	if !ok {
		t.Fatal("missing shipped JSON adapter")
	}
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil || spec.Body.(map[string]any)["ratio"] != "16:9" {
		t.Fatalf("spec=%+v err=%v", spec, err)
	}
	for _, raw := range spec.Body.(map[string]any)["images"].([]any) {
		if raw.(map[string]any)["role"] != "reference_image" {
			t.Fatal("unassigned images became keyframes")
		}
	}
}

func TestVideoJSONMissingPluginDoesNotSubmit(t *testing.T) {
	registry, _ := protocol.NewRegistry()
	ctx := WithProtocolRegistry(context.Background(), registry)
	for _, name := range []string{"seedance-2.5", "other-video"} {
		_, err := RunVideoTask(ctx, Input{Mode: "video", Config: Config{BaseURL: "https://example.invalid", InterfaceType: "video-generations-json", Model: name}})
		if err == nil || !strings.Contains(err.Error(), "插件未安装") {
			t.Fatalf("model=%s err=%v", name, err)
		}
	}
}

func TestVideoJSONPreservesFiveReferencesAndTaskLifecycle(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, outcome := range []string{"success", "415", "resume", "missing plugin", "cancelled"} {
		t.Run(outcome, func(t *testing.T) {
			creates, polls, downloads := 0, 0, 0
			images := make([]Media, 5)
			for i := range images {
				images[i] = Media{ID: fmt.Sprintf("ref-%d", i+1), URL: fmt.Sprintf("https://media.example/reference-%d.png", i+1)}
			}
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-key" {
					t.Error("missing provider authentication")
				}
				switch {
				case r.Method == "POST" && r.URL.Path == "/v1/video/generations":
					creates++
					if r.Header.Get("Content-Type") != "application/json" {
						t.Error("expected JSON rather than Sora multipart")
					}
					var body struct {
						Model, Prompt, Ratio string
						Duration             int
						Images               []struct{ URL, Role string }
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if body.Model != "seedance-2.0-fast" || body.Prompt != "Use all five references in order." || body.Ratio != "9:16" || body.Duration != 5 || len(body.Images) != 5 {
						t.Errorf("unexpected request: %+v", body)
					}
					for i, image := range body.Images {
						if i >= len(images) || image.URL != images[i].URL || image.Role != "reference_image" {
							t.Errorf("reference %d changed or became a keyframe: %+v", i+1, image)
						}
					}
					if outcome == "415" {
						w.WriteHeader(http.StatusUnsupportedMediaType)
						_, _ = w.Write([]byte(`{"error":{"message":"unsupported media type"}}`))
						return
					}
					_, _ = w.Write([]byte(`{"id":"original","status":"pending"}`))
				case r.Method == "GET" && r.URL.Path == "/v1/video/generations/original":
					polls++
					_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed", "data": []any{map[string]any{"url": server.URL + "/result.mp4"}}})
				case r.Method == "GET" && r.URL.Path == "/result.mp4":
					downloads++
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("original video"))
				default:
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			config := Config{BaseURL: server.URL + "/v1", APIKey: "test-key", InterfaceType: "video-generations-json", Model: "seedance-2.0-fast", Size: "9:16", VideoSeconds: "5"}
			ctx := context.Background()
			if outcome == "resume" {
				ctx = WithCallMeta(ctx, CallMeta{ProviderRequestID: "original"})
			}
			if outcome == "missing plugin" {
				registry, _ := protocol.NewRegistry()
				ctx = WithProtocolRegistry(ctx, registry)
			}
			if outcome == "cancelled" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			policy := DefaultVideoPollPolicy()
			policy.Sleep = func(context.Context, time.Duration) error { return nil }
			result, err := RunVideoTaskWithPolicy(ctx, Input{Mode: "video", Prompt: "Use all five references in order.", Config: config, ReferenceImages: images}, policy)
			wantCreates := 1
			if outcome == "resume" || outcome == "missing plugin" || outcome == "cancelled" {
				wantCreates = 0
			}
			if creates != wantCreates {
				t.Fatalf("create count = %d, want %d", creates, wantCreates)
			}
			if outcome == "415" || outcome == "missing plugin" || outcome == "cancelled" {
				if err == nil || polls != 0 || downloads != 0 {
					t.Fatalf("err=%v polls=%d downloads=%d", err, polls, downloads)
				}
				return
			}
			if err != nil || polls != 1 || downloads != 1 || result["video"] == nil {
				t.Fatalf("result=%v err=%v polls=%d downloads=%d", result, err, polls, downloads)
			}
		})
	}
}
