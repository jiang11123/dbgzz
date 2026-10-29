package agentops_test

import (
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/app"
)

func TestStoryboardPreparationReplayScopeAndUndo(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)
	h.patchNode(t, "n1", func(node map[string]any) {
		node["type"] = "script"
		node["metadata"] = map[string]any{"storyboard": map[string]any{"rows": []any{
			map[string]any{"id": "r1", "shotNumber": 1, "durationSeconds": 5, "imageGenerationPrompt": "rainy street", "videoMotionPrompt": "walk with footsteps"},
			map[string]any{"id": "r2", "shotNumber": 2, "durationSeconds": 6, "imageGenerationPrompt": "warm room", "videoMotionPrompt": "open door with bell"},
		}}}
	})
	before := h.canvas(t)
	const turn = "aabbccdd77"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn, app.AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	params := map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": before["revision"], "rowIds": []string{"r1", "r2"}, "referenceNodeIds": []string{"n2"}, "image": map[string]any{"model": "beefapi::gpt-image-2", "size": "9:16"}, "video": map[string]any{"model": "beefapi::wan3.0-video", "generateAudio": "true"}}
	for i := 0; i < 2; i++ {
		result, err := accessWrite(t, h, turn, "canvas", "canvas.script.prepare", "prepare", params)
		if err != nil {
			t.Fatal(err)
		}
		if result.Replayed != (i == 1) {
			t.Fatal("wrong replay state")
		}
		if len(result.Result.(map[string]any)["created"].([]any)) != 4 {
			t.Fatal("missing nodes")
		}
	}
	after := h.canvas(t)
	if after["revision"].(float64) != before["revision"].(float64)+1 || len(after["nodes"].([]any)) != 6 {
		t.Fatal("replay created more work")
	}
	if _, err := accessWrite(t, h, turn, "read-only", "canvas.script.prepare", "prepare", params); err == nil {
		t.Fatal("read-only replay accepted")
	}
	params["expectedRevision"] = after["revision"]
	if _, err := accessWrite(t, h, turn, "canvas", "canvas.script.prepare", "prepare-again", params); err == nil {
		t.Fatal("new identity duplicated bound rows")
	}
	if err := h.service.FinalizeAssistantTurn(turn); err != nil {
		t.Fatal(err)
	}
	state, err := h.service.ReadAssistantTurnHistoryState(h.userID, h.canvasID, turn)
	if err != nil || state == nil || state.Change == nil || len(state.Change.CreatedNodeIDs) != 4 || len(state.Change.CreatedEdgeIDs) != 8 || !reflect.DeepEqual(state.Change.UpdatedNodeIDs, []string{"n1"}) {
		t.Fatalf("missing effects: %+v %v", state, err)
	}
	if _, err := h.service.UndoAssistantTurn(h.userID, h.canvasID, turn); err != nil {
		t.Fatal(err)
	}
	restored := h.canvas(t)
	if !reflect.DeepEqual(before["nodes"], restored["nodes"]) || !reflect.DeepEqual(before["connections"], restored["connections"]) {
		t.Fatal("undo lost original graph")
	}
}
