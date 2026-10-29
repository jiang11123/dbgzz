package creation

import (
	"encoding/json"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestApprovedUpdateDoesNotOverwriteLaterManualEdit(t *testing.T) {
	before := map[string]any{"id": "canvas", "nodes": []any{map[string]any{"id": "n", "type": "text", "title": "before", "metadata": map[string]any{"content": "original"}}}, "connections": []any{}}
	ops := []CanvasOp{{Type: "update_node", ID: "n", Metadata: map[string]any{"content": "approved"}}}
	raw, _ := json.Marshal(before)
	baseline, err := ApprovalBaseline(string(raw), ops)
	if err != nil {
		t.Fatal(err)
	}
	run := &model.CreationRun{ApprovedCanvasJSON: baseline}
	nodes := before["nodes"].([]any)
	nodes[0].(map[string]any)["metadata"] = map[string]any{"content": "later manual edit"}
	afterRaw, _ := json.Marshal(before)
	var after map[string]any
	_ = json.Unmarshal(afterRaw, &after)
	after["nodes"].([]any)[0].(map[string]any)["metadata"] = map[string]any{"content": "approved"}
	if err := ValidateCanvasDiff(nil, "user", run, before, after, ops); err == nil {
		t.Fatal("approved operation overwrote later manual edit")
	}
}

func TestSubmissionScopeRejectsChangedModelSpecAndReferences(t *testing.T) {
	now := time.Now()
	ops := []CanvasOp{{Type: "add_node", ID: "v", NodeType: "video", Metadata: map[string]any{"prompt": "短片", "model": "managed-video", "size": "9:16", "seconds": "15", "referenceNodeIds": []any{"ref"}}}}
	b, _ := json.Marshal(ops)
	run := &model.CreationRun{CanvasID: "canvas", Status: "running", ApprovedProposalVersion: 1, ApprovedProposalHash: "hash", ApprovedOperationsJSON: string(b), ApprovedAt: &now}
	request := TaskRequest{Type: "canvas_video", ProjectID: "canvas", Prompt: "短片", Model: "managed-video", Input: map[string]any{"nodeId": "v", "config": map[string]any{"size": "9:16", "videoSeconds": "15"}, "referenceImages": []any{map[string]any{"id": "ref"}}}}
	if err := ValidateSubmissionScope(run, 1, request); err != nil {
		t.Fatal(err)
	}
	request.Input["config"].(map[string]any)["videoSeconds"] = "5"
	if err := ValidateSubmissionScope(run, 1, request); err == nil {
		t.Fatal("duration silently changed")
	}
	request.Input["config"].(map[string]any)["videoSeconds"] = "15"
	request.Model = "other"
	if err := ValidateSubmissionScope(run, 1, request); err == nil {
		t.Fatal("model changed")
	}
	request.Model = "managed-video"
	request.Input["referenceImages"] = []any{map[string]any{"id": "other"}}
	if err := ValidateSubmissionScope(run, 1, request); err == nil {
		t.Fatal("reference changed")
	}
}
