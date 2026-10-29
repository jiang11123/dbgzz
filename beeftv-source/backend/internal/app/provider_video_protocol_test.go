package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCustomVideoProtocolPreservesFiveImagesAcrossEndpoints(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1,localhost")
	service := &Service{mode: serviceModeLocal, localResourceStorage: true}
	for _, model := range []string{"seedance-2.0-fast", "studio-motion-v1"} {
		for _, prefix := range []string{"", "/gateway"} {
			for _, selected := range []string{"video-generations-json", "newapi"} {
				t.Run(model+prefix+"/"+selected, func(t *testing.T) {
					creates, polls, downloads := 0, 0, 0
					images := make([]providerMedia, 5)
					for i := range images {
						images[i] = providerMedia{ID: fmt.Sprintf("image-%d", i+1), URL: fmt.Sprintf("https://media.example/image-%d.png", i+1)}
					}
					var server *httptest.Server
					server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.URL.Path != "/result.mp4" && r.Header.Get("Authorization") != "Bearer synthetic-key" {
							t.Error("provider credential missing")
						}
						switch {
						case r.Method == http.MethodPost && r.URL.Path == prefix+"/v1/video/generations":
							creates++
							var body struct {
								Model, Ratio string
								Images       []struct{ URL, Role string }
							}
							if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
								t.Error(err)
								w.WriteHeader(http.StatusBadRequest)
								return
							}
							if r.Header.Get("Content-Type") != "application/json" || body.Model != model || body.Ratio != "9:16" || len(body.Images) != len(images) {
								t.Errorf("incorrect JSON request: %+v", body)
							}
							for i, image := range body.Images {
								if i >= len(images) || image.URL != images[i].URL || image.Role != "reference_image" {
									t.Errorf("image %d changed: %+v", i+1, image)
								}
							}
							_, _ = w.Write([]byte(`{"id":"original","status":"pending"}`))
						case r.Method == http.MethodGet && r.URL.Path == prefix+"/v1/video/generations/original":
							polls++
							_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed", "data": []any{map[string]any{"url": server.URL + "/result.mp4"}}})
						case r.Method == http.MethodGet && r.URL.Path == "/result.mp4":
							downloads++
							w.Header().Set("Content-Type", "video/mp4")
							_, _ = w.Write([]byte("original video"))
						default:
							t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
							w.WriteHeader(http.StatusNotFound)
						}
					}))
					defer server.Close()
					baseURL := server.URL + prefix + "/v1"
					if prefix != "" {
						baseURL = strings.Replace(baseURL, "127.0.0.1", "localhost", 1)
					}
					config, err := service.resolveProviderConfig(providerConfig{BaseURL: baseURL, APIKey: "synthetic-key", InterfaceType: selected, Model: model, Size: "9:16", VideoSeconds: "5"})
					if err != nil {
						t.Fatal(err)
					}
					if config.InterfaceType != selected || config.BaseURL != baseURL || config.Model != model {
						t.Fatalf("explicit custom configuration changed: %+v", config)
					}
					policy := defaultVideoPollPolicy()
					policy.Sleep = func(context.Context, time.Duration) error { return nil }
					result, err := runVideoTaskWithPolicy(context.Background(), canvasGenerationInput{Mode: "video", Prompt: "Use all five references.", Config: config, ReferenceImages: images}, policy)
					if selected == "newapi" {
						if err == nil || !strings.Contains(err.Error(), "最多支持一张参考图") || creates+polls+downloads != 0 {
							t.Fatalf("Sora protocol must reject unsendable images before submission: err=%v calls=%d/%d/%d", err, creates, polls, downloads)
						}
						return
					}
					if err != nil || result["video"] == nil || creates != 1 || polls != 1 || downloads != 1 {
						t.Fatalf("JSON lifecycle failed: result=%v err=%v calls=%d/%d/%d", result, err, creates, polls, downloads)
					}
				})
			}
		}
	}
}
