package app

import (
	"encoding/json"
	"fmt"
	"testing"

	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
)

func TestCanvasWorkflowFollowsCurrentReferenceVideoDuration(t *testing.T) {
	for _, duration := range []int64{0, 6200, 7000, 7001} {
		t.Run(fmt.Sprint(duration), func(t *testing.T) {
			s, db, d := workflowFixture(t)
			var source model.Task
			if err := db.First(&source, "id = ?", "original").Error; err != nil {
				t.Fatal(err)
			}
			var input map[string]any
			json.Unmarshal([]byte(source.InputJSON), &input)
			input["config"].(map[string]any)["videoSeconds"] = "7"
			raw, _ := json.Marshal(input)
			if err := db.Model(&source).Update("input_json", string(raw)).Error; err != nil {
				t.Fatal(err)
			}
			// Exercise the public JSON contract, including schema decoding.
			raw, _ = json.Marshal(d)
			var public map[string]any
			json.Unmarshal(raw, &public)
			public["nodes"].([]any)[0].(map[string]any)["videoDurationSourceNodeId"] = "depth"
			raw, _ = json.Marshal(public)
			json.Unmarshal(raw, &d)
			recipes, _, err := s.compileCanvasWorkflow("owner", d)
			if err != nil {
				t.Fatal(err)
			}
			if err = db.Model(&model.Resource{}).Where("id = ?", "new-depth").Update("duration_ms", duration).Error; err != nil {
				t.Fatal(err)
			}
			nodes := map[string]cw.Node{}
			for _, node := range d.Nodes {
				nodes[node.ID] = node
			}
			steps := map[string]*cw.Step{"person": {Status: "succeeded", ResourceID: "new-person"}, "depth": {Status: "succeeded", ResourceID: "new-depth"}}
			request, err := s.materializeCanvasWorkflowRequest("owner", "duration-proof", recipes["gen"], nodes, steps)
			if duration == 0 {
				if err == nil {
					t.Fatal("missing duration silently retained fixed seconds")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := fmt.Sprint((duration + 999) / 1000)
			if got := request.Input["config"].(map[string]any)["videoSeconds"]; got != want {
				t.Fatalf("duration=%d got=%v want=%s", duration, got, want)
			}
		})
	}
}

func TestCanvasWorkflowDurationSourceMustBeConnectedVideo(t *testing.T) {
	for _, id := range []string{"missing", "person", "action", "gen"} {
		t.Run(id, func(t *testing.T) {
			s, _, d := workflowFixture(t)
			d.Nodes[0].VideoDurationSourceNodeID = id
			if _, _, err := s.compileCanvasWorkflow("owner", d); err == nil {
				t.Fatal("invalid duration source accepted")
			}
		})
	}
	s, _, d := workflowFixture(t)
	d.Nodes[0].VideoDurationSourceNodeID = "depth"
	if _, _, err := s.compileCanvasWorkflow("owner", d); err == nil {
		t.Fatal("undeclared model duration accepted")
	}
}

func TestCanvasWorkflowSelectedDurationSourceAndEditorRoundTrip(t *testing.T) {
	s, db, d := workflowFixture(t)
	var source model.Task
	if err := db.First(&source, "id = ?", "original").Error; err != nil {
		t.Fatal(err)
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(source.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	input["config"].(map[string]any)["videoSeconds"] = "7"
	input["referenceVideos"] = append(input["referenceVideos"].([]any), map[string]any{"storageKey": "resource:old-action"})
	raw, _ := json.Marshal(input)
	if err := db.Model(&source).Update("input_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
	db.Model(&model.Resource{}).Where("id = ?", "old-action").Update("duration_ms", 1200)
	db.Model(&model.Resource{}).Where("id = ?", "new-depth").Update("duration_ms", 9900)
	d.Edges = append(d.Edges, cw.Edge{From: "action", To: "gen"})
	d.Nodes[0].VideoDurationSourceNodeID = "action"
	template, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Duration", Definition: d})
	if err != nil {
		t.Fatal(err)
	}
	editor, err := s.CanvasWorkflowEditor("owner", template.ID, template.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if editor.Workflow.Definition.Nodes[0].VideoDurationSourceNodeID != "action" {
		t.Fatal("editor lost duration source")
	}
	saved, err := s.UpdateCanvasWorkflow("owner", template.ID, cw.UpdateRequest{Name: template.Name, Definition: editor.Workflow.Definition, ExpectedRevision: template.Revision})
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
	for _, node := range d.Nodes {
		nodes[node.ID] = node
	}
	steps := map[string]*cw.Step{"person": {Status: "succeeded", ResourceID: "new-person"}, "depth": {Status: "succeeded", ResourceID: "new-depth"}, "action": {Status: "succeeded", ResourceID: "old-action"}}
	for _, item := range []struct{ id, want string }{{"action", "2"}, {"depth", "10"}, {"", "7"}} {
		recipe := recipes["gen"]
		recipe.VideoDurationSourceNodeID = item.id
		req, err := s.materializeCanvasWorkflowRequest("owner", "proof", recipe, nodes, steps)
		if err != nil {
			t.Fatal(err)
		}
		if got := req.Input["config"].(map[string]any)["videoSeconds"]; got != item.want {
			t.Fatalf("source=%s seconds=%v want=%s", item.id, got, item.want)
		}
	}
}
