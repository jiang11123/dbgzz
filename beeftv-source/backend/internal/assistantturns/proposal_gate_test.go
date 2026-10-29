package assistantturns_test

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/assistantturns"
)

func TestProposalRunRejectedAfterUndo(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "fedcba9876543210"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	doc := fx.readCanvas(t)
	doc["timeline"] = map[string]any{"version": 2, "durationMs": 2000}
	revision := fx.writeCanvas(t, doc)
	fx.receipt(t, turnID, "timeline-edit", "canvas.timeline.update", map[string]any{"canvasId": fx.canvasID, "revision": revision, "timelineUpdated": true})
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	if err := fx.turns.CheckProposalRunnable(fx.userID, fx.canvasID, turnID); err != nil {
		t.Fatalf("a live round may start its suggested generation: %v", err)
	}
	var notFound *assistantturns.Error
	if err := fx.turns.CheckProposalRunnable("someone-else", fx.canvasID, turnID); !errors.As(err, &notFound) || notFound.Reason != assistantturns.ReasonNotFound {
		t.Fatalf("a foreign round must read as not found: %v", err)
	}
	if err := fx.turns.CheckProposalRunnable(fx.userID, "other-canvas", turnID); !errors.As(err, &notFound) || notFound.Reason != assistantturns.ReasonNotFound {
		t.Fatalf("another canvas must read as not found: %v", err)
	}
	if _, err := fx.turns.Undo(fx.userID, fx.canvasID, turnID); err != nil {
		t.Fatal(err)
	}
	var undone *assistantturns.Error
	if err := fx.turns.CheckProposalRunnable(fx.userID, fx.canvasID, turnID); !errors.As(err, &undone) || undone.Reason != assistantturns.ReasonUndone {
		t.Fatalf("an undone round must not start generation: %v", err)
	}
}
