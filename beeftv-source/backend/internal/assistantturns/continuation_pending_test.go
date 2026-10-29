package assistantturns_test

import (
	"fmt"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestPendingContinuationsScansBoundedReceiptsAndSkipsTerminalRows(t *testing.T) {
	fx := openTurnFixture(t)
	for index := range 20 {
		id := fmt.Sprintf("%024x", index)
		state := "waiting"
		if index == 0 {
			state = "done"
		} else if index == 1 {
			state = "cancelled"
		} else if index == 2 {
			state = "claimed"
		} else if index == 3 {
			state = "running"
		}
		if err := fx.db.Create(&model.AssistantContinuation{ID: id, TurnID: id, UserID: fx.userID, State: state}).Error; err != nil {
			t.Fatal(err)
		}
	}
	first, err := fx.turns.PendingContinuations("", 0)
	if err != nil || len(first) != 16 || first[0].State != "claimed" || first[1].State != "running" {
		t.Fatalf("first page: %+v %v", first, err)
	}
	last, err := fx.turns.PendingContinuations(first[len(first)-1].ID, 16)
	if err != nil || len(last) != 2 || last[0].ID <= first[len(first)-1].ID {
		t.Fatalf("last page: %+v %v", last, err)
	}
	if rows, err := fx.turns.PendingContinuations("", 1000); err != nil || len(rows) != 16 {
		t.Fatalf("unbounded scan: %d %v", len(rows), err)
	}
}
