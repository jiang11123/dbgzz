package agentops_test

import (
	"context"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/operations"
)

func TestSettledTurnRejectsWriteAfterSuccessfulPreflight(t *testing.T) {
	h := newHarness(t)
	const turnID = "abcd1234"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turnID, app.AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if _, open, err := h.service.AssistantTurnScopeForHost(h.userID, turnID); err != nil || !open {
		t.Fatalf("preflight: %v %v", open, err)
	}
	// Finalization wins after HTTP scope validation but before the write TX.
	if err := h.service.FinalizeAssistantTurn(turnID); err != nil {
		t.Fatal(err)
	}
	before := mustJSON(t, h.canvas(t))
	_, err := h.registry.Execute(agentops.Request{Op: "canvas.node.update", OpID: "late-write", UserID: h.userID, TurnID: turnID,
		Params: mustRaw(t, map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": h.revision, "patch": map[string]any{"title": "too late"}})})
	if err == nil {
		t.Fatal("settled turn accepted a new write")
	}
	if after := mustJSON(t, h.canvas(t)); after != before {
		t.Fatal("rejected turn changed canvas")
	}
	if countOpRecords(t, h, "late-write") != 0 {
		t.Fatal("rejected turn retained a receipt")
	}
}

func TestCommittedTurnWriteIsIncludedByFinalization(t *testing.T) {
	h := newHarness(t)
	const turnID = "abcd1235"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turnID, app.AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	_, err := h.registry.Execute(agentops.Request{Op: "canvas.node.update", OpID: "owned-write", UserID: h.userID, TurnID: turnID,
		Params: mustRaw(t, map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": h.revision, "patch": map[string]any{"title": "owned"}})})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.service.FinalizeAssistantTurn(turnID); err != nil {
		t.Fatal(err)
	}
	state, err := h.service.ReadAssistantTurnHistoryState(h.userID, h.canvasID, turnID)
	if err != nil || state == nil || state.Change == nil || len(state.Change.OperationIDs) != 1 || state.Change.OperationIDs[0] != "owned-write" {
		t.Fatalf("missing committed effect: %+v %v", state, err)
	}
}

func TestTurnAttributedStoreCannotBypassGuard(t *testing.T) {
	h := newHarness(t)
	called := false
	_, err := operations.NewStore(h.service.Database()).Run(context.Background(), operations.RunRequest{UserID: h.userID, OpID: "unguarded", TurnID: "abcd1236"}, func(*gorm.DB) ([]byte, error) {
		called = true
		return []byte(`{}`), nil
	})
	if err == nil || called || countOpRecords(t, h, "unguarded") != 0 {
		t.Fatalf("unguarded turn write: called=%v error=%v", called, err)
	}
}
