package app

import (
	"encoding/json"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	"strings"
	"testing"
)

func TestCanvasWorkflowOperationsMarkMissingNativeRuntime(t *testing.T) {
	t.Setenv(mediatools.FFmpegPathEnv, "/no/such/encoder")
	s := &Service{}
	for _, operation := range s.CanvasWorkflowOperations() {
		if cw.IsMediaOperation(operation.ID) && operation.UnavailableReason == "" {
			t.Fatalf("%s advertised as executable", operation.ID)
		}
		if operation.ID == "generate.image" && operation.UnavailableReason != "" {
			t.Fatal("native encoder blocked model recipe")
		}
	}
}

func TestCanvasWorkflowModelSelectionUsesCurrentChannelAndClearsOldRoute(t *testing.T) {
	s, _, _ := workflowFixture(t)
	s.mode = serviceModeLocal
	config := `{"channels":[{"id":"custom","baseUrl":"https://example.test/v1","apiKey":"current-key","enabled":true,"models":["video-model"],"modelProfiles":[{"model":"video-model","protocol":"openai-video","capability":"video"}]}]}`
	if err := s.SaveLocalModelConfig([]byte(config)); err != nil {
		t.Fatal(err)
	}
	r := workflowRecipe{Request: CreateTaskRequest{Model: "old", LogicalModelID: "old-route", Input: map[string]any{"mode": "video", "config": map[string]any{"model": "old", "apiKey": "old-key", "providerOptions": map[string]any{"old": true}, "videoSeconds": "5"}}}}
	changed, err := s.selectWorkflowModel(cw.Node{MediaType: "video", Config: map[string]any{"modelOption": "custom::video-model"}}, &r)
	if err != nil || !changed || r.Request.Model != "video-model" || r.Request.LogicalModelID != "" {
		t.Fatalf("selection=%+v %v", r.Request, err)
	}
	c := r.Request.Input["config"].(map[string]any)
	if c["apiKey"] != nil || c["providerOptions"] != nil || c["videoSeconds"] != "5" {
		t.Fatalf("unsafe config=%+v", c)
	}
	if _, err = s.selectWorkflowModel(cw.Node{MediaType: "image", Config: map[string]any{"modelOption": "custom::video-model"}}, &r); err == nil {
		t.Fatal("cross-media model accepted")
	}
}

func TestCanvasWorkflowCreatesGenerationWithoutSuccessfulSourceTask(t *testing.T) {
	s, _, _ := workflowFixture(t)
	s.mode = serviceModeLocal
	config := `{"channels":[{"id":"custom","baseUrl":"https://example.test/v1","apiKey":"current-key","enabled":true,"models":["video-model"],"modelProfiles":[{"model":"video-model","protocol":"openai-video","capability":"video"}]}]}`
	if err := s.SaveLocalModelConfig([]byte(config)); err != nil {
		t.Fatal(err)
	}
	d := cw.Definition{Version: 1, Nodes: []cw.Node{{ID: "new-video", Title: "生成视频", Role: "operation", MediaType: "video", OperationID: "generate.video", OperationVersion: 1, Config: map[string]any{"modelOption": "custom::video-model", "prompt": "A landscape", "size": "16:9", "videoSeconds": float64(5)}}}, OutputNodeIDs: []string{"new-video"}}
	created, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "New generator", Definition: d})
	if err != nil {
		t.Fatal(err)
	}
	editor, err := s.CanvasWorkflowEditor("owner", created.ID, 0)
	if err != nil || editor.Workflow.Definition.Nodes[0].SourceTaskID != "" || editor.Workflow.Definition.Nodes[0].Config["modelOption"] != "custom::video-model" {
		t.Fatalf("new generation=%+v err=%v", editor, err)
	}
}

func TestCanvasWorkflowDirectGenerationKinds(t *testing.T) {
	for _, kind := range []string{"image", "video", "audio", "text"} {
		t.Run(kind, func(t *testing.T) {
			s, _, _ := workflowFixture(t)
			s.mode = serviceModeLocal
			protocol := map[string]string{"image": "openai-image", "video": "openai-video", "audio": "openai-audio", "text": "openai-chat"}[kind]
			config, _ := json.Marshal(map[string]any{"channels": []any{map[string]any{"id": "custom", "baseUrl": "https://example.test/v1", "apiKey": "current-key", "enabled": true, "models": []string{"new-model"}, "modelProfiles": []any{map[string]any{"model": "new-model", "protocol": protocol, "capability": kind}}}}})
			if err := s.SaveLocalModelConfig(config); err != nil {
				t.Fatal(err)
			}
			d := cw.Definition{Version: 1, Nodes: []cw.Node{{ID: "generate", Title: "Generate", Role: "operation", MediaType: kind, OperationID: "generate." + kind, OperationVersion: 1, Config: map[string]any{"modelOption": "custom::new-model", "prompt": "A landscape"}}}, OutputNodeIDs: []string{"generate"}}
			if _, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Direct " + kind, Definition: d}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCanvasWorkflowAbstractSlotsSaveWithoutOriginalMedia(t *testing.T) {
	s, _, definition := workflowFixture(t)
	definition.PresentationVersion = 1
	created, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Reusable", Definition: definition})
	if err != nil {
		t.Fatal(err)
	}
	editor, err := s.CanvasWorkflowEditor("owner", created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, node := range editor.Workflow.Definition.Nodes {
		if (node.Role == "operation" || node.Role == "input" && node.MediaType != "text" && !node.UseDefault) && node.ResourceID != "" {
			t.Fatalf("original media leaked into reusable slot: %s", node.ID)
		}
	}
	if _, err = s.UpdateCanvasWorkflow("owner", created.ID, cw.UpdateRequest{Name: "Reusable", Definition: editor.Workflow.Definition, ExpectedRevision: 1}); err != nil {
		t.Fatalf("abstract slots could not be recompiled: %v", err)
	}
}

func TestCanvasWorkflowEditorRevisionsAndPromptRebinding(t *testing.T) {
	s, db, d := workflowFixture(t)
	var source model.Task
	db.First(&source, "id = ?", "original")
	var sourceInput map[string]any
	json.Unmarshal([]byte(source.InputJSON), &sourceInput)
	delete(sourceInput["config"].(map[string]any), "channelId")
	sourceRaw, _ := json.Marshal(sourceInput)
	db.Model(&source).Update("input_json", string(sourceRaw))
	d.Nodes = append(d.Nodes, cw.Node{ID: "text", Title: "Text", Role: "input", MediaType: "text", Text: "person"})
	d.Edges = append(d.Edges, cw.Edge{From: "text", To: "gen"})
	first, e := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Old", Definition: d})
	if e != nil {
		t.Fatal(e)
	}
	editor, e := s.CanvasWorkflowEditor("owner", first.ID, 1)
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(editor)
	if strings.Contains(string(raw), "recipe-secret") || strings.Contains(string(raw), "apiKey") || strings.Contains(string(raw), "RecipeCipher") {
		t.Fatal("private recipe leaked")
	}
	for i, n := range editor.Workflow.Definition.Nodes {
		if n.ID == "gen" {
			n.Config["prompt"] = "prefix person performs action"
			editor.Workflow.Definition.Nodes[i] = n
		}
	}
	request := cw.UpdateRequest{Name: "New", Definition: editor.Workflow.Definition, ExpectedRevision: 1}
	second, e := s.UpdateCanvasWorkflow("owner", first.ID, request)
	if e != nil || second.Revision != 2 {
		t.Fatalf("update=%+v err=%v", second, e)
	}
	if _, e = s.UpdateCanvasWorkflow("owner", first.ID, request); e == nil {
		t.Fatal("stale editor overwrote revision")
	}
	old, e := s.StartCanvasWorkflow("owner", first.ID, cw.RunRequest{ClientOperationID: "revision-old", TemplateRevision: 1})
	if e != nil || old.TemplateRevision != 1 {
		t.Fatalf("old=%+v err=%v", old, e)
	}
	newer, e := s.StartCanvasWorkflow("owner", first.ID, cw.RunRequest{ClientOperationID: "revision-new", TemplateRevision: 2})
	if e != nil {
		t.Fatal(e)
	}
	var oldRow, newRow model.CanvasWorkflowRun
	db.First(&oldRow, "id = ?", old.ID)
	db.First(&newRow, "id = ?", newer.ID)
	for _, item := range []struct {
		row    model.CanvasWorkflowRun
		want   int
		prompt string
	}{{oldRow, 0, "person performs action"}, {newRow, 7, "prefix person performs action"}} {
		plain, e := s.decryptSettingSecret(item.row.RecipeCipher)
		if e != nil {
			t.Fatal(e)
		}
		var recipes workflowRecipes
		if e = json.Unmarshal([]byte(plain), &recipes); e != nil {
			t.Fatal(e)
		}
		recipe := recipes["gen"]
		if recipe.Request.Input["prompt"] != item.prompt {
			t.Fatalf("prompt=%v", recipe.Request.Input["prompt"])
		}
		found := false
		for _, b := range recipe.Bindings {
			if b.NodeID == "text" {
				found = true
				if b.Index != item.want {
					t.Fatalf("stale binding=%+v", b)
				}
			}
		}
		if !found {
			t.Fatal("missing text binding")
		}
	}
	if _, e = s.StartCanvasWorkflow("owner", first.ID, cw.RunRequest{ClientOperationID: "revision-old", TemplateRevision: 2}); e == nil {
		t.Fatal("revision excluded from idempotency")
	}
}

func TestCanvasWorkflowTrimWithoutModelAndExplicitPorts(t *testing.T) {
	s, _, _ := workflowFixture(t)
	d := cw.Definition{Version: 1, Nodes: []cw.Node{{ID: "input", Title: "Input", Role: "input", MediaType: "video"}, {ID: "trim", Title: "Trim", Role: "operation", MediaType: "video", OperationID: "video.trim", OperationVersion: 1, Config: map[string]any{"endSeconds": float64(1)}}}, Edges: []cw.Edge{{From: "input", To: "trim", FromPort: "output", ToPort: "video"}}, OutputNodeIDs: []string{"trim"}}
	template, e := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Trim", Definition: d})
	if e != nil {
		t.Fatal(e)
	}
	run, e := s.StartCanvasWorkflow("owner", template.ID, cw.RunRequest{ClientOperationID: "trim-only", TemplateRevision: 1, Inputs: map[string]cw.Value{"input": {ResourceID: "old-action"}}})
	if e != nil {
		t.Fatal(e)
	}
	var row model.CanvasWorkflowRun
	s.repo.DB().First(&row, "id = ?", run.ID)
	s.advanceCanvasWorkflow(&row)
	updated, e := s.CanvasWorkflowRun("owner", run.ID)
	if e != nil || len(updated.Steps) != 2 || updated.Steps[1].TaskID == "" {
		t.Fatalf("run=%+v err=%v", updated, e)
	}
	task, e := s.repo.TaskForUser("owner", updated.Steps[1].TaskID)
	if e != nil || task.Type != "timeline_render" {
		t.Fatalf("not local timeline task: %+v %v", task, e)
	}
	d.Nodes[0].MediaType = "image"
	if e = s.ValidateCanvasWorkflow("owner", d); e == nil {
		t.Fatal("wrong port media type accepted")
	}
}

func TestCanvasWorkflowEditorIndependentOfTaskHistoryAndTextDefaults(t *testing.T) {
	s, db, d := workflowFixture(t)
	var task model.Task
	db.First(&task, "id = ?", "original")
	var input map[string]any
	json.Unmarshal([]byte(task.InputJSON), &input)
	delete(input["config"].(map[string]any), "channelId")
	raw, _ := json.Marshal(input)
	db.Model(&task).Update("input_json", string(raw))
	d.Nodes = append(d.Nodes, cw.Node{ID: "text", Title: "Text", Role: "input", MediaType: "text", Text: "person"})
	d.Edges = append(d.Edges, cw.Edge{From: "text", To: "gen"})
	created, e := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Original", Definition: d})
	if e != nil {
		t.Fatal(e)
	}
	db.Delete(&model.Task{}, "id = ?", "original")
	editor, e := s.CanvasWorkflowEditor("owner", created.ID, 1)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.PrepareCanvasWorkflow("owner", editor.Workflow.Definition, created.ID, 1); e != nil {
		t.Fatal(e)
	}
	renamed, e := s.UpdateCanvasWorkflow("owner", created.ID, cw.UpdateRequest{Name: "Renamed", ExpectedRevision: 1, Definition: editor.Workflow.Definition})
	if e != nil {
		t.Fatal(e)
	}
	for i, n := range editor.Workflow.Definition.Nodes {
		if n.ID == "text" {
			editor.Workflow.Definition.Nodes[i].Text = "new person"
		}
	}
	updated, e := s.UpdateCanvasWorkflow("owner", created.ID, cw.UpdateRequest{Name: "Changed text", ExpectedRevision: renamed.Revision, Definition: editor.Workflow.Definition})
	if e != nil {
		t.Fatal(e)
	}
	var row model.CanvasWorkflow
	db.First(&row, "id = ?", created.ID)
	plain, _ := s.decryptSettingSecret(row.RecipeCipher)
	var recipes workflowRecipes
	json.Unmarshal([]byte(plain), &recipes)
	nodes := map[string]cw.Node{}
	for _, node := range updated.Definition.Nodes {
		nodes[node.ID] = node
	}
	steps := map[string]*cw.Step{"text": {Status: "succeeded", Text: "new person"}, "person": {Status: "succeeded", ResourceID: "old-person"}, "depth": {Status: "succeeded", ResourceID: "old-depth"}}
	req, e := s.materializeCanvasWorkflowRequest("owner", "proof", recipes["gen"], nodes, steps)
	if e != nil || req.Prompt != "new person performs action" {
		t.Fatalf("text default not rebound: %v %v", req.Prompt, e)
	}
	for i, n := range updated.Definition.Nodes {
		if n.ID == "gen" {
			n.Config["prompt"] = "prefix new person performs action"
			updated.Definition.Nodes[i] = n
		}
	}
	if _, e = s.UpdateCanvasWorkflow("owner", created.ID, cw.UpdateRequest{Name: "Prompt", ExpectedRevision: updated.Revision, Definition: updated.Definition}); e != nil {
		t.Fatal(e)
	}
}

func TestCanvasWorkflowPrepareInfersOriginalReferenceOrder(t *testing.T) {
	s, db, d := workflowFixture(t)
	var task model.Task
	db.First(&task, "id = ?", "original")
	var input map[string]any
	json.Unmarshal([]byte(task.InputJSON), &input)
	input["referenceImages"] = []any{map[string]any{"storageKey": "resource:fixed-mask"}, map[string]any{"storageKey": "resource:old-person"}}
	raw, _ := json.Marshal(input)
	db.Model(&task).Update("input_json", string(raw))
	d.Nodes = append(d.Nodes, cw.Node{ID: "mask", Title: "Mask", Role: "input", MediaType: "image", ResourceID: "fixed-mask"})
	d.Edges = append(d.Edges, cw.Edge{From: "mask", To: "gen"})
	prepared, e := s.PrepareCanvasWorkflow("owner", d, "", 0)
	if e != nil {
		t.Fatal(e)
	}
	for _, edge := range prepared.Edges {
		if edge.To == "gen" && (edge.From == "person" || edge.From == "mask") {
			want := 0
			if edge.From == "person" {
				want = 1
			}
			if edge.ToPort != "referenceImages" || edge.Order != want {
				t.Fatalf("wrong inferred slot: %+v", edge)
			}
		}
	}
}

func TestCanvasWorkflowPromptEditValidatesCapability(t *testing.T) {
	s, db, d := workflowFixture(t)
	var task model.Task
	db.First(&task, "id = ?", "original")
	var input map[string]any
	json.Unmarshal([]byte(task.InputJSON), &input)
	config := input["config"].(map[string]any)
	delete(config, "channelId")
	profile := DefaultModelCapabilityConfigForModel("runninghub-workflow-video", "workflow-video")
	profile.Video.References.PromptMaxChars = 30
	config["interfaceType"] = "runninghub-workflow-video"
	config["capabilityConfig"] = profile
	raw, _ := json.Marshal(input)
	db.Model(&task).Update("input_json", string(raw))
	created, e := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Limit", Definition: d})
	if e != nil {
		t.Fatal(e)
	}
	editor, e := s.CanvasWorkflowEditor("owner", created.ID, 1)
	if e != nil {
		t.Fatal(e)
	}
	for i, node := range editor.Workflow.Definition.Nodes {
		if node.ID == "gen" {
			node.Config["prompt"] = strings.Repeat("x", 31)
			editor.Workflow.Definition.Nodes[i] = node
		}
	}
	if _, e = s.UpdateCanvasWorkflow("owner", created.ID, cw.UpdateRequest{Name: "Too long", ExpectedRevision: 1, Definition: editor.Workflow.Definition}); e == nil || !strings.Contains(e.Error(), "31") {
		t.Fatalf("prompt cap bypassed: %v", e)
	}
}
