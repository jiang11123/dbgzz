package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"infinite-canvas/backend/internal/outbound"
)

func TestRunningHubVideoPollRecoversFromTransientGatewayFailure(t *testing.T) {
	allowLoopbackProviderTest(t)
	pollCalls := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/task/openapi/outputs":
			pollCalls++
			w.Header().Set("Content-Type", "application/json")
			if pollCalls == 1 {
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			_, _ = w.Write([]byte(`{"code":0,"data":[{"fileUrl":"` + server.URL + `/result.mp4"}]}`))
		case "/result.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("video"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	config := providerConfig{BaseURL: server.URL, APIKey: "test-key"}
	ctx := context.Background()
	result, err := (&Service{}).pollRunningHubVideoWorkflowWithPolicy(ctx, config, server.URL, "provider-task-1", fastVideoPollPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if result["mode"] != "video" || pollCalls != 2 {
		t.Fatalf("result = %#v, poll calls = %d", result, pollCalls)
	}
}

func TestRunningHubVideoRenewalOnlyQueriesOriginalOutputs(t *testing.T) {
	allowLoopbackProviderTest(t)
	payload, err := os.ReadFile("testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	mediaReads, polls, creates := 0, 0, 0
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mediaReads++
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Private-Channel") != "" || r.URL.Query().Get("apiKey") != "" {
			t.Error("workflow credential leaked to external media")
		}
		if mediaReads == 1 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(payload)
	}))
	defer media.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/task/openapi/outputs" {
			creates++
			t.Error("renewal entered a create or schema path")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.Method != http.MethodPost || body["taskId"] != "original" || body["apiKey"] != "provider-key" || r.Header.Get("X-Private-Channel") != "private-fixture" || r.URL.Query().Get("delivery") != "" {
			t.Error("workflow original-task query contract changed")
		}
		polls++
		if polls == 2 {
			_, _ = w.Write([]byte(`{"code":804}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"code": 0, "data": []interface{}{map[string]interface{}{"fileUrl": media.URL + "/no-extension?apiKey=provider-key&signature=media-signature"}}})
	}))
	defer provider.Close()
	config := providerConfig{BaseURL: provider.URL, APIKey: "provider-key", Headers: []outbound.OutboundHeader{{Name: "X-Private-Channel", Value: "private-fixture"}, {Name: "Cookie", Value: "session=private-cookie"}}}
	result, err := (&Service{}).pollRunningHubVideoWorkflowWithPolicy(context.Background(), config, provider.URL, "original", fastVideoPollPolicy())
	if err != nil {
		t.Fatal(err)
	}
	video := result["video"].(map[string]interface{})
	mimeType, data, err := decodeProviderDataURL(video["dataUrl"].(string))
	if err != nil || mimeType != "video/mp4" || !bytes.Equal(data, payload) || polls != 3 || mediaReads != 2 || creates != 0 {
		t.Fatalf("mime=%s bytes=%d polls=%d media=%d creates=%d err=%v", mimeType, len(data), polls, mediaReads, creates, err)
	}
}
