package generation

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
)

func unifiedVideoAdapter(t *testing.T, name string) protocol.Adapter {
	t.Helper()
	raw, err := os.ReadFile("../../../plugin-packages/" + name + "/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := protocol.LoadInstalledProviders(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	return adapters[0]
}

func unifiedVideoPayload(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("../app/testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func unifiedVideoResult(t *testing.T, result map[string]interface{}, payload []byte) {
	t.Helper()
	video := result["video"].(map[string]interface{})
	mimeType, raw, err := DecodeProviderDataURL(stringField(video, "dataUrl"))
	if err != nil || mimeType != "video/mp4" || !bytes.Equal(raw, payload) {
		t.Fatalf("video mime=%s bytes=%d err=%v", mimeType, len(raw), err)
	}
}

// This roster verifies download consumption for every shipped video provider.
// Provider-specific polling parsers are tested separately with real wire shapes.
func TestEveryInstalledVideoProviderUsesUnifiedPublicURLDownload(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("x-goog-api-key") != "" || r.Header.Get("X-Private-Channel") != "" || r.Header.Get("Cookie") != "" || r.Header.Get(beefAPIVideoDeliveryHeader) != "" || r.URL.Query().Get("credential") != "" {
			t.Error("external media received provider credentials")
		}
		if r.URL.Query().Get("signature") != "media-signature" {
			t.Error("independent media signature was removed")
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(payload)
	}))
	defer media.Close()
	paths, err := filepath.Glob("../../../plugin-packages/*/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var roster []string
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var manifest struct {
			Contributes struct {
				Providers []struct {
					Capabilities []protocol.Capability `json:"capabilities"`
				} `json:"providers"`
			} `json:"contributes"`
		}
		if err := json.Unmarshal(raw, &manifest); err != nil {
			t.Fatal(err)
		}
		hasVideo := false
		for _, provider := range manifest.Contributes.Providers {
			for _, capability := range provider.Capabilities {
				hasVideo = hasVideo || capability == protocol.CapabilityVideo
			}
		}
		if !hasVideo {
			continue
		}
		adapters, err := protocol.LoadInstalledProviders(raw, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, adapter := range adapters {
			isVideo := false
			for _, capability := range adapter.Metadata().Categories {
				isVideo = isVideo || capability == protocol.CapabilityVideo
			}
			if !isVideo {
				continue
			}
			roster = append(roster, adapter.Metadata().ID)
			t.Run(adapter.Metadata().ID, func(t *testing.T) {
				receipts := &recordingReceipts{}
				ctx := WithRuntime(context.Background(), Runtime{Receipts: receipts})
				input := Input{Mode: "video", Config: Config{BaseURL: "https://provider.example", APIKey: "provider-key", SecretKey: "provider-secret", Headers: []outbound.OutboundHeader{{Name: "X-Private-Channel", Value: "private-fixture"}, {Name: "Cookie", Value: "session=private-cookie"}}}}
				result, err := FinishProtocolAdapterResult(ctx, input, adapter, protocol.GenerationRequest{}, "original", &protocol.Result{Videos: []protocol.MediaReference{{URL: media.URL + "/video?credential=provider-key&signature=media-signature"}}}, DefaultVideoPollPolicy())
				if err != nil {
					t.Fatal(err)
				}
				unifiedVideoResult(t, result, payload)
				calls := receipts.snapshot()
				if len(calls) != 1 || calls[0].Request.Context().Value(videoDeliveryRequestContext{}) != videoDeliveryIdleTimeout {
					t.Fatalf("shared idle download missing: calls=%d", len(calls))
				}
			})
		}
	}
	if len(roster) != 32 {
		t.Fatalf("shipped video roster changed: %d %v", len(roster), roster)
	}
	t.Logf("downloadRoster=%v; renewalParserRoster=openai-videos,google-gemini-veo,vertex-veo,volcengine-ark-seedance", roster)
}

func TestAllOfficialVideoURLsRenewOriginalThirdPartyTask(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	for _, name := range []string{"openai-videos", "google-gemini-veo", "vertex-veo", "volcengine-ark-seedance"} {
		t.Run(name, func(t *testing.T) {
			polls, mediaReads, creates := 0, 0, 0
			media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mediaReads++
				if r.Header.Get("Authorization") != "" || r.Header.Get("x-goog-api-key") != "" || r.Header.Get("X-Private-Channel") != "" || r.Header.Get(beefAPIVideoDeliveryHeader) != "" {
					t.Error("external media received provider credentials")
				}
				if r.URL.Query().Get("version") != "4" {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				w.Header().Set("Content-Type", "application/octet-stream")
				_, _ = w.Write(payload)
			}))
			defer media.Close()
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					creates++
					t.Error("renewal attempted generation submission")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if r.URL.Query().Get("delivery") != "" || r.Header.Get(beefAPIVideoDeliveryHeader) != "" {
					t.Error("third-party request used BeefAPI delivery protocol")
				}
				if r.Header.Get("X-Private-Channel") != "private-fixture" {
					t.Error("provider request lost channel header")
				}
				if name == "google-gemini-veo" {
					if r.Header.Get("x-goog-api-key") != "provider-key" || r.Header.Get("Authorization") != "" {
						t.Error("Google provider authentication was changed to bearer")
					}
				} else if r.Header.Get("Authorization") != "Bearer provider-key" {
					t.Error("provider bearer credential missing")
				}
				polls++
				status := "completed"
				if polls == 2 {
					status = "processing"
				}
				url := media.URL + "/video?version=" + string(rune('0'+polls))
				state := map[string]interface{}{"id": "original", "status": status, "video_url": url}
				if name == "google-gemini-veo" {
					state = map[string]interface{}{"name": "original", "done": polls != 2, "response": map[string]interface{}{"generateVideoResponse": map[string]interface{}{"generatedSamples": []interface{}{map[string]interface{}{"video": map[string]interface{}{"uri": url}}}}}}
				} else if name == "volcengine-ark-seedance" {
					state["status"] = "succeeded"
					if polls == 2 {
						state["status"] = "running"
					}
					state["content"] = map[string]interface{}{"video_url": url}
				}
				_ = json.NewEncoder(w).Encode(state)
			}))
			defer provider.Close()
			var waits []time.Duration
			policy := DefaultVideoPollPolicy()
			policy.Sleep = func(_ context.Context, delay time.Duration) error { waits = append(waits, delay); return nil }
			ctx := WithCallMeta(context.Background(), CallMeta{ProviderRequestID: "original"})
			result, err := RunProtocolAdapterTaskWithPolicy(ctx, Input{Mode: "video", Config: Config{BaseURL: provider.URL, APIKey: "provider-key", APIFormat: "openai", Model: "unlisted-future-video", Headers: []outbound.OutboundHeader{{Name: "X-Private-Channel", Value: "private-fixture"}}}}, unifiedVideoAdapter(t, name), policy)
			if err != nil {
				t.Fatal(err)
			}
			unifiedVideoResult(t, result, payload)
			if creates != 0 || polls != 4 || mediaReads != 3 || !reflect.DeepEqual(waits, []time.Duration{30 * time.Second, 30 * time.Second, 30 * time.Second}) {
				t.Fatalf("creates=%d polls=%d media=%d waits=%v", creates, polls, mediaReads, waits)
			}
		})
	}
}

func TestVideoProtocolAuthSurvivesRelativeURLAndStopsAtRedirect(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Private-Channel") != "" || r.URL.Query().Get("credential") != "" || r.URL.Query().Get("signature") != "media-signature" {
			t.Error("redirect leaked provider header/query credentials or removed media signature")
		}
		if r.URL.Path == "/expired" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = w.Write(payload)
	}))
	defer media.Close()
	polls, mediaLinks := 0, 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Query().Get("delivery") != "" {
			t.Error("relative result recovery created work or requested BeefAPI backup")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Query().Get("credential") != "provider-key" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Private-Channel") != "private-fixture" {
			t.Error("same-origin URL did not preserve manifest query auth")
		}
		if r.URL.Path == "/v1/task/original" {
			polls++
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "completed", "video_url": "/media/video"})
			return
		}
		mediaLinks++
		path := "/fresh"
		if mediaLinks == 1 {
			path = "/expired"
		}
		http.Redirect(w, r, media.URL+path+"?credential=provider-key&signature=media-signature", http.StatusFound)
	}))
	defer provider.Close()
	manifest := []byte(`{"apiVersion":"beeftv.plugin/v2","id":"video-query-fixture","name":"Fixture","version":"1.0.0","contributes":{"providers":[{"id":"video-query-fixture","label":"Fixture","capabilities":["video"],"scopes":["canvas"],"auth":{"type":"query","field":"apiKey","query":"credential"},"create":{"method":"POST","path":"/v1/videos"},"poll":{"method":"GET","path":"/v1/task/{{taskId}}"},"response":{"status":{"$ref":"response.status"},"videos":{"$ref":"response.video_url"}}}]}}`)
	adapter, err := protocol.LoadInstalledPlugin(manifest, nil)
	if err != nil {
		t.Fatal(err)
	}
	policy := DefaultVideoPollPolicy()
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	ctx := WithCallMeta(context.Background(), CallMeta{ProviderRequestID: "original"})
	result, err := RunProtocolAdapterTaskWithPolicy(ctx, Input{Mode: "video", Config: Config{BaseURL: provider.URL, APIKey: "provider-key", Headers: []outbound.OutboundHeader{{Name: "X-Private-Channel", Value: "private-fixture"}}}}, adapter, policy)
	if err != nil {
		t.Fatal(err)
	}
	unifiedVideoResult(t, result, payload)
	if polls != 2 || mediaLinks != 2 {
		t.Fatalf("polls=%d links=%d", polls, mediaLinks)
	}
}

func TestThirdPartyVideoStallRenewsSameTask(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	var stalled atomic.Int32
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/stall" {
			stalled.Add(1)
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			_, _ = w.Write([]byte("partial"))
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		_, _ = w.Write(payload)
	}))
	defer media.Close()
	renewals := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/videos/original" || r.URL.RawQuery != "" {
			t.Errorf("unexpected provider recovery request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		renewals++
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "completed", "video_url": media.URL + "/fresh"})
	}))
	defer provider.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	started := time.Now()
	data, _, err := RunVideoDownload(ctx, "original", DefaultVideoPollPolicy(), videoResultDownloader(Config{BaseURL: provider.URL}, media.URL+"/stall", "original", newAPIVideoURLResolver(Config{BaseURL: provider.URL}, "original")))
	if err != nil || !bytes.Equal(data, payload) || stalled.Load() != 1 || renewals != 1 || time.Since(started) < videoDeliveryIdleTimeout {
		t.Fatalf("bytes=%d stalled=%d renewed=%d elapsed=%s err=%v", len(data), stalled.Load(), renewals, time.Since(started), err)
	}
}

func TestThirdPartyVideoCancellationDoesNotRenew(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	entered := make(chan struct{})
	media := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done() }))
	defer media.Close()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-entered; cancel() }()
	renewals := 0
	_, _, err := RunVideoDownload(ctx, "original", DefaultVideoPollPolicy(), videoResultDownloader(Config{BaseURL: "https://provider.example"}, media.URL, "original", func(context.Context) (string, error) { renewals++; return media.URL, nil }))
	if !errors.Is(err, context.Canceled) || renewals != 0 {
		t.Fatalf("renewals=%d err=%v", renewals, err)
	}
}

func TestVideoProviderStatusAuthenticationFailureStopsRenewal(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			reads, queries := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/tasks/original" {
					queries++
				} else {
					reads++
				}
				if r.Header.Get("Authorization") != "Bearer provider-key" {
					t.Error("same-origin credential missing")
				}
				w.WriteHeader(status)
			}))
			defer server.Close()
			config := Config{BaseURL: server.URL, APIKey: "provider-key"}
			renew := videoTaskURLResolver(config, "original", "/tasks/original", func(map[string]interface{}) (string, string) { return "completed", server.URL })
			_, _, err := RunVideoDownload(context.Background(), "original", DefaultVideoPollPolicy(), videoResultDownloader(config, server.URL+"/private-video?signature=expired", "original", renew))
			if err == nil || reads != 1 || queries != 1 {
				t.Fatalf("reads=%d queries=%d err=%v", reads, queries, err)
			}
		})
	}
}

func TestHandwrittenVideoPollRejectsDifferentOriginalTask(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	runners := map[string]func(context.Context, Input, VideoPollPolicy) (map[string]interface{}, error){
		"newapi": RunVideoTaskWithPolicy,
		"flat":   RunSeedanceVideosTask,
		"ark":    RunSeedanceAgentPlanVideoTask,
	}
	for name, run := range runners {
		for _, mismatch := range []string{"outer", "inner", "alias"} {
			t.Run(name+"/"+mismatch, func(t *testing.T) {
				var queries, media, creates atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet {
						creates.Add(1)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if r.URL.Path == "/wrong.mp4" || r.URL.Path == "/v1/videos/original/content" {
						media.Add(1)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					queries.Add(1)
					state := map[string]interface{}{"id": "original", "status": "succeeded", "video_url": "/wrong.mp4", "content": map[string]interface{}{"video_url": "/wrong.mp4"}}
					switch mismatch {
					case "outer":
						state = map[string]interface{}{"id": "different", "data": state}
					case "inner":
						state["id"] = "different"
						state = map[string]interface{}{"id": "original", "data": state}
					case "alias":
						state["task_id"] = "different"
					}
					_ = json.NewEncoder(w).Encode(state)
				}))
				defer server.Close()
				policy := DefaultVideoPollPolicy()
				policy.Sleep = func(context.Context, time.Duration) error { return nil }
				result, err := run(WithCallMeta(context.Background(), CallMeta{ProviderRequestID: "original"}), Input{Mode: "video", Config: Config{BaseURL: server.URL + "/v1", Model: "unlisted-video"}}, policy)
				if err == nil || result != nil || queries.Load() != 1 || media.Load() != 0 || creates.Load() != 0 {
					t.Fatalf("result=%v err=%v queries=%d media=%d creates=%d", result, err, queries.Load(), media.Load(), creates.Load())
				}
			})
		}
	}
}

func TestHandwrittenVideoRenewalRejectsDifferentOriginalTask(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, ark := range []bool{false, true} {
		t.Run(fmt.Sprint("ark=", ark), func(t *testing.T) {
			var queries, media, creates atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					creates.Add(1)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if r.URL.Path == "/expired.mp4" {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				if r.URL.Path == "/wrong.mp4" {
					media.Add(1)
					return
				}
				queries.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "different", "status": "succeeded", "video_url": "/wrong.mp4", "content": map[string]interface{}{"video_url": "/wrong.mp4"}})
			}))
			defer server.Close()
			config := Config{BaseURL: server.URL + "/v1"}
			renew := newAPIVideoURLResolver(config, "original")
			if ark {
				renew = videoTaskURLResolver(config, "original", "/contents/generations/tasks/original", func(state map[string]interface{}) (string, string) {
					content, _ := state["content"].(map[string]interface{})
					return stringField(state, "status"), stringField(content, "video_url")
				})
			}
			_, _, err := RunVideoDownload(context.Background(), "original", DefaultVideoPollPolicy(), videoResultDownloader(config, server.URL+"/expired.mp4", "original", renew))
			if err == nil || queries.Load() != 1 || media.Load() != 0 || creates.Load() != 0 {
				t.Fatalf("queries=%d media=%d creates=%d err=%v", queries.Load(), media.Load(), creates.Load(), err)
			}
		})
	}
}

func TestNewAPIVideoSuccessWithoutURLRenewsOriginalContent(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	for _, status := range []string{"success", "done"} {
		for name, run := range map[string]func(context.Context, Input, VideoPollPolicy) (map[string]interface{}, error){"newapi": RunVideoTaskWithPolicy, "flat": RunSeedanceVideosTask} {
			t.Run(status+"/"+name, func(t *testing.T) {
				var queries, reads, creates atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet {
						creates.Add(1)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					switch r.URL.Path {
					case "/v1/videos/original":
						queries.Add(1)
						_ = json.NewEncoder(w).Encode(map[string]interface{}{"data": map[string]interface{}{"id": "original", "status": status}})
					case "/v1/videos/original/content":
						if reads.Add(1) == 1 {
							w.WriteHeader(http.StatusServiceUnavailable)
							return
						}
						w.Header().Set("Content-Type", "video/mp4")
						_, _ = w.Write(payload)
					default:
						t.Errorf("wrong task route %s", r.URL.Path)
						w.WriteHeader(http.StatusBadRequest)
					}
				}))
				defer server.Close()
				policy := DefaultVideoPollPolicy()
				policy.Sleep = func(context.Context, time.Duration) error { return nil }
				result, err := run(WithCallMeta(context.Background(), CallMeta{ProviderRequestID: "original"}), Input{Mode: "video", Config: Config{BaseURL: server.URL + "/v1", Model: "unlisted-video"}}, policy)
				if err != nil {
					t.Fatal(err)
				}
				unifiedVideoResult(t, result, payload)
				if queries.Load() != 2 || reads.Load() != 2 || creates.Load() != 0 {
					t.Fatalf("queries=%d reads=%d creates=%d", queries.Load(), reads.Load(), creates.Load())
				}
			})
		}
	}
}

func TestGeminiOfficialInlineVideoNeedsNoMediaRequest(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1beta/original" {
			t.Error("inline result attempted a create or media request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		polls++
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"name": "original", "done": true, "response": map[string]interface{}{"generatedVideos": []interface{}{map[string]interface{}{"video": map[string]interface{}{"bytesBase64Encoded": base64.StdEncoding.EncodeToString(payload), "mimeType": "video/mp4"}}}}})
	}))
	defer server.Close()
	policy := DefaultVideoPollPolicy()
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	result, err := RunProtocolAdapterTaskWithPolicy(WithCallMeta(context.Background(), CallMeta{ProviderRequestID: "original"}), Input{Mode: "video", Config: Config{BaseURL: server.URL, APIKey: "provider-key", Model: "unlisted-video"}}, unifiedVideoAdapter(t, "google-gemini-veo"), policy)
	if err != nil {
		t.Fatal(err)
	}
	unifiedVideoResult(t, result, payload)
	if polls != 1 {
		t.Fatalf("polls=%d", polls)
	}
}

func TestVideoBinaryResultPreservesMethodAuthAndOriginalTaskRenewal(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	polls, reads := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Video-Api-Key") != "provider-key" || r.Header.Get("Authorization") != "" || r.URL.Query().Get("delivery") != "" {
			t.Error("binary result changed provider auth or used BeefAPI backup")
		}
		if r.Method == http.MethodGet && r.URL.Path == "/v1/tasks/original" {
			polls++
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "completed"})
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/tasks/original/result" || r.Header.Get("X-Result-Mode") != "binary" {
			t.Error("binary recovery lost declared result method or submitted generation")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		reads++
		if reads == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	manifest := []byte(`{"apiVersion":"beeftv.plugin/v2","id":"video-binary-fixture","name":"Fixture","version":"1.0.0","contributes":{"providers":[{"id":"video-binary-fixture","label":"Fixture","capabilities":["video"],"scopes":["canvas"],"auth":{"type":"header","field":"apiKey","header":"X-Video-Api-Key"},"create":{"method":"POST","path":"/v1/videos"},"poll":{"method":"GET","path":"/v1/tasks/{{taskId}}"},"result":{"method":"POST","path":"/v1/tasks/{{taskId}}/result","headers":{"X-Result-Mode":"binary"}},"response":{"status":{"$ref":"response.status"}}}]}}`)
	adapter, err := protocol.LoadInstalledPlugin(manifest, nil)
	if err != nil {
		t.Fatal(err)
	}
	policy := DefaultVideoPollPolicy()
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	result, err := RunProtocolAdapterTaskWithPolicy(WithCallMeta(context.Background(), CallMeta{ProviderRequestID: "original"}), Input{Mode: "video", Config: Config{BaseURL: server.URL, APIKey: "provider-key", Model: "unlisted-video"}}, adapter, policy)
	if err != nil {
		t.Fatal(err)
	}
	unifiedVideoResult(t, result, payload)
	if polls != 2 || reads != 2 {
		t.Fatalf("polls=%d reads=%d", polls, reads)
	}
}

func TestHandwrittenArkVideoRenewsOriginalTaskAndSavesMP4(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("Ark credential leaked to signed storage")
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	defer media.Close()
	polls, reads := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer provider-key" || r.URL.Query().Get("delivery") != "" {
			t.Error("Ark recovery changed auth or submitted generation")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Path == "/fresh.mp4" {
			reads++
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(payload)
			return
		}
		if r.URL.Path != "/api/v3/contents/generations/tasks/original" {
			t.Errorf("wrong original-task query %s", r.URL.Path)
		}
		polls++
		url := media.URL
		if polls > 1 {
			url = "/fresh.mp4"
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "succeeded", "content": map[string]interface{}{"video_url": url}})
	}))
	defer server.Close()
	policy := DefaultVideoPollPolicy()
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	ctx := WithCallMeta(context.Background(), CallMeta{ProviderRequestID: "original"})
	result, err := RunSeedanceAgentPlanVideoTask(ctx, Input{Mode: "video", Config: Config{BaseURL: server.URL + "/api/v3", APIKey: "provider-key", Model: "unlisted-video"}}, policy)
	if err != nil {
		t.Fatal(err)
	}
	unifiedVideoResult(t, result, payload)
	if polls != 2 || reads != 1 {
		t.Fatalf("polls=%d reads=%d", polls, reads)
	}
}

func TestVideoCredentialsStayStrippedAfterExternalRoundTrip(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	checkStripped := func(r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Private-Channel") != "" || r.Header.Get("Accept") == "private-accept" || r.Header.Get("User-Agent") == "private-agent" || r.URL.Query().Get("credential") != "" || r.URL.Query().Get("cookie") != "" || r.URL.Query().Get("overridden") != "" || r.URL.Query().Get("signature") != "media-signature" {
			t.Error("provider credentials were restored after leaving their origin")
		}
	}
	var provider *httptest.Server
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checkStripped(r)
		if r.URL.Path == "/direct" {
			_, _ = w.Write(payload)
			return
		}
		http.Redirect(w, r, provider.URL+"/returned?credential=provider-key&cookie=private-cookie&overridden=override-key&signature=media-signature", http.StatusFound)
	}))
	defer external.Close()
	provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/returned" {
			checkStripped(r)
			_, _ = w.Write(payload)
			return
		}
		if r.Header.Get("Authorization") != "Bearer override-key" || r.Header.Get("Cookie") != "session=private-cookie" || r.Header.Get("X-Private-Channel") != "private-fixture" || r.URL.Query().Get("credential") != "provider-key" {
			t.Error("same-origin redirect lost provider auth")
		}
		if r.URL.Path == "/start" {
			http.Redirect(w, r, provider.URL+"/same?credential=provider-key", http.StatusFound)
			return
		}
		http.Redirect(w, r, external.URL+"/away?credential=provider-key&cookie=private-cookie&overridden=override-key&signature=media-signature", http.StatusFound)
	}))
	defer provider.Close()
	config := Config{BaseURL: provider.URL, APIKey: "provider-key", Headers: []outbound.OutboundHeader{{Name: "Authorization", Value: "Bearer override-key"}, {Name: "Cookie", Value: "session=private-cookie"}, {Name: "X-Private-Channel", Value: "private-fixture"}, {Name: "User-Agent", Value: "private-agent"}, {Name: "Accept", Value: "private-accept"}}}
	ctx := withVideoProtocolAuth(context.Background(), protocol.ManifestAuth{Type: "query", Field: "apiKey", Query: "credential"})
	for _, rawURL := range []string{provider.URL + "/start", external.URL + "/direct?credential=provider-key&cookie=private-cookie&overridden=override-key&signature=media-signature"} {
		data, _, err := RunVideoDownload(ctx, "original", DefaultVideoPollPolicy(), videoResultDownloader(config, rawURL, "original"))
		if err != nil || !bytes.Equal(data, payload) {
			t.Fatalf("download bytes=%d err=%v", len(data), err)
		}
	}
}
