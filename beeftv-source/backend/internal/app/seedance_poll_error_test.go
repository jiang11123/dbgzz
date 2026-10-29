package app

import (
	"context"
	"infinite-canvas/backend/internal/generation"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSeedancePollingPreservesUnavailableCode(t *testing.T) {
	state := map[string]interface{}{"error": map[string]interface{}{
		"code":    "model_temporarily_unavailable",
		"message": "无可用线路：当前售价档位 standard 暂无可用线路，线路可能维护中或模型不存在",
	}}
	raw := seedanceErrorMessage(state)
	failure := generation.ClassifyText(raw)
	if failure.Category != generation.CategoryProviderUnavailable || failure.ProviderCode != "model_temporarily_unavailable" {
		t.Fatalf("polling lost authoritative provider code: %#v", failure)
	}
	if got := generation.ClassifyText(failure.UserMessage()); got.Category != generation.CategoryProviderUnavailable {
		t.Fatalf("persisted user message changed category: %#v", got)
	}
}

func TestSeedancePollingPreservesCodeOnly(t *testing.T) {
	raw := seedanceErrorMessage(map[string]interface{}{"error": map[string]interface{}{"code": "model_temporarily_unavailable"}})
	if got := generation.ClassifyText(raw); got.Category != generation.CategoryProviderUnavailable {
		t.Fatalf("code-only error lost: %#v", got)
	}
}

func TestSeedancePollingNestedGatewayUnavailable(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"task-failed","status":"failed","error":{"code":"","message":"{\"error\":{\"code\":\"model_temporarily_unavailable\",\"message\":\"无可用线路：当前售价档位 standard 暂无可用线路，线路可能维护中或模型不存在\",\"type\":\"invalid_request_error\"}}"}}`))
	}))
	defer server.Close()
	var state map[string]interface{}
	err := getJSON(context.Background(), providerConfig{BaseURL: server.URL}, "/videos/task-failed", &state)
	if err == nil {
		t.Fatal("expected terminal provider failure")
	}
	failure := generation.ClassifyText(err.Error())
	if failure.Category != generation.CategoryProviderUnavailable || strings.Contains(failure.UserMessage(), "模型名称") {
		t.Fatalf("wrong public error: %#v", failure)
	}
}
