package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/workspace"
)

// Exercise the same operation boundary as the native assistant, with real
// local resources/FFmpeg and only the paid provider replaced by a loopback.
func TestMediaReviewAudioUsesOwnedSourceAndIndependentModel(t *testing.T) {
	for _, format := range []string{"wav", "mp3"} {
		t.Run(format, func(t *testing.T) { testMediaReviewAudio(t, format) })
	}
}

func testMediaReviewAudio(t *testing.T, format string) {
	svc, canvasID, _ := newAssistantTurnService(t)
	source := reviewAudioFixture(t, format)
	resource, err := svc.UploadLocalResourceFile("local", "voice."+format, int64(len(source)), "audio", 0, 0, 2000, bytes.NewReader(source))
	if err != nil {
		t.Fatal(err)
	}
	asset, _ := json.Marshal(map[string]any{"id": "audio-asset", "title": "Local audio fixture", "kind": "audio", "coverUrl": "", "tags": []string{},
		"data": map[string]any{"storageKey": "resource:" + resource.ID, "bytes": resource.Size, "mimeType": resource.MimeType, "durationMs": 2000}})
	if _, err := svc.UpsertUserAsset("local", asset); err != nil {
		t.Fatal(err)
	}
	document, _ := json.Marshal(map[string]any{"id": canvasID, "title": "Review fixture", "revision": canvasRevisionOf(t, svc, canvasID), "nodes": []any{
		map[string]any{"id": "audio", "type": "audio", "title": "Voice", "position": map[string]int{"x": 0, "y": 0}, "metadata": map[string]string{"assetId": "audio-asset", "storageKey": "resource:" + resource.ID}},
	}, "connections": []any{}})
	if _, err := svc.UpsertUserCanvasProject("local", document); err != nil {
		t.Fatal(err)
	}
	before, err := svc.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	submittedAudio := make(chan []byte, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer review-fixture-key" || body.Model != "wand-vega-vl-1.0-flash" || len(body.Messages) != 2 {
			t.Error("request did not use the independently selected model")
			return
		}
		var parts []struct {
			Type       string `json:"type"`
			InputAudio struct {
				Data   string `json:"data"`
				Format string `json:"format"`
			} `json:"input_audio"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(body.Messages[1].Content, &parts); err != nil || len(parts) != 2 || parts[0].Type != "input_audio" || parts[0].InputAudio.Format != "wav" || parts[1].Text != "描述实际听到的声音和不确定项" {
			t.Error("missing WAND input_audio contract")
			return
		}
		submitted, err := base64.StdEncoding.DecodeString(parts[0].InputAudio.Data)
		if err != nil {
			t.Error(err)
			return
		}
		submittedAudio <- submitted
		json.NewEncoder(w).Encode(map[string]any{"request_id": "audio-observation", "usage": map[string]int{"prompt_tokens": 40, "completion_tokens": 10},
			"choices": []any{map[string]any{"message": map[string]string{"content": "fixture observation"}, "finish_reason": "stop"}}})
	}))
	defer server.Close()
	store, err := workspace.NewProviderConfig(svc.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]any{"assistantModel": "main::claude-opus-5-5", "mediaReviewModel": "review::wand-vega-vl-1.0-flash",
		"channels": []any{map[string]any{"id": "review", "enabled": true, "baseUrl": server.URL + "/v1", "apiKey": "review-fixture-key",
			"models": []string{"wand-vega-vl-1.0-flash"}, "modelProfiles": []any{map[string]string{"model": "wand-vega-vl-1.0-flash", "capability": "text", "protocol": "chat-completion"}}}}})
	if err := store.SaveLocalModelConfig(config); err != nil {
		t.Fatal(err)
	}
	registry := operations.NewRegistry(svc, operations.NewStore(svc.repo.DB()))
	operations.RegisterDefaultOps(registry)
	sum := sha256.Sum256(source)
	params, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeId": "audio", "resourceId": resource.ID, "expectedVersion": hex.EncodeToString(sum[:]),
		"startMs": 200, "endMs": 1200, "mode": "audio", "question": "描述实际听到的声音和不确定项"})
	result, err := registry.Execute(operations.Request{UserID: "local", Op: "media.review", Params: params,
		Caller: operations.AssistantCaller(&agentops.AssistantScope{CanvasID: canvasID}, true)})
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("paid review calls = %d, want 1", calls.Load())
	}
	submitted := <-submittedAudio
	if len(submitted) < 44 || string(submitted[:4]) != "RIFF" || string(submitted[8:12]) != "WAVE" {
		t.Fatal("provider did not receive real WAV bytes")
	}
	// Decode the exact provider bytes: the requested one-second window must be
	// 24 kHz mono s16 PCM, for both lossless and compressed source files.
	wav := filepath.Join(t.TempDir(), "submitted.wav")
	if err := os.WriteFile(wav, submitted, 0600); err != nil {
		t.Fatal(err)
	}
	pcm, err := exec.Command("ffmpeg", "-nostdin", "-v", "error", "-i", wav, "-f", "s16le", "-").Output()
	if err != nil || len(pcm) != 48000 {
		t.Fatalf("submitted clip must decode to one second of mono 24 kHz PCM: bytes=%d err=%v", len(pcm), err)
	}
	raw, _ := json.Marshal(result.Result)
	var observation struct {
		Source      operations.MediaSource            `json:"source"`
		MediaSHA256 string                            `json:"mediaSHA256"`
		Review      operations.MediaReviewObservation `json:"review"`
	}
	if err := json.Unmarshal(raw, &observation); err != nil {
		t.Fatal(err)
	}
	wireSHA := sha256.Sum256(submitted)
	if observation.Source.Version != hex.EncodeToString(sum[:]) || observation.Source.StartMs != 200 || observation.Source.EndMs != 1200 ||
		observation.MediaSHA256 != hex.EncodeToString(wireSHA[:]) || observation.Review.Text != "fixture observation" || observation.Review.RequestID != "audio-observation" {
		t.Fatal("observation lost authorized source or provider result")
	}
	if bytes.Contains(raw, []byte(base64.StdEncoding.EncodeToString(submitted))) || bytes.Contains(raw, []byte("review-fixture-key")) {
		t.Fatal("provider input or key leaked into main-model result")
	}
	snapshot, err := svc.assistantConfig()
	if err != nil || snapshot.AssistantModel != "main::claude-opus-5-5" {
		t.Fatal("review changed the main model")
	}
	for _, bad := range []struct {
		name  string
		patch map[string]any
	}{
		{"foreign-canvas", map[string]any{"canvasId": "foreign"}},
		{"missing-node", map[string]any{"nodeId": "missing"}},
		{"unreferenced-asset", map[string]any{"nodeId": "", "assetId": "not-referenced"}},
		{"ambiguous-source", map[string]any{"assetId": "audio-asset"}},
		{"stale-version", map[string]any{"expectedVersion": "stale"}},
		{"missing-version", map[string]any{"expectedVersion": ""}},
		{"negative-range", map[string]any{"startMs": -1}},
		{"empty-range", map[string]any{"endMs": 200}},
		{"outside-source", map[string]any{"endMs": 4000}},
		{"over-15-seconds", map[string]any{"endMs": 16000}},
		{"invalid-mode", map[string]any{"mode": "frames"}},
		{"audio-as-video", map[string]any{"mode": "video"}},
		{"blank-question", map[string]any{"question": "  "}},
		{"direct-path", map[string]any{"path": "/tmp/not-authorized.wav"}},
		{"direct-url", map[string]any{"url": "https://example.invalid/audio.wav"}},
		{"resource-without-target", map[string]any{"nodeId": "", "resourceId": resource.ID}},
		{"unreferenced-resource", map[string]any{"resourceId": "not-referenced"}},
	} {
		t.Run(bad.name, func(t *testing.T) {
			var values map[string]any
			_ = json.Unmarshal(params, &values)
			for key, value := range bad.patch {
				values[key] = value
			}
			input, _ := json.Marshal(values)
			_, err := registry.Execute(operations.Request{UserID: "local", Op: "media.review", Params: input,
				Caller: operations.AssistantCaller(&agentops.AssistantScope{CanvasID: canvasID}, true)})
			if err == nil || calls.Load() != 1 {
				t.Fatalf("invalid review reached provider: calls=%d err=%v", calls.Load(), err)
			}
		})
	}
	if _, err := registry.Execute(operations.Request{UserID: "other", Op: "media.review", Params: params, Caller: operations.ManualCaller(true)}); err == nil || calls.Load() != 1 {
		t.Fatal("foreign owner review accepted")
	}
	// An attachment may be explicitly referenced without a canvas node.
	var assetParams map[string]any
	_ = json.Unmarshal(params, &assetParams)
	delete(assetParams, "nodeId")
	assetParams["assetId"] = "audio-asset"
	assetInput, _ := json.Marshal(assetParams)
	if _, err := registry.Execute(operations.Request{UserID: "local", Op: "media.review", Params: assetInput,
		Caller: operations.AssistantCaller(&agentops.AssistantScope{CanvasID: canvasID, AssetIDs: map[string]bool{"audio-asset": true}}, true)}); err != nil || calls.Load() != 2 {
		t.Fatalf("explicit audio attachment was not reviewed: %v", err)
	}
	after, err := svc.UserCanvasProject("local", canvasID)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("audio review mutated canvas state")
	}
	desc, ok := registry.Descriptor("media.review")
	if !ok || !desc.ReadOnly || desc.Replay != "unsafe" || !strings.Contains(string(desc.Params), `"audio"`) {
		t.Fatal("audio review must remain a discoverable non-replayable paid read")
	}
}

func TestMediaReviewAudioFailureIsNotRetried(t *testing.T) {
	for _, failure := range []string{"http-error", "partial-json", "empty", "truncated", "cancel-after-submit"} {
		t.Run(failure, func(t *testing.T) {
			var calls atomic.Int32
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			media := base64.StdEncoding.EncodeToString([]byte("private-fixture-audio"))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				if body["model"] != "wand-vega-vl-1.0-flash" || body["stream"] != false || body["max_tokens"] != float64(8192) ||
					body["thinking_enabled"] != false || body["reasoning_effort"] != "none" || body["tools"] != nil {
					t.Error("audio changed bounded inference settings")
				}
				parts := body["messages"].([]any)[1].(map[string]any)["content"].([]any)
				part := parts[0].(map[string]any)
				audio, ok := part["input_audio"].(map[string]any)
				if !ok || part["type"] != "input_audio" || audio["data"] != media || audio["format"] != "wav" || part["video_url"] != nil {
					t.Error("audio failed to reach the provider contract")
				}
				switch failure {
				case "http-error":
					w.WriteHeader(502)
					w.Write([]byte("review-fixture-key " + media))
				case "partial-json":
					w.Write([]byte(`{"choices":[{"message":{"content":"private-fixture`))
				case "cancel-after-submit":
					cancel()
				case "empty", "truncated":
					text, finish := "", "stop"
					if failure == "truncated" {
						text, finish = "partial observation", "length"
					}
					json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": text}, "finish_reason": finish}}})
				}
			}))
			defer server.Close()
			svc := NewLocal(nil, t.TempDir())
			store, err := workspace.NewProviderConfig(svc.dataDir)
			if err != nil {
				t.Fatal(err)
			}
			config, _ := json.Marshal(map[string]any{"assistantModel": "main::claude-opus-5-5", "mediaReviewModel": "review::wand-vega-vl-1.0-flash",
				"channels": []any{map[string]any{"id": "review", "enabled": true, "baseUrl": server.URL + "/v1", "apiKey": "review-fixture-key",
					"models": []string{"wand-vega-vl-1.0-flash"}, "modelProfiles": []any{map[string]string{"model": "wand-vega-vl-1.0-flash", "capability": "text", "protocol": "chat-completion"}}}}})
			if err := store.SaveLocalModelConfig(config); err != nil {
				t.Fatal(err)
			}
			reviewer := svc.BindDomain(nil).(operations.MediaReviewer)
			result, err := reviewer.ReviewMedia(ctx, operations.MediaPart{MimeType: "audio/wav", Data: media}, "观察音频")
			if err == nil || result.Text != "" || calls.Load() != 1 {
				t.Fatalf("unknown/incomplete result must fail without a retry: calls=%d err=%v", calls.Load(), err)
			}
			for _, secret := range []string{"review-fixture-key", media, "private-fixture", "partial observation"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatal("provider failure exposed private input or upstream body")
				}
			}
		})
	}
}

func reviewAudioFixture(t *testing.T, format string) []byte {
	t.Helper()
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("real ffmpeg required")
	}
	path := filepath.Join(t.TempDir(), "source."+format)
	if raw, err := exec.Command(bin, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=1000:duration=2", path).CombinedOutput(); err != nil {
		t.Fatalf("audio fixture: %v %s", err, raw)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
