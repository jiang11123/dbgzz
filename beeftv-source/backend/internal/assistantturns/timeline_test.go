package assistantturns_test

import (
	"errors"
	"infinite-canvas/backend/internal/assistantturns"
	"reflect"
	"testing"
)

func TestTimelineReceiptReconstructionAndRealUndo(t *testing.T) {
	for _, manual := range []bool{false, true} {
		t.Run(map[bool]string{false: "restore", true: "preserve_later_manual_edit"}[manual], func(t *testing.T) {
			fx := openTurnFixture(t)
			doc := fx.readCanvas(t)
			doc["timeline"] = map[string]any{"version": 2, "durationMs": 1000, "custom": "original"}
			fx.writeCanvas(t, doc)
			before := fx.readCanvas(t)
			turnID := "abcdef123456abcd"
			if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
				t.Fatal(err)
			}
			doc = fx.readCanvas(t)
			doc["timeline"] = map[string]any{"version": 2, "durationMs": 2000}
			afterRevision := fx.writeCanvas(t, doc)
			fx.receipt(t, turnID, "timeline-edit", "canvas.timeline.update", map[string]any{"canvasId": fx.canvasID, "revision": afterRevision, "timelineUpdated": true})
			if err := fx.turns.Finalize(turnID); err != nil {
				t.Fatal(err)
			}
			if manual {
				doc = fx.readCanvas(t)
				doc["title"] = "manual user change"
				fx.writeCanvas(t, doc)
			}
			_, err := fx.turns.Undo(fx.userID, fx.canvasID, turnID)
			if manual {
				var e *assistantturns.Error
				if !errors.As(err, &e) || e.Reason != assistantturns.ReasonCanvasChanged {
					t.Fatalf("manual edit should preventundo: %v", err)
				}
				if fx.readCanvas(t)["title"] != "manual user change" {
					t.Fatal("manual lost")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			restored := fx.readCanvas(t)
			if !reflect.DeepEqual(restored["timeline"], before["timeline"]) || !reflect.DeepEqual(restored["nodes"], before["nodes"]) {
				t.Fatalf("failed restore %v", restored)
			}
			if !fx.turns.Undone(fx.userID, fx.canvasID, turnID) {
				t.Fatal("missingundo marker")
			}
		})
	}
}

func TestTimelineChangeCannotAuthorizeOtherDocumentDifferences(t *testing.T) {
	before := map[string]any{"nodes": []any{map[string]any{"id": "n", "title": "original"}}, "connections": []any{}, "timeline": map[string]any{"durationMs": 1000}, "title": "keep", "plugin": "keep"}
	after := map[string]any{"nodes": before["nodes"], "connections": before["connections"], "timeline": map[string]any{"durationMs": 2000}, "title": "keep", "plugin": "keep"}
	change := &assistantturns.Change{TimelineUpdated: true}
	if !assistantturns.MatchesChange(before, after, change) {
		t.Fatal("timeline diff rejected")
	}
	after["plugin"] = "unrelated"
	if assistantturns.MatchesChange(before, after, change) {
		t.Fatal("arbitrarydiff accepted")
	}
	after["plugin"] = "keep"
	after["nodes"] = []any{map[string]any{"id": "n", "title": "unexpected"}}
	if assistantturns.MatchesChange(before, after, change) {
		t.Fatal("undeclarednode diff accepted")
	}
	change.UpdatedNodeIDs = []string{"n"}
	if !assistantturns.MatchesChange(before, after, change) {
		t.Fatal("declarednode+timeline rejected")
	}
	after["nodes"] = []any{map[string]any{"id": "n", "title": "unexpected"}, map[string]any{"id": "new", "title": "created then edited"}}
	change.CreatedNodeIDs = []string{"new"}
	change.UpdatedNodeIDs = []string{"n", "new"}
	if !assistantturns.MatchesChange(before, after, change) {
		t.Fatal("created then updated node rejected")
	}
}

func TestMultiwriteTimelineUndoChecksAllDocumentFields(t *testing.T) {
	for _, interference := range []bool{false, true} {
		t.Run(map[bool]string{false: "restore", true: "reject_unrelated_field"}[interference], func(t *testing.T) {
			fx := openTurnFixture(t)
			before := fx.readCanvas(t)
			turnID := "abababab12345678"
			if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
				t.Fatal(err)
			}
			for index, opID := range []string{"timeline-1", "timeline-2"} {
				doc := fx.readCanvas(t)
				doc["timeline"] = map[string]any{"version": 2, "durationMs": (index + 1) * 1000}
				if interference && index == 1 {
					doc["plugin"] = "unattributed mutation"
				}
				revision := fx.writeCanvas(t, doc)
				fx.receipt(t, turnID, opID, "canvas.timeline.update", map[string]any{"canvasId": fx.canvasID, "revision": revision, "timelineUpdated": true})
			}
			if err := fx.turns.Finalize(turnID); err != nil {
				t.Fatal(err)
			}
			_, err := fx.turns.Undo(fx.userID, fx.canvasID, turnID)
			if interference {
				var reason *assistantturns.Error
				if !errors.As(err, &reason) || reason.Reason != assistantturns.ReasonCanvasChanged {
					t.Fatalf("unexpected %v", err)
				}
				if fx.readCanvas(t)["plugin"] != "unattributed mutation" {
					t.Fatal("lost unrelated field")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			doc := fx.readCanvas(t)
			if _, exists := doc["timeline"]; exists {
				t.Fatal("timeline not removed by undo")
			}
			if !reflect.DeepEqual(doc["nodes"], before["nodes"]) {
				t.Fatal("nodes changed")
			}
		})
	}
}
