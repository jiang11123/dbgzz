package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"gorm.io/gorm"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
)

func workflowFixture(t *testing.T) (*Service, *gorm.DB, cw.Definition) {
	t.Helper()
	svc, db := newTimelineTaskTestService(t)
	svc.dataDir = t.TempDir()
	for _, id := range []string{"old-person", "new-person", "fixed-mask"} {
		if e := db.Create(&model.Resource{ID: id, UserID: "owner", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; e != nil {
			t.Fatal(e)
		}
	}
	for _, id := range []string{"old-action", "old-depth", "new-depth", "old-output", "new-output"} {
		if e := db.Create(&model.Resource{ID: id, UserID: "owner", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", DurationMs: 1000}).Error; e != nil {
			t.Fatal(e)
		}
	}
	input := `{"mode":"video","prompt":"person performs action","config":{"channelId":"channel","apiKey":"recipe-secret"},"referenceImages":[{"storageKey":"resource:old-person","url":"/api/resources/old-person/file"}],"referenceVideos":[{"storageKey":"resource:old-depth"}],"mask":{"storageKey":"resource:fixed-mask"},"metadata":{"nodeId":"original-node","clientOperationId":"original-op"}}`
	if e := db.Create(&model.Task{ID: "original", UserID: "owner", Type: "canvas_video", Status: model.TaskStatusSucceeded, Prompt: "person performs action", InputJSON: input, ResultJSON: `{"videos":[{"resourceId":"old-output"}]}`}).Error; e != nil {
		t.Fatal(e)
	}
	d := cw.Definition{Version: 1, Nodes: []cw.Node{{ID: "gen", Title: "Generate", Role: "generation", MediaType: "video", ResourceID: "old-output", SourceTaskID: "original"}, {ID: "depth", Title: "Depth", Role: "depth", MediaType: "video", ResourceID: "old-depth"}, {ID: "person", Title: "Person", Role: "input", MediaType: "image", ResourceID: "old-person"}, {ID: "action", Title: "Action", Role: "input", MediaType: "video", ResourceID: "old-action"}}, Edges: []cw.Edge{{From: "action", To: "depth"}, {From: "person", To: "gen"}, {From: "depth", To: "gen"}}, OutputNodeIDs: []string{"gen"}}
	return svc, db, d
}

func TestCanvasWorkflowCompilesProtectedRecipeAndReplacesSlots(t *testing.T) {
	svc, db, d := workflowFixture(t)
	var original model.Task
	if e := db.First(&original, "id = ?", "original").Error; e != nil {
		t.Fatal(e)
	}
	var originalInput map[string]any
	if e := json.Unmarshal([]byte(original.InputJSON), &originalInput); e != nil {
		t.Fatal(e)
	}
	first := originalInput["referenceImages"].([]any)[0].(map[string]any)
	first["id"] = "logical-person-slot"
	first["name"] = "Person reference"
	first["role"] = "first_frame"
	metadata := originalInput["metadata"].(map[string]any)
	metadata["videoReferenceOrder"] = []any{"first", "subject"}
	metadata["videoMiddleFrameTime"] = 0.5
	metadata["providerOptions"] = map[string]any{"motionStrength": 0.8}
	metadata["retryOf"] = "old-retry-parent"
	metadata["attemptGroupId"] = "old-attempt-group"
	metadata["providerTaskId"] = "old-provider-task"
	originalInput["retryOf"] = "old-retry-parent"
	originalRaw, _ := json.Marshal(originalInput)
	if e := db.Model(&original).Update("input_json", string(originalRaw)).Error; e != nil {
		t.Fatal(e)
	}
	template, e := svc.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Motion", Definition: d})
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(template)
	if strings.Contains(string(raw), "recipe-secret") || strings.Contains(string(raw), "config") {
		t.Fatal("public template exposes private recipe")
	}
	var row model.CanvasWorkflow
	if e = db.First(&row, "id = ?", template.ID).Error; e != nil {
		t.Fatal(e)
	}
	if strings.Contains(row.RecipeCipher, "recipe-secret") || !strings.HasPrefix(row.RecipeCipher, encryptedSettingPrefix) {
		t.Fatal("recipe not encrypted at rest")
	}
	plain, e := svc.decryptSettingSecret(row.RecipeCipher)
	if e != nil {
		t.Fatal(e)
	}
	var recipes workflowRecipes
	if e = json.Unmarshal([]byte(plain), &recipes); e != nil {
		t.Fatal(e)
	}
	nodes := map[string]cw.Node{}
	for _, n := range d.Nodes {
		nodes[n.ID] = n
	}
	steps := map[string]*cw.Step{"person": {Status: "succeeded", ResourceID: "new-person"}, "depth": {Status: "succeeded", ResourceID: "new-depth"}}
	req, e := svc.materializeCanvasWorkflowRequest("owner", "new-op", recipes["gen"], nodes, steps)
	if e != nil {
		t.Fatal(e)
	}
	encoded, _ := json.Marshal(req.Input)
	if strings.Contains(string(encoded), "old-person") || strings.Contains(string(encoded), "old-depth") || strings.Contains(string(encoded), "original-node") {
		t.Fatalf("old binding survived: %s", encoded)
	}
	if len(req.Input["referenceImages"].([]any)) != 1 || len(req.Input["referenceVideos"].([]any)) != 1 {
		t.Fatal("replacement appended old media")
	}
	replacement := req.Input["referenceImages"].([]any)[0].(map[string]any)
	if replacement["id"] != "logical-person-slot" || replacement["name"] != "Person reference" || replacement["role"] != "first_frame" {
		t.Fatalf("slot semantics lost: %+v", replacement)
	}
	currentMetadata := req.Input["metadata"].(map[string]any)
	if currentMetadata["retryOf"] != nil || currentMetadata["attemptGroupId"] != nil || currentMetadata["providerTaskId"] != nil || req.Input["retryOf"] != nil {
		t.Fatalf("old task identity survived: %+v", currentMetadata)
	}
	if currentMetadata["videoMiddleFrameTime"] != 0.5 || currentMetadata["videoReferenceOrder"] == nil || currentMetadata["providerOptions"] == nil {
		t.Fatalf("execution metadata lost: %+v", currentMetadata)
	}
	if !strings.Contains(string(encoded), "fixed-mask") {
		t.Fatal("fixed external reference lost")
	}
	var refs []model.CanvasWorkflowResource
	_ = db.Where("owner_id = ?", template.ID).Find(&refs).Error
	protected := false
	for _, ref := range refs {
		if ref.ResourceID == "fixed-mask" {
			protected = true
		}
	}
	if !protected {
		t.Fatal("fixed external resource is not protected")
	}
	if e = svc.repo.DeleteResource("owner", "fixed-mask"); e == nil {
		t.Fatal("template resource can be deleted")
	}
	if _, e = svc.CanvasWorkflow("other", template.ID); e == nil {
		t.Fatal("foreign template is visible")
	}
}

func TestCanvasWorkflowRejectsAmbiguousAndForeignSource(t *testing.T) {
	svc, db, d := workflowFixture(t)
	d.Nodes[2].ResourceID = "new-person"
	if _, e := svc.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Bad binding", Definition: d}); e == nil || !strings.Contains(e.Error(), "映射") {
		t.Fatalf("unmatched media accepted: %v", e)
	}
	d.Nodes[2].ResourceID = "old-person"
	if e := db.Model(&model.Task{}).Where("id = ?", "original").Update("user_id", "other").Error; e != nil {
		t.Fatal(e)
	}
	if _, e := svc.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Foreign source", Definition: d}); e == nil {
		t.Fatal("foreign task accepted")
	}
}

func TestCanvasWorkflowRunReconcilesReceiptsAndKeepsSnapshot(t *testing.T) {
	svc, db, d := workflowFixture(t)
	template, e := svc.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Motion", Definition: d})
	if e != nil {
		t.Fatal(e)
	}
	request := cw.RunRequest{ClientOperationID: "confirmed-1", Inputs: map[string]cw.Value{"person": {ResourceID: "new-person"}}}
	run, e := svc.StartCanvasWorkflow("owner", template.ID, request)
	if e != nil {
		t.Fatal(e)
	}
	replay, e := svc.StartCanvasWorkflow("owner", template.ID, request)
	if e != nil || replay.ID != run.ID {
		t.Fatalf("run replay=%+v err=%v", replay, e)
	}
	request.Inputs["person"] = cw.Value{ResourceID: "old-person"}
	if _, e = svc.StartCanvasWorkflow("owner", template.ID, request); e == nil {
		t.Fatal("different inputs replayed")
	}
	// Simulate the process exiting after task admission but before saving taskId.
	for node, result := range map[string]string{"depth": "new-depth", "gen": "new-output"} {
		op := workflowOperation(run.ID, node)
		if e = db.Create(&model.Task{ID: "admitted-" + node, UserID: "owner", Type: "canvas_video", Status: model.TaskStatusSucceeded, ClientOperationID: &op, ResultJSON: `{"resourceId":"` + result + `"}`}).Error; e != nil {
			t.Fatal(e)
		}
	}
	if e = svc.DeleteCanvasWorkflow("owner", template.ID); e != nil {
		t.Fatal(e)
	}
	svc.advanceCanvasWorkflows(context.Background())
	finished, e := svc.CanvasWorkflowRun("owner", run.ID)
	if e != nil {
		t.Fatal(e)
	}
	if finished.Status != "succeeded" || len(finished.Outputs) != 1 || finished.Outputs[0].ResourceID != "new-output" {
		t.Fatalf("recovered run=%+v", finished)
	}
	var count int64
	_ = db.Model(&model.Task{}).Count(&count).Error
	if count != 3 {
		t.Fatalf("recovery submitted duplicate tasks, count=%d", count)
	}
	if e = svc.repo.DeleteResource("owner", "new-output"); e == nil {
		t.Fatal("run output can be deleted")
	}
	if _, e = svc.CanvasWorkflowRun("other", run.ID); e == nil {
		t.Fatal("foreign run visible")
	}
}

func TestCanvasWorkflowCancelPreventsAdmission(t *testing.T) {
	svc, db, d := workflowFixture(t)
	template, e := svc.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Motion", Definition: d})
	if e != nil {
		t.Fatal(e)
	}
	run, e := svc.StartCanvasWorkflow("owner", template.ID, cw.RunRequest{ClientOperationID: "cancel-me"})
	if e != nil {
		t.Fatal(e)
	}
	run, e = svc.CancelCanvasWorkflow(context.Background(), "owner", run.ID)
	if e != nil || run.Status != "cancelled" {
		t.Fatalf("cancel=%+v %v", run, e)
	}
	svc.advanceCanvasWorkflows(context.Background())
	var count int64
	_ = db.Model(&model.Task{}).Count(&count).Error
	if count != 1 {
		t.Fatal("cancelled workflow admitted tasks")
	}
}

func TestCanvasWorkflowPromptSubstitutionUsesOriginalOffsets(t *testing.T) {
	svc, _, _ := workflowFixture(t)
	recipe := workflowRecipe{Request: CreateTaskRequest{Input: map[string]any{"prompt": "AAA BBB"}}, Bindings: []workflowBinding{{NodeID: "a", Field: "prompt", Index: 0, Original: "AAA"}, {NodeID: "b", Field: "prompt", Index: 4, Original: "BBB"}}}
	req, e := svc.materializeCanvasWorkflowRequest("owner", "op", recipe, nil, map[string]*cw.Step{"a": {Status: "succeeded", Text: "BBB"}, "b": {Status: "succeeded", Text: "new"}})
	if e != nil || req.Prompt != "BBB new" {
		t.Fatalf("prompt=%q err=%v", req.Prompt, e)
	}
}

func TestCanvasWorkflowDepthUsesExistingAdmissionAndReplays(t *testing.T) {
	svc, db, d := workflowFixture(t)
	d.Nodes = []cw.Node{d.Nodes[1], d.Nodes[3]}
	d.Edges = []cw.Edge{{From: "action", To: "depth"}}
	d.OutputNodeIDs = []string{"depth"}
	// Historical imports used kind=media; the shared MIME normalization applies.
	if e := db.Model(&model.Resource{}).Where("id = ?", "old-action").Update("kind", "media").Error; e != nil {
		t.Fatal(e)
	}
	template, e := svc.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Depth only", Definition: d})
	if e != nil {
		t.Fatal(e)
	}
	run, e := svc.StartCanvasWorkflow("owner", template.ID, cw.RunRequest{ClientOperationID: "depth-admission"})
	if e != nil {
		t.Fatal(e)
	}
	svc.advanceCanvasWorkflows(context.Background())
	first, e := svc.CanvasWorkflowRun("owner", run.ID)
	if e != nil {
		t.Fatal(e)
	}
	if first.Status != "running" {
		t.Fatalf("run=%+v", first)
	}
	task, e := svc.repo.TaskByClientOperation("owner", workflowOperation(run.ID, "depth"))
	if e != nil || task == nil || task.Type != model.TaskTypeDepthCapture || task.Status != model.TaskStatusQueued {
		t.Fatalf("depth admission task=%+v err=%v", task, e)
	}
	svc.advanceCanvasWorkflows(context.Background())
	second, e := svc.CanvasWorkflowRun("owner", run.ID)
	if e != nil || len(second.Outputs) != 0 {
		t.Fatalf("pending outputs=%+v err=%v", second, e)
	}
	var count int64
	_ = db.Model(&model.Task{}).Where("client_operation_id = ?", workflowOperation(run.ID, "depth")).Count(&count).Error
	if count != 1 {
		t.Fatal("polling admitted duplicate depth task")
	}
}

func TestCanvasWorkflowResolvesCurrentConnectionAndRejectsRemovedModel(t *testing.T) {
	svc, _, _ := workflowFixture(t)
	svc.mode = serviceModeLocal
	initial := `{"channels":[{"id":"custom","baseUrl":"https://example.test/v1","apiKey":"first-key","enabled":true,"models":["video-model"],"modelProfiles":[{"model":"video-model","protocol":"openai-video","capability":"video"}]}]}`
	if e := svc.SaveLocalModelConfig([]byte(initial)); e != nil {
		t.Fatal(e)
	}
	input := map[string]any{"mode": "video", "config": map[string]any{"baseUrl": "https://example.test/v1", "model": "video-model", "interfaceType": "openai-video", "apiKey": "historical-key"}}
	id, e := svc.canvasWorkflowChannelID(input, "")
	if e != nil || id != "custom" {
		t.Fatalf("channel=%q err=%v", id, e)
	}
	if e = svc.SaveLocalModelConfig([]byte(strings.Replace(initial, "first-key", "current-key", 1))); e != nil {
		t.Fatal(e)
	}
	if e = svc.refreshCanvasWorkflowCredentials(input, id); e != nil {
		t.Fatal(e)
	}
	config := input["config"].(map[string]any)
	if config["apiKey"] != "current-key" {
		t.Fatal("used historical credential")
	}
	if e = svc.SaveLocalModelConfig([]byte(strings.Replace(initial, `"models":["video-model"]`, `"models":[]`, 1))); e != nil {
		t.Fatal(e)
	}
	if e = svc.refreshCanvasWorkflowCredentials(input, id); e == nil || !strings.Contains(e.Error(), "模型") {
		t.Fatalf("removed model accepted: %v", e)
	}
}

func TestCanvasWorkflowRetryRefreshesOnlyUnacceptedCredentials(t *testing.T) {
	for _, scenario := range []string{"new key", "unchanged key", "deleted channel", "disabled channel", "accepted receipt"} {
		t.Run(scenario, func(t *testing.T) {
			svc, db, _ := workflowFixture(t)
			svc.mode = serviceModeLocal
			config := `{"channels":[{"id":"custom","baseUrl":"https://example.test/v1","apiKey":"current-key","enabled":true,"models":["text-model"],"modelProfiles":[{"model":"text-model","protocol":"chat-completion","capability":"text"}]}]}`
			if scenario == "deleted channel" {
				config = `{"channels":[]}`
			}
			if scenario == "disabled channel" {
				config = strings.Replace(config, `"enabled":true`, `"enabled":false`, 1)
			}
			if scenario == "unchanged key" {
				config = strings.Replace(config, "current-key", "expired-key", 1)
			}
			if e := svc.SaveLocalModelConfig([]byte(config)); e != nil {
				t.Fatal(e)
			}
			input := map[string]any{"mode": "text", "prompt": "keep original prompt", "metadata": map[string]any{"clientOperationId": "stable-task-operation", "providerOptions": map[string]any{"keep": "original"}}, "config": map[string]any{"baseUrl": "https://example.test/v1", "apiKey": "expired-key", "model": "text-model", "interfaceType": "chat-completion"}}
			if e := svc.protectTaskSecrets(input); e != nil {
				t.Fatal(e)
			}
			encoded, _ := json.Marshal(input)
			operation := "stable-task-operation"
			task := model.Task{ID: "failed-generation", UserID: "owner", Type: "canvas_text", Status: model.TaskStatusFailed, Prompt: "keep original prompt", Model: "text-model", InputJSON: string(encoded), Error: "HTTP 401 unauthorized", ClientOperationID: &operation}
			if scenario == "accepted receipt" {
				task.ProviderRequestID = "accepted-provider-job"
				task.Stage = "submission_unknown"
			}
			if e := db.Create(&task).Error; e != nil {
				t.Fatal(e)
			}
			recipes, _ := json.Marshal(workflowRecipes{"gen": {ChannelID: "custom"}})
			cipher, e := svc.encryptSettingSecret(string(recipes))
			if e != nil {
				t.Fatal(e)
			}
			state, _ := json.Marshal(cw.Run{Status: "failed", Steps: []cw.Step{{NodeID: "gen", Title: "Generate", Status: "failed", TaskID: task.ID}}, Outputs: []cw.Output{}})
			row := model.CanvasWorkflowRun{ID: "retry-run", UserID: "owner", TemplateID: "template", ClientOperationID: "stable-run-operation", RecipeCipher: cipher, Status: "failed", StateJSON: string(state)}
			if e = db.Create(&row).Error; e != nil {
				t.Fatal(e)
			}
			if scenario == "accepted receipt" {
				if _, retryErr := svc.taskDomain().RetryWithCredentialRefresh("owner", task.ID, task.InputJSON, task.InputJSON); retryErr == nil {
					t.Fatal("accepted task allowed a fresh credential retry")
				}
				prepared, prepareErr := svc.prepareCanvasWorkflowRetryCredentials(row, "gen", &task)
				if prepareErr != nil || prepared != "" {
					t.Fatalf("accepted receipt refreshed: input=%q err=%v", prepared, prepareErr)
				}
				stored, e := svc.repo.Task(task.ID)
				if e != nil {
					t.Fatal(e)
				}
				if stored.InputJSON != task.InputJSON || stored.ProviderRequestID != "accepted-provider-job" || stored.Status != model.TaskStatusFailed {
					t.Fatal("accepted request recovery identity was changed")
				}
				return
			}
			run, e := svc.RetryCanvasWorkflow("owner", row.ID)
			stored, loadErr := svc.repo.Task(task.ID)
			if loadErr != nil {
				t.Fatal(loadErr)
			}
			if scenario != "new key" {
				if e == nil || stored.Status != model.TaskStatusFailed || stored.InputJSON != task.InputJSON {
					t.Fatalf("removed/disabled connection revived: error=%v task=%+v", e, stored)
				}
				return
			}
			if e != nil || run.Status != "queued" || stored.Status != model.TaskStatusQueued {
				t.Fatalf("retry run=%+v err=%v taskStatus=%s", run, e, stored.Status)
			}
			plain, e := svc.decryptTaskInputJSON(stored.InputJSON)
			if e != nil {
				t.Fatal(e)
			}
			var updated map[string]any
			if e = json.Unmarshal([]byte(plain), &updated); e != nil {
				t.Fatal(e)
			}
			if updated["config"].(map[string]any)["apiKey"] != "current-key" || updated["prompt"] != "keep original prompt" || updated["metadata"].(map[string]any)["providerOptions"] == nil {
				t.Fatal("retry failed to refresh only credentials")
			}
			if strings.Contains(stored.InputJSON, "current-key") {
				t.Fatal("refreshed retry credential persisted in plaintext")
			}
			var count int64
			_ = db.Model(&model.Task{}).Where("client_operation_id = ?", operation).Count(&count).Error
			if count != 1 || run.Steps[0].TaskID != task.ID {
				t.Fatal("retry created another generation identity")
			}
		})
	}
}
