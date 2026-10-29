package assistantturns_test

import (
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/assistantturns"
)

func TestRenderOutputReceiptsSurviveDatabaseCloseReopen(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aaaa1234bbbb1234"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	fx.receipt(t, turnID, "first", "canvas.timeline.render", map[string]any{"canvasId": fx.canvasID, "taskId": "first-task", "sourceRevision": 0})
	fx.receipt(t, turnID, "repair", "canvas.timeline.render", map[string]any{"canvasId": fx.canvasID, "taskId": "repair-task"})
	before, err := fx.turns.RenderOutputRefs(fx.userID, fx.canvasID, turnID)
	if err != nil || len(before) != 2 || before[0].SourceRevision == nil || *before[0].SourceRevision != 0 || before[1].SourceRevision != nil {
		t.Fatalf("refs: %#v %v", before, err)
	}
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	sqlDB, err := fx.db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err = sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := fx.reopen(t)
	after, err := reopened.turns.RenderOutputRefs(fx.userID, fx.canvasID, turnID)
	if err != nil || !reflect.DeepEqual(after, before) {
		t.Fatalf("reopen lost receipts: %#v %v", after, err)
	}
}
