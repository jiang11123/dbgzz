package app

import (
	"encoding/json"
	"strings"
	"testing"

	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
)

func TestCanvasWorkflowNewAudioReferenceRoundTrip(t *testing.T) {
	s, db, d := workflowFixture(t)
	var original model.Task
	db.First(&original, "id = ?", "original")
	var input map[string]any
	json.Unmarshal([]byte(original.InputJSON), &input)
	config := input["config"].(map[string]any)
	delete(config, "channelId")
	config["interfaceType"], config["model"], config["videoSeconds"] = "newapi-channel-2", "seedance-2.0", "5"
	config["capabilityConfig"] = DefaultModelCapabilityConfigForModel("newapi-channel-2", "seedance-2.0")
	raw, _ := json.Marshal(input)
	db.Model(&original).Update("input_json", string(raw))
	d.PresentationVersion = 1
	created, err := s.CreateCanvasWorkflow("owner", cw.CreateRequest{Name: "Audio", Definition: d})
	if err != nil {
		t.Fatal(err)
	}
	editor, err := s.CanvasWorkflowEditor("owner", created.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	d = editor.Workflow.Definition
	d.Nodes = append(d.Nodes, cw.Node{ID: "audio", Title: "音频输入", Role: "input", MediaType: "audio"})
	d.Edges = append(d.Edges, cw.Edge{From: "audio", To: "gen", FromPort: "output", ToPort: "referenceAudios"})
	updated, err := s.UpdateCanvasWorkflow("owner", created.ID, cw.UpdateRequest{Name: "Audio", ExpectedRevision: 1, Definition: d})
	if err != nil {
		t.Fatal(err)
	}
	// Empty reusable slots must survive both prepare/save passes and reopening.
	editor, err = s.CanvasWorkflowEditor("owner", created.ID, updated.Revision)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := s.PrepareCanvasWorkflow("owner", editor.Workflow.Definition, created.ID, updated.Revision)
	if err != nil {
		t.Fatal(err)
	}
	for i := range prepared.Nodes {
		if prepared.Nodes[i].ID == "gen" {
			prepared.Nodes[i].Config["prompt"] = "person performs action @[node:audio]"
		}
	}
	updated, err = s.UpdateCanvasWorkflow("owner", created.ID, cw.UpdateRequest{Name: "Audio", ExpectedRevision: updated.Revision, Definition: prepared})
	if err != nil {
		t.Fatal(err)
	}
	row, err := s.workflowRevisionRow("owner", created.ID, updated.Revision)
	if err != nil {
		t.Fatal(err)
	}
	recipes, _, err := s.compileCanvasWorkflow("owner", prepared, row)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Create(&model.Resource{ID: "new-audio", UserID: "owner", Kind: "audio", Status: model.ResourceStatusReady, MimeType: "audio/wav", DurationMs: 2500}).Error; err != nil {
		t.Fatal(err)
	}
	nodes := map[string]cw.Node{}
	for _, node := range prepared.Nodes {
		nodes[node.ID] = node
	}
	steps := map[string]*cw.Step{"audio": {Status: "succeeded", ResourceID: "new-audio"}, "person": {Status: "succeeded", ResourceID: "old-person"}, "depth": {Status: "succeeded", ResourceID: "old-depth"}}
	req, err := s.materializeCanvasWorkflowRequest("owner", "proof", recipes["gen"], nodes, steps)
	if err != nil {
		t.Fatal(err)
	}
	audio := req.Input["referenceAudios"].([]any)[0].(map[string]any)
	if audio["storageKey"] != "resource:new-audio" || audio["durationMs"] != int64(2500) {
		t.Fatalf("audio not materialized: %v", audio)
	}
	// Removing an added input must discard its placeholder rather than send an empty reference.
	filtered := prepared
	filtered.Nodes = nil
	filtered.Edges = nil
	for _, node := range prepared.Nodes {
		if node.ID != "audio" {
			if node.ID == "gen" {
				node.Config = map[string]any{"prompt": "person performs action"}
			}
			filtered.Nodes = append(filtered.Nodes, node)
		}
	}
	for _, edge := range prepared.Edges {
		if edge.From != "audio" {
			filtered.Edges = append(filtered.Edges, edge)
		}
	}
	withoutAudio, err := s.UpdateCanvasWorkflow("owner", created.ID, cw.UpdateRequest{Name: "Audio", ExpectedRevision: updated.Revision, Definition: filtered})
	if err != nil {
		t.Fatal(err)
	}
	// Deleting an original bound input must not silently freeze its old resource.
	deleted := filtered
	deleted.Nodes, deleted.Edges = nil, nil
	for _, node := range filtered.Nodes {
		if node.ID != "person" {
			deleted.Nodes = append(deleted.Nodes, node)
		}
	}
	for _, edge := range filtered.Edges {
		if edge.From != "person" {
			deleted.Edges = append(deleted.Edges, edge)
		}
	}
	current, err := s.workflowRevisionRow("owner", created.ID, withoutAudio.Revision)
	if err != nil {
		t.Fatal(err)
	}
	cleaned, _, err := s.compileCanvasWorkflow("owner", deleted, current)
	if err != nil {
		t.Fatal(err)
	}
	if items, _ := cleaned["gen"].Request.Input["referenceImages"].([]any); len(items) != 0 {
		t.Fatal("deleted input survived as a hidden reference")
	}
	// Port indices cannot cause unbounded placeholder allocation.
	for i := range d.Edges {
		if d.Edges[i].From == "audio" {
			d.Edges[i].Order = 1000000
		}
	}
	if _, _, err = s.compileCanvasWorkflow("owner", d, row); err == nil || !strings.Contains(err.Error(), "连接位置") {
		t.Fatalf("invalid index accepted: %v", err)
	}
}
