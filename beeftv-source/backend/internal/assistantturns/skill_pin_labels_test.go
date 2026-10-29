package assistantturns_test

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/skills"
)

func TestTurnSkillPinLabelsPersistIntoHistory(t *testing.T) {
	fx := openTurnFixture(t)
	pin := skills.Pin{SkillID: "selected", VersionID: "v1", ContentHash: strings.Repeat("b", 64), SkillName: "短剧资产分批流程", Version: "1"}
	turnID := "aaaabbbbccccdddd"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{SkillPins: []skills.Pin{pin}}); err != nil {
		t.Fatal(err)
	}
	reopened := assistantturns.New(assistantturns.NewStore(repository.New(fx.db)), testCanvasFactory{base: fx.canvas}, "")
	state, err := reopened.History(fx.userID, fx.canvasID, turnID)
	if err != nil || state == nil || len(state.SkillPins) != 1 || state.SkillPins[0] != pin {
		t.Fatalf("history must return the stored name and version: %+v %v", state, err)
	}
	renamed := pin
	renamed.SkillName = "改名后的技能"
	if _, err := reopened.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{SkillPins: []skills.Pin{renamed}}); err != nil {
		t.Fatalf("a renamed label is still the same pinned package on replay: %v", err)
	}
	if err := reopened.Extend(fx.userID, fx.canvasID, turnID, assistantturns.Input{SkillPins: []skills.Pin{renamed}}); err != nil {
		t.Fatalf("extending with the same package under a new label must not conflict: %v", err)
	}
}
