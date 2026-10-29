package agentops_test

import (
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/app"
)

func TestNewStoryboardPreparationAtomicReplayAndUndo(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)
	before := h.canvas(t)
	const turn = "aabbccdd7766"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn, app.AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	rows := []any{map[string]any{"durationSeconds": 5, "imageGenerationPrompt": "a warm cafe", "videoMotionPrompt": "open door with bell"}}
	params := map[string]any{"canvasId": h.canvasID, "expectedRevision": before["revision"], "script": map[string]any{"title": "雨后开门", "rows": rows}, "image": map[string]any{"model": "beefapi::gpt-image-2", "size": "9:16"}, "video": map[string]any{"model": "beefapi::wan3.0-video", "generateAudio": "true"}}
	// Fail after creating the script and rows. The real single-connection
	// transaction must discard those intermediate writes with the receipt.
	rows[0].(map[string]any)["videoMotionPrompt"] = ""
	if _, err := accessWrite(t, h, turn, "canvas", "canvas.script.prepare", "invalid-new", params); err == nil {
		t.Fatal("invalid draft accepted")
	}
	if !reflect.DeepEqual(before, h.canvas(t)) {
		t.Fatal("failed prepare left a partial script")
	}
	rows[0].(map[string]any)["videoMotionPrompt"] = "open door with bell"
	for i := 0; i < 2; i++ {
		result, err := accessWrite(t, h, turn, "canvas", "canvas.script.prepare", "new-script", params)
		if err != nil {
			t.Fatal(err)
		}
		if result.Replayed != (i == 1) || len(result.Result.(map[string]any)["created"].([]any)) != 3 {
			t.Fatal("new script receipt or replay incorrect")
		}
	}
	after := h.canvas(t)
	if len(after["nodes"].([]any)) != 5 {
		t.Fatal("replay duplicated script or drafts")
	}
	if err := h.service.FinalizeAssistantTurn(turn); err != nil {
		t.Fatal(err)
	}
	state, err := h.service.ReadAssistantTurnHistoryState(h.userID, h.canvasID, turn)
	if err != nil || state.Change == nil || len(state.Change.CreatedNodeIDs) != 3 {
		t.Fatal("missing script effects", err)
	}
	if _, err := h.service.UndoAssistantTurn(h.userID, h.canvasID, turn); err != nil {
		t.Fatal(err)
	}
	restored := h.canvas(t)
	if !reflect.DeepEqual(before["nodes"], restored["nodes"]) || !reflect.DeepEqual(before["connections"], restored["connections"]) {
		t.Fatal("undo did not restore original graph")
	}
}
