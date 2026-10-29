package app

import (
	"context"
	"encoding/json"
	"fmt"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
	"strings"
	"testing"
)

func TestCanvasWorkflowImageSelectionRoundTrip(t *testing.T) {
	for _, count := range []int{4, 8} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			s, db, _ := workflowFixture(t)
			values := []map[string]any{}
			for i := 0; i < count; i++ {
				id := fmt.Sprintf("candidate-%d", i)
				if err := db.Create(&model.Resource{ID: id, UserID: "owner", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; err != nil {
					t.Fatal(err)
				}
				values = append(values, map[string]any{"resourceId": id})
			}
			result, _ := json.Marshal(map[string]any{"images": values})
			if err := db.Model(&model.Task{}).Where("id = ?", "original").Updates(map[string]any{"type": "canvas_image", "input_json": `{"mode":"image","prompt":"scene","config":{"channelId":"channel","apiKey":"recipe-secret"}}`, "result_json": string(result)}).Error; err != nil {
				t.Fatal(err)
			}
			d := cw.Definition{Version: 1, Nodes: []cw.Node{{ID: "gen", Title: "生成图片 1", Role: "operation", OperationID: "generate.image", OperationVersion: 1, MediaType: "image", SourceTaskID: "original"}, {ID: "select", Title: "选择图片结果 1", Role: "operation", OperationID: "image.select", OperationVersion: 1, MediaType: "image"}}, Edges: []cw.Edge{{From: "gen", To: "select", FromPort: "output", ToPort: "images"}}, OutputNodeIDs: []string{"select"}}
			template, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "选择图片", Definition: d})
			if err != nil {
				t.Fatal(err)
			}
			reopened, err := s.CanvasWorkflowEditor("owner", template.ID, 1)
			if err != nil || len(reopened.Workflow.Definition.Nodes) != 2 {
				t.Fatalf("reopen: %v", err)
			}
			run, err := s.StartCanvasWorkflow("owner", template.ID, cw.RunRequest{ClientOperationID: "image-selection"})
			if err != nil {
				t.Fatal(err)
			}
			operation := workflowOperation(run.ID, "gen")
			if err = db.Create(&model.Task{ID: "admitted-images", UserID: "owner", Type: "canvas_image", Status: model.TaskStatusSucceeded, ClientOperationID: &operation, ResultJSON: string(result)}).Error; err != nil {
				t.Fatal(err)
			}
			s.advanceCanvasWorkflows(context.Background())
			run, err = s.CanvasWorkflowRun("owner", run.ID)
			if err != nil {
				t.Fatal(err)
			}
			selected := run.Steps[1]
			if selected.Status != "waiting_selection" || len(selected.Candidates) != count || run.Status != "running" {
				t.Fatalf("selection checkpoint: %+v", run)
			}
			if _, err = s.SelectCanvasWorkflowImage("other", run.ID, "select", "candidate-1"); err == nil {
				t.Fatal("foreign run selectable")
			}
			if _, err = s.SelectCanvasWorkflowImage("owner", run.ID, "select", "fixed-mask"); err == nil {
				t.Fatal("foreign candidate selectable")
			}
			for i := 0; i < 2; i++ {
				if _, err = s.SelectCanvasWorkflowImage("owner", run.ID, "select", "candidate-1"); err != nil {
					t.Fatal(err)
				}
			}
			s.advanceCanvasWorkflows(context.Background())
			run, err = s.CanvasWorkflowRun("owner", run.ID)
			if err != nil || run.Status != "succeeded" || len(run.Outputs) != 1 || run.Outputs[0].ResourceID != "candidate-1" {
				t.Fatalf("selected result: %+v %v", run, err)
			}
			var tasks int64
			db.Model(&model.Task{}).Count(&tasks)
			if tasks != 2 {
				t.Fatalf("selection submitted duplicate tasks: %d", tasks)
			}
		})
	}
}

func TestCanvasWorkflowUpscaleConfiguration(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		modelName, format := "Standard V2", "png"
		if kind == "video" {
			modelName, format = "Proteus", "mp4"
		}
		node := cw.Node{ID: "upscale", Title: "AI超分", Role: "operation", MediaType: kind, OperationID: kind + ".ai-upscale", OperationVersion: 1, Config: map[string]any{"channelId": "beefapi", "preset": "precision|" + modelName, "scale": 2, "outputFormat": format}}
		if err := cw.ValidateOperation(node); err != nil {
			t.Fatal(err)
		}
		request, err := cw.UpscaleRequest(node)
		if err != nil || request.Mode != "precision" || request.Scale != 2 {
			t.Fatalf("upscale request: %+v %v", request, err)
		}
		node.Config["scale"] = 5
		if cw.ValidateOperation(node) == nil {
			t.Fatal("invalid scale accepted")
		}
	}
}

func TestCanvasWorkflowDescribeAndUpscaleTemplateRoundTrip(t *testing.T) {
	s, _, _ := workflowFixture(t)
	s.mode = serviceModeLocal
	config := `{"channels":[{"id":"vision","baseUrl":"https://example.test/v1","apiKey":"private-key","enabled":true,"models":["vision-model"],"modelProfiles":[{"model":"vision-model","protocol":"chat-completion","capability":"text","capabilityConfig":{"version":1,"text":{"references":{"promptMaxChars":32000,"maxImages":4,"maxImageBytes":10485760}}}}]},{"id":"beefapi","name":"官方算力","baseUrl":"https://enterprise.beefapi.com","apiKey":"official-private-key","enabled":true,"models":[]}]}`
	if err := s.SaveLocalModelConfig([]byte(config)); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"image.describe", "image.ai-upscale", "video.ai-upscale"} {
		found := false
		for _, operation := range s.CanvasWorkflowOperations() {
			if operation.ID == id {
				for _, field := range operation.Fields {
					if field.Key == "modelOption" || field.Key == "channelId" {
						found = len(field.Options) > 0
					}
				}
			}
		}
		if !found {
			t.Fatalf("missing configured selector: %s", id)
		}
	}
	d := cw.Definition{Version: 1, PresentationVersion: 1, Nodes: []cw.Node{{ID: "input", Title: "图片输入", Role: "input", MediaType: "image"}, {ID: "describe", Title: "提示词反推", Role: "operation", OperationID: "image.describe", OperationVersion: 1, MediaType: "text", Config: map[string]any{"modelOption": "vision::vision-model", "prompt": "描述画面"}}, {ID: "upscale", Title: "图片AI超分", Role: "operation", OperationID: "image.ai-upscale", OperationVersion: 1, MediaType: "image", Config: map[string]any{"channelId": "beefapi", "preset": "precision|Standard V2", "scale": 2, "outputFormat": "png"}}}, Edges: []cw.Edge{{From: "input", To: "describe", FromPort: "output", ToPort: "image"}, {From: "input", To: "upscale", FromPort: "output", ToPort: "image"}}, OutputNodeIDs: []string{"describe", "upscale"}}
	template, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "图片处理", Definition: d})
	if err != nil {
		t.Fatal(err)
	}
	editor, err := s.CanvasWorkflowEditor("owner", template.ID, 1)
	if err != nil || len(editor.Workflow.Definition.Nodes) != 3 {
		t.Fatalf("reopen: %v", err)
	}
	request, err := s.workflowDescribeRequest(d.Nodes[1], "old-person", "confirmed-describe")
	if err != nil {
		t.Fatal(err)
	}
	if request.Type != "canvas_text" || request.Prompt != "描述画面" || len(request.Input["referenceImages"].([]any)) != 1 {
		t.Fatalf("describe request: %+v", request)
	}
	admitted, err := s.CreateTask("owner", request)
	if err != nil || admitted == nil {
		t.Fatalf("describe task admission: %v", err)
	}
	repeated, err := s.CreateTask("owner", request)
	if err != nil || repeated.ID != admitted.ID {
		t.Fatalf("duplicate describe admission: %v", err)
	}
	serialized, _ := json.Marshal(template)
	if strings.Contains(string(serialized), "private-key") {
		t.Fatal("credentials leaked into template")
	}
}
