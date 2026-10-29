package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/workspace"
)

func TestMediaReviewProviderSendsRealVideoOnceAndRejectsIncompleteResponses(t *testing.T) {
	for _, mode := range []string{"ok", "empty", "truncated", "http-error"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			media := base64.StdEncoding.EncodeToString([]byte("bounded-real-media-fixture"))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-key" || body["model"] != "wand-vega-vl-1.0-flash" || body["stream"] != false || body["tools"] != nil || body["thinking_enabled"] != false {
					t.Fatal("wrong isolated review contract")
				}
				messages := body["messages"].([]any)
				parts := messages[1].(map[string]any)["content"].([]any)
				if parts[0].(map[string]any)["video_url"].(map[string]any)["url"] != "data:video/mp4;base64,"+media {
					t.Fatal("video bytes lost")
				}
				if mode == "http-error" {
					w.WriteHeader(502)
					w.Write([]byte("sensitive upstream failure"))
					return
				}
				text, finish := "observed two objects", "stop"
				if mode == "empty" {
					text = ""
				}
				if mode == "truncated" {
					finish = "length"
				}
				json.NewEncoder(w).Encode(map[string]any{"id": "req-1", "model": "wand-vega-vl-1.0-flash", "usage": map[string]int{"prompt_tokens": 123, "completion_tokens": 24}, "choices": []any{map[string]any{"message": map[string]string{"content": text}, "finish_reason": finish}}})
			}))
			defer server.Close()
			result, err := reviewMediaWithProvider(context.Background(), AssistantProvider{BaseURL: server.URL + "/v1", APIKey: "fixture-key", Model: "wand-vega-vl-1.0-flash"}, operations.MediaPart{MimeType: "video/mp4", Data: media}, "观察物体数量")
			if calls != 1 {
				t.Fatalf("inference retried %d times", calls)
			}
			if mode == "ok" {
				if err != nil || result.RequestID != "req-1" || result.Text != "observed two objects" || len(result.Usage) == 0 {
					t.Fatalf("missing observation %+v %v", result, err)
				}
			} else if err == nil || strings.Contains(err.Error(), "sensitive") {
				t.Fatalf("invalid completion accepted/leaked: %v", err)
			}
		})
	}
}

func TestMediaReviewReadsSavedSelectionAndNeverFallsBackToMainModel(t *testing.T) {
	calls := []string{}
	model := "wand-vega-vl-1.0-flash"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Header.Get("Authorization"))
		var request struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Model != model {
			t.Fatal("wrong selected model")
		}
		json.NewEncoder(w).Encode(map[string]any{"id": "selection", "choices": []any{map[string]any{"message": map[string]string{"content": "observed fixture"}, "finish_reason": "stop"}}})
	}))
	defer server.Close()
	service := NewLocal(nil, t.TempDir())
	store, err := workspace.NewProviderConfig(service.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	channels := []any{}
	for _, id := range []string{"first", "second"} {
		channels = append(channels, map[string]any{"id": id, "enabled": true, "baseUrl": server.URL + "/v1", "apiKey": id,
			"models": []string{model}, "modelProfiles": []any{map[string]string{"model": model, "capability": "text", "protocol": "chat-completion"}}})
	}
	session := &operationSession{service: service}
	for _, selection := range []string{"first::" + model, "second::" + model, "", "missing::" + model} {
		body, _ := json.Marshal(map[string]any{"assistantModel": "first::" + model, "mediaReviewModel": selection, "channels": channels})
		if err := store.SaveLocalModelConfig(body); err != nil {
			t.Fatal(err)
		}
		_, err := session.ReviewMedia(context.Background(), operations.MediaPart{MimeType: "video/mp4", Data: base64.StdEncoding.EncodeToString([]byte("fixture"))}, "观察视频")
		if (selection == "" || strings.HasPrefix(selection, "missing::")) != (err != nil) {
			t.Fatalf("selection result %q: %v", selection, err)
		}
	}
	if strings.Join(calls, ",") != "Bearer first,Bearer second" {
		t.Fatalf("wrong call routing: %v", calls)
	}
}
