package agentops_test

import (
	"encoding/json"
	"errors"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"testing"
)

func TestRecoveryDuplicateEdgeRejectsStaleObservation(t *testing.T) {
	h := newHarness(t)
	_, err := h.run(t, "canvas.node.update", "external-before-edge", map[string]any{"canvasId": h.canvasID, "nodeId": "n2", "expectedRevision": h.revision, "patch": map[string]any{"title": "external edit"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.run(t, "canvas.edge.create", "stale-duplicate-edge", map[string]any{"canvasId": h.canvasID, "fromNodeId": "n1", "toNodeId": "n2", "expectedRevision": h.revision}, false)
	if err == nil {
		t.Fatal("a duplicate edge with stale expectedRevision must not masquerade as a created edge")
	}
}

func TestRecoveryNoOpReceiptNeverClaimsExternalEdit(t *testing.T) {
	h := newHarness(t)
	turnID := "abcddc01"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turnID, app.AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	_, err := h.run(t, "canvas.node.update", "external-edit-before-noop", map[string]any{"canvasId": h.canvasID, "nodeId": "n2", "expectedRevision": h.revision, "patch": map[string]any{"title": "external edit retained"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	current := h.canvas(t)
	revision := int64(current["revision"].(float64))
	result, err := h.run(t, "canvas.edge.create", "noop-owned-receipt", map[string]any{"canvasId": h.canvasID, "fromNodeId": "n1", "toNodeId": "n2", "expectedRevision": revision}, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Result.(map[string]any)["created"] != false {
		t.Fatal("duplicate edge must report created=false")
	}
	// Attribution is injected into this isolated fixture to test settlement independently from HTTP authentication.
	if err = h.service.Database().Model(&model.AgentOpRecord{}).Where("op_id = ?", "noop-owned-receipt").Update("turn_id", turnID).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.service.FinalizeAssistantTurn(turnID); err != nil {
		t.Fatal(err)
	}
	state, err := h.service.ReadAssistantTurnHistoryState(h.userID, h.canvasID, turnID)
	if err != nil || state == nil || state.Change != nil {
		t.Fatalf("no-op became a canvas change: %#v %v", state, err)
	}
	_, err = h.service.UndoAssistantTurn(h.userID, h.canvasID, turnID)
	var turnErr *app.AssistantTurnError
	if !errors.As(err, &turnErr) || turnErr.Reason != app.AssistantTurnReasonNoChange {
		t.Fatalf("expected no-change, got %v", err)
	}
	if h.canvas(t)["revision"] != current["revision"] {
		t.Fatal("external edit was mutated by undo")
	}
}

func TestRecoveryCorruptReceiptPreservesBeforeDocument(t *testing.T) {
	h := newHarness(t)
	turnID := "abcddc02"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turnID, app.AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	receipt := model.AgentOpRecord{OpID: "corrupt-receipt", UserID: h.userID, TurnID: turnID, Op: "canvas.node.update", PayloadHash: "synthetic", Status: "succeeded", ResultJSON: "{invalid"}
	if err := h.service.Database().Create(&receipt).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.service.FinalizeAssistantTurn(turnID); err == nil {
		t.Fatal("corrupt successful receipt must not become no-change")
	}
	var record model.AssistantTurn
	if err := h.service.Database().Where("turn_id = ?", turnID).First(&record).Error; err != nil {
		t.Fatal(err)
	}
	if record.Document == "" || !json.Valid([]byte(record.Document)) || record.State != "open" {
		t.Fatal("before document was erased")
	}
	if _, err := h.service.ReadAssistantTurnHistoryState(h.userID, h.canvasID, turnID); err == nil {
		t.Fatal("history must surface unavailable evidence rather than report no change")
	}
}

func TestRecoveryHistoryProjectsDurableReceiptsAfterRestartWithoutSettling(t *testing.T) {
	h := newHarness(t)
	turnID := "abcddc03"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turnID, app.AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	_, err := h.run(t, "canvas.node.update", "interrupted-owned-write", map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": h.revision, "patch": map[string]any{"title": "interrupted edit"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.service.Database().Model(&model.AgentOpRecord{}).Where("op_id = ?", "interrupted-owned-write").Update("turn_id", turnID).Error; err != nil {
		t.Fatal(err)
	}
	restarted := app.NewLocal(repository.New(h.service.Database()), h.dataDir)
	state, err := restarted.ReadAssistantTurnHistoryState(h.userID, h.canvasID, turnID)
	if err != nil || state == nil || state.Change == nil || state.Change.RevisionAfter != h.revision+1 {
		t.Fatalf("durable change missing: %#v %v", state, err)
	}
	if _, open, err := restarted.AssistantTurnScopeForHost(h.userID, turnID); err != nil || !open {
		t.Fatalf("reading history unexpectedly settled a live turn: %v", err)
	}
	if foreign, err := restarted.ReadAssistantTurnHistoryState("foreign-user", h.canvasID, turnID); err != nil || foreign != nil {
		t.Fatal("history state leaked outside owner scope")
	}
	if _, err = restarted.UndoAssistantTurn(h.userID, h.canvasID, turnID); err != nil {
		t.Fatal(err)
	}
}
