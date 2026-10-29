package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/model"
)

const portraitTestQuote = `{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":69,"reference_video":42}}}`

func savePortraitTestCatalog(t *testing.T, s *Service, id, modelID, quote string) {
	t.Helper()
	var pricing any
	if quote != "" {
		if err := json.Unmarshal([]byte(quote), &pricing); err != nil {
			t.Fatal(err)
		}
	}
	body, err := json.Marshal(map[string]any{"channels": []any{map[string]any{
		"id": id, "enabled": true, "baseUrl": "https://enterprise.beefapi.com", "apiKey": "synthetic-key",
		"models": []string{modelID}, "modelProfiles": []any{map[string]any{"model": modelID, "capability": "video", "protocol": "newapi", "videoPricing": pricing}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SaveLocalModelConfig(body); err != nil {
		t.Fatal(err)
	}
}

func portraitTestRequest(modelID string) CreateTaskRequest {
	return CreateTaskRequest{Type: "canvas_video", Model: modelID, Prompt: "move", Input: map[string]any{
		"mode": "video", "prompt": "move", "config": map[string]any{
			"model": modelID, "baseUrl": "https://enterprise.beefapi.com", "apiKey": "synthetic-key", "interfaceType": "newapi", "vquality": "720p", "videoSeconds": "5", "size": "16:9",
			"videoPricing": json.RawMessage(portraitTestQuote),
		},
	}}
}

func TestPortraitQuoteTaskAdmission(t *testing.T) {
	for _, tc := range []struct {
		name, modelID, catalogModel, quote string
		change                             func(map[string]any)
		allowed                            bool
	}{
		{name: "2.0 current quote", modelID: "seedance-2.0-portrait", quote: portraitTestQuote, allowed: true},
		{name: "2.5 current quote", modelID: "seedance-2.5-portrait", quote: portraitTestQuote, allowed: true},
		{name: "numeric resolution", modelID: "seedance-2.0-portrait", quote: portraitTestQuote, change: func(c map[string]any) { c["vquality"] = "720" }, allowed: true},
		{name: "uppercase resolution", modelID: "seedance-2.0-portrait", quote: portraitTestQuote, change: func(c map[string]any) { c["vquality"] = "720P" }, allowed: true},
		{name: "4k resolution alias", modelID: "seedance-2.0-portrait", quote: strings.ReplaceAll(portraitTestQuote, "720p", "4k"), change: func(c map[string]any) { c["vquality"] = "2160" }, allowed: true},
		{name: "forged request quote", modelID: "seedance-2.0-portrait"},
		{name: "model removed", modelID: "seedance-2.0-portrait", catalogModel: "seedance-2.0", quote: portraitTestQuote},
		{name: "other tier quote", modelID: "seedance-2.0-portrait", catalogModel: "seedance-2.5-portrait", quote: portraitTestQuote},
		{name: "resolution unquoted", modelID: "seedance-2.0-portrait", quote: portraitTestQuote, change: func(c map[string]any) { c["vquality"] = "1080p" }},
		{name: "currency invalid", modelID: "seedance-2.0-portrait", quote: strings.ReplaceAll(portraitTestQuote, "CNY", "USD")},
		{name: "zero price", modelID: "seedance-2.0-portrait", quote: strings.ReplaceAll(portraitTestQuote, "69", "0")},
		{name: "other endpoint", modelID: "seedance-2.0-portrait", quote: portraitTestQuote, change: func(c map[string]any) { c["baseUrl"] = "https://other.example" }},
		{name: "other credential", modelID: "seedance-2.0-portrait", quote: portraitTestQuote, change: func(c map[string]any) { c["apiKey"] = "other-synthetic-key" }},
		{name: "other header", modelID: "seedance-2.0-portrait", quote: portraitTestQuote, change: func(c map[string]any) { c["headers"] = []any{map[string]any{"name": "X-Route", "value": "other"}} }},
		{name: "ordinary unaffected", modelID: "seedance-2.0", allowed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			catalogModel := tc.catalogModel
			if catalogModel == "" {
				catalogModel = tc.modelID
			}
			savePortraitTestCatalog(t, s, "custom", catalogModel, tc.quote)
			req := portraitTestRequest(tc.modelID)
			if tc.change != nil {
				tc.change(req.Input["config"].(map[string]any))
			}
			created, err := s.TaskService().CreateTask("user", toTaskCreateRequest(req))
			if tc.allowed {
				if err != nil || created.Model != tc.modelID {
					t.Fatalf("admission failed or switched tier: %v", err)
				}
			} else {
				if err == nil || !strings.Contains(err.Error(), "报价不可用") {
					t.Fatalf("expected quote rejection: %v", err)
				}
				var count int64
				if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 0 {
					t.Fatalf("rejected task persisted: count=%d error=%v", count, err)
				}
			}
		})
	}
}

func TestPortraitQuoteManagedAdmission(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	savePortraitTestCatalog(t, s, beefapi.ChannelID, "seedance-2.0-portrait", portraitTestQuote)
	req := portraitTestRequest("seedance-2.0-portrait")
	config := req.Input["config"].(map[string]any)
	config["channelId"], config["credentialRef"], config["apiKey"] = beefapi.ChannelID, beefapi.CredentialRef, ""
	if _, err := s.TaskService().CreateTask("user", toTaskCreateRequest(req)); err != nil {
		t.Fatal(err)
	}
}

func TestPortraitQuoteRetryChecksCurrentCatalogEvenWithOldProviderID(t *testing.T) {
	for _, providerID := range []string{"", "previously-accepted-provider-task"} {
		t.Run(providerID, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			savePortraitTestCatalog(t, s, "custom", "seedance-2.0-portrait", portraitTestQuote)
			created, err := s.CreateTask("user", portraitTestRequest("seedance-2.0-portrait"))
			if err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&model.Task{}).Where("id = ?", created.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "rate limit exceeded", "provider_request_id": providerID}).Error; err != nil {
				t.Fatal(err)
			}
			savePortraitTestCatalog(t, s, "custom", "seedance-2.0-portrait", "")
			if _, err := s.TaskService().Retry("user", created.ID); err == nil || !strings.Contains(err.Error(), "报价不可用") {
				t.Fatalf("retry accepted stale quote: %v", err)
			}
			stored, err := s.repo.Task(created.ID)
			if err != nil || stored.Status != model.TaskStatusFailed || stored.ProviderRequestID != providerID {
				t.Fatalf("rejected retry mutated task: %v", err)
			}
			savePortraitTestCatalog(t, s, "custom", "seedance-2.0-portrait", portraitTestQuote)
			retried, err := s.TaskService().Retry("user", created.ID)
			if err != nil || retried.Status != model.TaskStatusQueued || retried.ProviderRequestID != "" {
				t.Fatalf("fresh retry failed: %v", err)
			}
		})
	}
}

func TestPortraitQuoteCreationPreparation(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	savePortraitTestCatalog(t, s, "custom", "seedance-2.0-portrait", "")
	_, err := (creationTasksAdapter{s}).Prepare("user", toCreationTaskRequest(portraitTestRequest("seedance-2.0-portrait")))
	if err == nil || !strings.Contains(err.Error(), "报价不可用") {
		t.Fatalf("creation preparation bypassed quote: %v", err)
	}
}

func TestPortraitQuoteRemovalDoesNotBlockAcceptedTaskRecovery(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var posts, polls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			posts.Add(1)
			t.Error("recovery attempted a new submission")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Path != "/v1/video/generations/accepted-portrait-task" {
			t.Errorf("unexpected recovery path: %s", r.URL.Path)
		}
		polls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":"success","data":{"task_id":"accepted-portrait-task","status":"IN_PROGRESS"}}`))
	}))
	defer upstream.Close()
	s, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, s, db)
	req := portraitTestRequest("seedance-2.0-portrait")
	config := req.Input["config"].(map[string]any)
	config["baseUrl"], config["interfaceType"] = upstream.URL, "newapi-channel-2"
	body, err := json.Marshal(req.Input)
	if err != nil {
		t.Fatal(err)
	}
	// Represents an already accepted task whose model/quote has since vanished.
	task := model.Task{ID: "portrait-recovery", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "accepted-portrait-task", InputJSON: string(body)}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	result, err := s.QueryFailedVideoTask(context.Background(), "local", task.ID)
	if err != nil || result.Task.ProviderRequestID != task.ProviderRequestID || polls.Load() != 1 || posts.Load() != 0 {
		t.Fatalf("accepted task could not resume polling without quote: error=%v polls=%d posts=%d", err, polls.Load(), posts.Load())
	}
}
