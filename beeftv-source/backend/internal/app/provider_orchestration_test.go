package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
)

func TestProcessCanvasGenerationNoVariantSKUPostsOnceWithProviderKey(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var posts atomic.Int32
	var postedModel string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		postedModel, _ = payload["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	t.Cleanup(server.Close)

	service, db := newTimelineTaskTestService(t)
	service.dataDir = t.TempDir()
	service.coordinator = platform.NewLocalCoordinator()
	channel := model.ModelChannel{
		ID: "channel-sku", Scope: model.ChannelScopeSystem, Enabled: true, Name: "Seedance",
		BaseURL: server.URL, APIKey: "test-key", APIFormat: "openai",
	}
	if err := service.encryptSystemChannelSecrets(&channel); err != nil {
		t.Fatal(err)
	}
	item := model.ChannelModel{
		ID: "model-sku", ChannelID: channel.ID, ModelKey: "seedance-2-5-480p", ProviderModelKey: "doubao-seedance-2-5",
		Capability: "text", Protocol: model.ChannelInterfaceChatCompletion, Enabled: true,
	}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "task-sku", UserID: "user", Type: "canvas_text", Status: model.TaskStatusRunning}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(canvasGenerationInput{
		Mode:   "text",
		Prompt: "hello",
		Config: providerConfig{ChannelID: channel.ID, ChannelModelKey: item.ModelKey, Model: item.ModelKey},
	})
	ctx := withProviderAnalytics(context.Background(), service, task)
	result, err := service.processCanvasGenerationTask(ctx, task.UserID, "", task.Type, "", string(raw))
	if err != nil {
		t.Fatalf("processCanvasGenerationTask: %v", err)
	}
	if result["text"] != "ok" {
		t.Fatalf("result = %#v", result)
	}
	if posts.Load() != 1 {
		t.Fatalf("upstream POSTs = %d, want 1", posts.Load())
	}
	if postedModel != item.ProviderModelKey {
		t.Fatalf("upstream model = %q, want %q", postedModel, item.ProviderModelKey)
	}

	posts.Store(0)
	hostile, _ := json.Marshal(canvasGenerationInput{
		Mode:   "text",
		Prompt: "hello",
		Config: providerConfig{ChannelID: channel.ID, ChannelModelKey: item.ModelKey, Model: "gpt-4"},
	})
	_, err = service.processCanvasGenerationTask(ctx, task.UserID, "", task.Type, "", string(hostile))
	if err == nil || !strings.Contains(err.Error(), "系统渠道模型标识不一致") {
		t.Fatalf("hostile mismatch error = %v", err)
	}
	if posts.Load() != 0 {
		t.Fatalf("hostile mismatch still posted %d times", posts.Load())
	}
}

func TestCanvasTextStreamsVisibleTextAndAgentRequestsKeepReasoningOutOfTaskBody(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"reasoning_content":"内部分析","content":"可见回答"}}]}

data: [DONE]

`))
	}))
	t.Cleanup(server.Close)
	service, db := newTimelineTaskTestService(t)
	service.dataDir = t.TempDir()
	service.coordinator = platform.NewLocalCoordinator()

	textTask := model.Task{ID: "task-text", UserID: "user", Type: "canvas_text", Status: model.TaskStatusTextReplay}
	agentTask := model.Task{ID: "task-agent", UserID: "user", Type: "canvas_text", Status: model.TaskStatusTextReplay}
	if err := db.Create(&textTask).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&agentTask).Error; err != nil {
		t.Fatal(err)
	}

	textRaw, _ := json.Marshal(canvasGenerationInput{
		Mode:   "text",
		Prompt: "hello",
		Config: providerConfig{BaseURL: server.URL, APIKey: "key", Model: "text-model", InterfaceType: "chat-completion"},
	})
	ctx := withProviderAnalytics(context.Background(), service, textTask)
	textResult, err := service.processCanvasGenerationTask(ctx, textTask.UserID, "", textTask.Type, "", string(textRaw))
	if err != nil {
		t.Fatalf("ordinary canvas_text: %v", err)
	}
	if textResult["text"] != "可见回答" {
		t.Fatalf("ordinary result = %#v", textResult)
	}
	replay, err := service.TaskTextReplay(textTask.UserID, textTask.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	joined := joinTaskText(replay.Deltas)
	if joined != "可见回答" {
		t.Fatalf("ordinary task body = %q", joined)
	}
	if strings.Contains(joined, "内部分析") {
		t.Fatalf("ordinary task body mixed reasoning: %q", joined)
	}

	agentRaw, _ := json.Marshal(canvasGenerationInput{
		Mode:   "text",
		Prompt: "tool",
		Config: providerConfig{BaseURL: server.URL, APIKey: "key", Model: "text-model", InterfaceType: "chat-completion"},
		AgentRequests: &agentToolRequests{ChatCompletion: map[string]interface{}{
			"messages": []interface{}{map[string]interface{}{"role": "user", "content": "hi"}},
		}},
	})
	ctx = withProviderAnalytics(context.Background(), service, agentTask)
	agentResult, err := service.processCanvasGenerationTask(ctx, agentTask.UserID, "", agentTask.Type, "", string(agentRaw))
	if err != nil {
		t.Fatalf("agent canvas_text: %v", err)
	}
	if agentResult["text"] != "可见回答" {
		t.Fatalf("agent result = %#v", agentResult)
	}
	if agentResult["reasoning"] != "内部分析" {
		t.Fatalf("agent reasoning lost: %#v", agentResult)
	}
	agentReplay, err := service.TaskTextReplay(agentTask.UserID, agentTask.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	agentBody := joinTaskText(agentReplay.Deltas)
	if agentBody != "" {
		t.Fatalf("legacy AgentRequests wrote task body %q", agentBody)
	}
}

func joinTaskText(deltas []model.TaskTextDelta) string {
	var b strings.Builder
	for _, delta := range deltas {
		b.WriteString(delta.Content)
	}
	return b.String()
}
