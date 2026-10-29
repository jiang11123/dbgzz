package assistantturns_test

import (
	"encoding/json"
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/skills"
	"reflect"
	"strings"
	"testing"
)

func TestTurnSkillPinsPersistAndCannotChangeOnReplay(t *testing.T) {
	fx := openTurnFixture(t)
	pin := skills.Pin{SkillID: "selected", VersionID: "old-version", ContentHash: strings.Repeat("a", 64)}
	turnID := "eeeeaaaabbbbffff"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{SkillPins: []skills.Pin{pin}}); err != nil {
		t.Fatal(err)
	}
	reopened := assistantturns.New(assistantturns.NewStore(repository.New(fx.db)), testCanvasFactory{base: fx.canvas}, "")
	scope, ok, err := reopened.ScopeForHost(fx.userID, turnID)
	if err != nil || !ok || !reflect.DeepEqual(scope.SkillPins, []skills.Pin{pin}) {
		t.Fatalf("scope=%+v ok=%v err=%v", scope, ok, err)
	}
	changed := pin
	changed.VersionID = "new-version"
	if _, err := reopened.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{SkillPins: []skills.Pin{changed}}); err == nil {
		t.Fatal("same turn replay changed skill version")
	}
	if _, err := reopened.Begin(fx.userID, fx.canvasID, "1111111122222222", assistantturns.Input{SkillPins: []skills.Pin{pin, pin}}); err == nil {
		t.Fatal("duplicate skill pin accepted")
	}
}

func TestSessionSkillPinsCoverEarlierRoundsOfSameOwnerAndConversation(t *testing.T) {
	fx := openTurnFixture(t)
	const session = "durable:11111111-2222-3333-4444-555555555555"
	const other = "durable:66666666-7777-8888-9999-000000000000"
	earlier := skills.Pin{SkillID: "earlier", VersionID: "v1", ContentHash: strings.Repeat("a", 64), SkillName: "资产分批"}
	elsewhere := skills.Pin{SkillID: "elsewhere", VersionID: "v1", ContentHash: strings.Repeat("b", 64)}
	foreign := skills.Pin{SkillID: "foreign", VersionID: "v1", ContentHash: strings.Repeat("c", 64)}
	begin := func(turnID, sessionID string, pins []skills.Pin) {
		t.Helper()
		if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{SkillPins: pins}); err != nil {
			t.Fatal(err)
		}
		if err := fx.turns.BindDurableSession(fx.userID, turnID, sessionID, false); err != nil {
			t.Fatal(err)
		}
		if err := fx.turns.Finalize(turnID); err != nil {
			t.Fatal(err)
		}
	}
	begin("aaaa0000aaaa0001", session, []skills.Pin{earlier})
	begin("aaaa0000aaaa0002", other, []skills.Pin{elsewhere})
	raw, _ := json.Marshal([]skills.Pin{foreign})
	if err := fx.db.Create(&model.AssistantTurn{TurnID: "bbbb0000bbbb0001", UserID: "someone-else", CanvasID: fx.canvasID, State: assistantturns.StateSettled, DurableSessionID: session, SkillPinsJSON: string(raw)}).Error; err != nil {
		t.Fatal(err)
	}
	const current = "aaaa0000aaaa0003"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, current, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	if scope, ok, err := fx.turns.ScopeForHost(fx.userID, current); err != nil || !ok || len(scope.SessionSkillPins) != 0 {
		t.Fatalf("unbound round must not inherit pins: %+v %v %v", scope, ok, err)
	}
	if err := fx.turns.BindDurableSession(fx.userID, current, session, false); err != nil {
		t.Fatal(err)
	}
	scope, ok, err := fx.turns.ScopeForHost(fx.userID, current)
	if err != nil || !ok {
		t.Fatalf("scope ok=%v err=%v", ok, err)
	}
	if len(scope.SkillPins) != 0 || len(scope.SessionSkillPins) != 1 || scope.SessionSkillPins[0].Identity() != earlier.Identity() {
		t.Fatalf("session pins must be exactly the earlier owned round: %+v", scope.SessionSkillPins)
	}
}
