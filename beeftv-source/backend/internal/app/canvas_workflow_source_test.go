package app

import (
	"encoding/json"
	"strings"
	"testing"

	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
)

func TestCanvasWorkflowSourceSurvivesCompletionAndDeliveryCleanup(t *testing.T) {
	for _, mode := range []string{"image", "video", "audio", "text"} {
		t.Run(mode, func(t *testing.T) {
			svc, db, _ := workflowFixture(t)
			var source model.Task
			if err := db.First(&source, "id = ?", "original").Error; err != nil {
				t.Fatal(err)
			}
			var input map[string]any
			if err := json.Unmarshal([]byte(source.InputJSON), &input); err != nil {
				t.Fatal(err)
			}
			input["mode"] = mode
			delete(input, "referenceVideos")
			input["config"].(map[string]any)["quality"] = "original-quality"
			encoded, _ := json.Marshal(input)
			source.Type = "canvas_" + mode
			source.Status = model.TaskStatusRunning
			source.InputJSON = string(encoded)
			if err := db.Save(&source).Error; err != nil {
				t.Fatal(err)
			}
			resourceID := "old-person"
			if mode == "video" {
				resourceID = "old-output"
			}
			if mode == "audio" {
				resourceID = "audio-output"
				if err := db.Create(&model.Resource{ID: resourceID, UserID: "owner", Kind: "audio", MimeType: "audio/mpeg", Status: model.ResourceStatusReady}).Error; err != nil {
					t.Fatal(err)
				}
			}
			result := []byte(`{"resourceId":"` + resourceID + `"}`)
			if mode == "text" {
				result = []byte(`{"text":"original generated text"}`)
				resourceID = ""
			}
			if err := svc.saveTaskCompletionWithinStorageQuota(&source, result, nil, false); err != nil {
				t.Fatal(err)
			}
			stored, err := svc.repo.Task(source.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stored.WorkflowSourceCipher == "" || strings.Contains(stored.WorkflowSourceCipher, "recipe-secret") || strings.Contains(stored.InputJSON, "referenceImages") {
				t.Fatal("completion did not atomically retain private recipe while compacting public input")
			}
			cipher := stored.WorkflowSourceCipher
			if err = svc.repo.FinishGenerationDelivery(stored.UserID, stored.ID, stored.InputJSON, publicTaskInputJSON(stored.InputJSON)); err != nil {
				t.Fatal(err)
			}
			stored, err = svc.repo.Task(source.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stored.WorkflowSourceCipher != cipher {
				t.Fatal("delivery cleanup removed original command")
			}
			public, _ := json.Marshal(taskForOutput(*stored))
			if strings.Contains(string(public), "WorkflowSourceCipher") || strings.Contains(string(public), cipher) {
				t.Fatal("task API exposed private source snapshot")
			}
			d := cw.Definition{Version: 1, Nodes: []cw.Node{{ID: "person", Title: "Person", MediaType: "image", Role: "input", ResourceID: "old-person"}, {ID: "generate", Title: "Generate", MediaType: mode, Role: "generation", ResourceID: resourceID, SourceTaskID: source.ID}}, Edges: []cw.Edge{{From: "person", To: "generate"}}, OutputNodeIDs: []string{"generate"}}
			template, err := svc.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Completed source", Definition: d})
			if err != nil {
				t.Fatal(err)
			}
			var row model.CanvasWorkflow
			if err = db.First(&row, "id = ?", template.ID).Error; err != nil {
				t.Fatal(err)
			}
			plain, err := svc.decryptSettingSecret(row.RecipeCipher)
			if err != nil {
				t.Fatal(err)
			}
			var recipes workflowRecipes
			if err = json.Unmarshal([]byte(plain), &recipes); err != nil {
				t.Fatal(err)
			}
			recipe := recipes["generate"]
			if len(recipe.Bindings) != 1 || recipe.Request.Input["config"].(map[string]any)["quality"] != "original-quality" {
				t.Fatal("source completion lost original parameters or reference slot")
			}
			request, err := svc.materializeCanvasWorkflowRequest("owner", "new-operation", recipe, map[string]cw.Node{"person": d.Nodes[0]}, map[string]*cw.Step{"person": {Status: "succeeded", ResourceID: "new-person"}})
			if err != nil {
				t.Fatal(err)
			}
			ref := request.Input["referenceImages"].([]any)[0]
			if workflowReferenceID(ref) != "new-person" {
				t.Fatal("recovered compact task did not replace original reference")
			}
		})
	}
}

func TestCanvasWorkflowLegacyClearedSourceRequiresManualRerun(t *testing.T) {
	svc, db, d := workflowFixture(t)
	if err := db.Model(&model.Task{}).Where("id = ?", "original").Updates(map[string]any{"input_json": `{"mode":"video","metadata":{"nodeId":"historical"}}`, "model": "beefapi::gpt-image-2"}).Error; err != nil {
		t.Fatal(err)
	}
	_, err := svc.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Historical", Definition: d})
	if err == nil || !strings.Contains(err.Error(), "完整配方已清理") || !strings.Contains(err.Error(), "手动重新运行") {
		t.Fatalf("historical task fallback=%v", err)
	}
}

func TestCanvasWorkflowRejectsAmbiguousMultipleOutputSource(t *testing.T) {
	svc, db, d := workflowFixture(t)
	if err := db.Model(&model.Task{}).Where("id = ?", "original").Update("result_json", `{"images":[{"resourceId":"old-person"},{"resourceId":"new-person"}]}`).Error; err != nil {
		t.Fatal(err)
	}
	_, err := svc.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Multiple output", Definition: d})
	if err == nil || !strings.Contains(err.Error(), "单结果生成任务") {
		t.Fatalf("multiple outputs=%v", err)
	}
}
