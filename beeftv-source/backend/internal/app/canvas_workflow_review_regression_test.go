package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
)

func TestCanvasWorkflowExplicitChannelWithDuplicateEndpoint(t *testing.T) {
	s, _, _ := workflowFixture(t)
	s.mode = serviceModeLocal
	config := `{"channels":[{"id":"primary","baseUrl":"https://example.test/v1","apiKey":"dummy-one","enabled":true,"models":["video-model"],"modelProfiles":[{"model":"video-model","protocol":"openai-video","capability":"video"}]},{"id":"secondary","baseUrl":"https://example.test/v1","apiKey":"dummy-two","enabled":true,"models":["video-model"],"modelProfiles":[{"model":"video-model","protocol":"openai-video","capability":"video"}]}]}`
	if err := s.SaveLocalModelConfig([]byte(config)); err != nil {
		t.Fatal(err)
	}
	d := cw.Definition{Version: 1, Nodes: []cw.Node{{ID: "generate", Title: "Generate video", Role: "operation", MediaType: "video", OperationID: "generate.video", OperationVersion: 1, Config: map[string]any{"modelOption": "secondary::video-model", "prompt": "A landscape", "size": "16:9", "videoSeconds": float64(5)}}}, OutputNodeIDs: []string{"generate"}}
	created, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Explicit secondary channel", Definition: d})
	if err != nil {
		t.Fatal(err)
	}
	editor, err := s.CanvasWorkflowEditor("owner", created.ID, 0)
	if err != nil || editor.Workflow.Definition.Nodes[0].Config["modelOption"] != "secondary::video-model" {
		t.Fatalf("selection lost: %+v %v", editor, err)
	}
}

func TestCanvasWorkflowCancelReconcilesUncheckpointedAdmission(t *testing.T) {
	s, db, definition := workflowFixture(t)
	template, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Cancellation", Definition: definition})
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.StartCanvasWorkflow("owner", template.ID, cw.RunRequest{ClientOperationID: "cancel-recovery"})
	if err != nil {
		t.Fatal(err)
	}
	op := workflowOperation(run.ID, "depth")
	task := model.Task{ID: "uncheckpointed", UserID: "owner", Type: "canvas_video", Status: model.TaskStatusQueued, ClientOperationID: &op, InputJSON: `{}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.CancelCanvasWorkflow(context.Background(), "owner", run.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&task, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusCancelled {
		t.Fatalf("admitted task still runnable: %s", task.Status)
	}
}

func TestCanvasWorkflowEditorPreservesTwoSlotsFromOneSource(t *testing.T) {
	s, db, _ := workflowFixture(t)
	var original model.Task
	if err := db.First(&original, "id = ?", "original").Error; err != nil {
		t.Fatal(err)
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(original.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	input["referenceImages"] = []any{map[string]any{"storageKey": "resource:old-person"}, map[string]any{"storageKey": "resource:old-person"}}
	raw, _ := json.Marshal(input)
	if err := db.Model(&original).Update("input_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
	d := cw.Definition{Version: 1, PresentationVersion: 1, Nodes: []cw.Node{{ID: "person", Title: "Person", Role: "input", MediaType: "image", ResourceID: "old-person"}, {ID: "gen", Title: "Video", Role: "operation", OperationID: "generate.video", OperationVersion: 1, MediaType: "video", SourceTaskID: "original"}}, Edges: []cw.Edge{{From: "person", To: "gen", FromPort: "output", ToPort: "referenceImages", Order: 0}, {From: "person", To: "gen", FromPort: "output", ToPort: "referenceImages", Order: 1}}, OutputNodeIDs: []string{"gen"}}
	template, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Two frames", Definition: d})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cw.Validate(template.Definition); err != nil {
		t.Fatal(err)
	}
	if template.Definition.Edges[0].Order != 0 || template.Definition.Edges[1].Order != 1 {
		t.Fatalf("slots collapsed: %+v", template.Definition.Edges)
	}
	if _, err := s.StartCanvasWorkflow("owner", template.ID, cw.RunRequest{ClientOperationID: "two-frames", Inputs: map[string]cw.Value{"person": {ResourceID: "new-person"}}}); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasWorkflowUnreadableJSONFailsInsteadOfPollingForever(t *testing.T) {
	for _, field := range []string{"state_json", "definition_json", "recipe_cipher"} {
		t.Run(field, func(t *testing.T) {
			s, db, _ := workflowFixture(t)
			row := model.CanvasWorkflowRun{ID: "unreadable", UserID: "owner", Status: "queued", StateJSON: `{"steps":[]}`, DefinitionJSON: `{}`, RecipeCipher: `{}`}
			if err := db.Create(&row).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&row).Update(field, "{").Error; err != nil {
				t.Fatal(err)
			}
			if err := db.First(&row, "id = ?", row.ID).Error; err != nil {
				t.Fatal(err)
			}
			s.advanceCanvasWorkflow(&row)
			run, err := s.CanvasWorkflowRun("owner", row.ID)
			if err != nil || run.Status != "failed" || run.Error == "" {
				t.Fatalf("unreadable run still active: %+v %v", run, err)
			}
		})
	}
}

func TestCanvasWorkflowRecipeReuseKeepsMultiOutputSelectionRequirement(t *testing.T) {
	s, db, _ := workflowFixture(t)
	if err := db.Model(&model.Task{}).Where("id = ?", "original").Updates(map[string]any{"type": "canvas_image", "input_json": `{"mode":"image","prompt":"scene","config":{"model":"unknown","interfaceType":"openai-image"}}`, "result_json": `{"images":[{"resourceId":"old-person"},{"resourceId":"new-person"}]}`}).Error; err != nil {
		t.Fatal(err)
	}
	d := cw.Definition{Version: 1, Nodes: []cw.Node{{ID: "gen", Title: "Images", Role: "operation", OperationID: "generate.image", OperationVersion: 1, MediaType: "image", SourceTaskID: "original"}, {ID: "select", Title: "Select", Role: "operation", OperationID: "image.select", OperationVersion: 1, MediaType: "image"}}, Edges: []cw.Edge{{From: "gen", To: "select", FromPort: "output", ToPort: "images"}}, OutputNodeIDs: []string{"select"}}
	template, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Multiple outputs", Definition: d})
	if err != nil {
		t.Fatal(err)
	}
	d.Nodes[1].OperationID, d.Nodes[1].Config = "image.resize", map[string]any{"longEdge": float64(64)}
	d.Edges[0].ToPort = "image"
	if _, err := s.UpdateCanvasWorkflow("owner", template.ID, cw.UpdateRequest{Name: template.Name, Definition: d, ExpectedRevision: 1}); err == nil || !strings.Contains(err.Error(), "多张") {
		t.Fatalf("reused multi-output recipe was not rejected for its missing selection: %v", err)
	}
}

func TestCanvasWorkflowNewFixedOutputModelRequiresSelection(t *testing.T) {
	s, _, _ := workflowFixture(t)
	s.mode = serviceModeLocal
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"custom","baseUrl":"https://example.test/v1","apiKey":"dummy","enabled":true,"models":["midjourney-v8.2"],"modelProfiles":[{"model":"midjourney-v8.2","protocol":"openai-image","capability":"image"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	d := cw.Definition{Version: 1, Nodes: []cw.Node{{ID: "gen", Title: "Images", Role: "operation", OperationID: "generate.image", OperationVersion: 1, MediaType: "image", Config: map[string]any{"modelOption": "custom::midjourney-v8.2", "prompt": "scene"}}, {ID: "resize", Title: "Resize", Role: "operation", OperationID: "image.resize", OperationVersion: 1, MediaType: "image", Config: map[string]any{"longEdge": float64(64)}}}, Edges: []cw.Edge{{From: "gen", To: "resize", FromPort: "output", ToPort: "image"}}, OutputNodeIDs: []string{"resize"}}
	if _, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "New multi-output model", Definition: d}); err == nil || !strings.Contains(err.Error(), "多张") {
		t.Fatalf("fixed-output model was not rejected for its missing selection: %v", err)
	}
}
