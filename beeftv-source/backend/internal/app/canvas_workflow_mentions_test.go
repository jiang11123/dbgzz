package app

import (
	"encoding/json"
	"testing"

	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
)

func TestCanvasWorkflowNodeMentionsRoundTripAndMaterialize(t *testing.T) {
	s, db, d := workflowFixture(t)
	d.Nodes = append(d.Nodes, cw.Node{ID: "words", Title: "文案", Role: "input", MediaType: "text", Text: "旧文案"})
	d.Edges = append(d.Edges, cw.Edge{From: "action", To: "gen", ToPort: "referenceVideos", Order: 1}, cw.Edge{From: "words", To: "gen", ToPort: "prompt"})
	var task model.Task
	db.First(&task, "id = ?", "original")
	var input map[string]any
	json.Unmarshal([]byte(task.InputJSON), &input)
	input["prompt"] = "背景@[node:action]，动作@[node:depth]，人物@[node:person]，@[node:words]，再次@[node:words]"
	input["referenceVideos"] = append(input["referenceVideos"].([]any), map[string]any{"storageKey": "resource:old-action"})
	raw, _ := json.Marshal(input)
	db.Model(&task).Update("input_json", string(raw))
	created, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Node mentions", Definition: d})
	if err != nil {
		t.Fatal(err)
	}
	editor, err := s.CanvasWorkflowEditor("owner", created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for i := range editor.Workflow.Definition.Nodes {
		editor.Workflow.Definition.Nodes[i].Title = "重新命名"
	}
	saved, err := s.UpdateCanvasWorkflow("owner", created.ID, cw.UpdateRequest{Name: created.Name, ExpectedRevision: created.Revision, Definition: editor.Workflow.Definition})
	if err != nil {
		t.Fatal(err)
	}
	var row model.CanvasWorkflow
	db.First(&row, "id = ?", saved.ID)
	plain, err := s.decryptSettingSecret(row.RecipeCipher)
	if err != nil {
		t.Fatal(err)
	}
	var recipes workflowRecipes
	if err = json.Unmarshal([]byte(plain), &recipes); err != nil {
		t.Fatal(err)
	}
	nodes := map[string]cw.Node{}
	for _, node := range saved.Definition.Nodes {
		nodes[node.ID] = node
	}
	steps := map[string]*cw.Step{"person": {Status: "succeeded", ResourceID: "new-person"}, "depth": {Status: "succeeded", ResourceID: "new-depth"}, "action": {Status: "succeeded", ResourceID: "old-action"}, "words": {Status: "succeeded", Text: "新文案"}}
	req, err := s.materializeCanvasWorkflowRequest("owner", "mention-proof", recipes["gen"], nodes, steps)
	if err != nil {
		t.Fatal(err)
	}
	want := "背景@视频2，动作@视频1，人物@图片1，新文案，再次新文案"
	if req.Prompt != want || req.Input["prompt"] != want {
		t.Fatalf("prompt=%q want=%q", req.Prompt, want)
	}
	if req.Input["referenceImages"].([]any)[0].(map[string]any)["storageKey"] != "resource:new-person" {
		t.Fatal("node mention did not bind current media")
	}
	editor, err = s.CanvasWorkflowEditor("owner", saved.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, edge := range editor.Workflow.Definition.Edges {
		if edge.ToPort == "promptMention" {
			t.Fatal("prompt substitution leaked into media port")
		}
	}
}

func TestCanvasWorkflowRejectsMissingOrUnconnectedNodeMentions(t *testing.T) {
	for _, id := range []string{"missing", "action", "gen"} {
		t.Run(id, func(t *testing.T) {
			s, db, d := workflowFixture(t)
			var task model.Task
			db.First(&task, "id = ?", "original")
			var input map[string]any
			json.Unmarshal([]byte(task.InputJSON), &input)
			input["prompt"] = workflowNodeMentionToken(id)
			raw, _ := json.Marshal(input)
			db.Model(&task).Update("input_json", string(raw))
			if _, _, err := s.compileCanvasWorkflow("owner", d); err == nil {
				t.Fatal("invalid node reference accepted")
			}
		})
	}
}
