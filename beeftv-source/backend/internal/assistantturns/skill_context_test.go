package assistantturns_test

import (
	"errors"
	"strings"
	"testing"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/skills"
)

const contextSession = "durable:11111111-2222-3333-4444-555555555555"

func contextReason(t *testing.T, err error, want string) {
	t.Helper()
	var e *assistantturns.Error
	if !errors.As(err, &e) || e.Reason != want {
		t.Fatalf("want %s, got %v", want, err)
	}
}

func TestSkillContextCASReceiptsAndReopen(t *testing.T) {
	fx := openTurnFixture(t)
	initial, err := fx.turns.SkillContext(fx.userID, fx.canvasID, contextSession)
	if err != nil {
		t.Fatal(err)
	}
	pin := skills.Pin{SkillID: "story", VersionID: "v1", ContentHash: strings.Repeat("a", 64)}
	change := assistantturns.SkillContextChange{SessionID: contextSession, Action: "activate", RequestID: "request-one", ExpectedRevision: initial.Revision, Pins: []skills.Pin{pin}}
	activated, err := fx.turns.ChangeSkillContext(fx.userID, fx.canvasID, change)
	if err != nil {
		t.Fatal(err)
	}
	if activated.Revision != 1 || len(activated.ActivePins) != 1 {
		t.Fatalf("bad active context %+v", activated)
	}
	reopened := assistantturns.New(assistantturns.NewStore(fx.repo), testCanvasFactory{base: fx.canvas}, fx.dir)
	stored, err := reopened.SkillContext(fx.userID, fx.canvasID, contextSession)
	if err != nil || stored.ScopeID != initial.ScopeID || stored.ActivePins[0] != pin {
		t.Fatalf("lost persistent context %+v %v", stored, err)
	}
	reselected, err := reopened.ChangeSkillContext(fx.userID, fx.canvasID, assistantturns.SkillContextChange{SessionID: contextSession, Action: "activate", RequestID: "request-two", ExpectedRevision: 1, Pins: []skills.Pin{pin}})
	if err != nil || reselected.Revision != 2 {
		t.Fatalf("fresh reselect %+v %v", reselected, err)
	}
	replayed, err := reopened.ChangeSkillContext(fx.userID, fx.canvasID, change)
	if err != nil || replayed.Revision != 1 {
		t.Fatalf("missing original receipt %+v %v", replayed, err)
	}
	current, _ := reopened.SkillContext(fx.userID, fx.canvasID, contextSession)
	if current.Revision != 2 {
		t.Fatal("old retry overwrote current context")
	}
	change.RequestID = "new-stale-request"
	_, err = reopened.ChangeSkillContext(fx.userID, fx.canvasID, change)
	contextReason(t, err, "skill_context_revision_conflict")
	change.RequestID = "request-one"
	change.Action = "clear"
	change.Pins = nil
	_, err = reopened.ChangeSkillContext(fx.userID, fx.canvasID, change)
	contextReason(t, err, "skill_context_request_conflict")
}

func TestSkillContextClearAndNewScopeHaveDifferentLifecycle(t *testing.T) {
	fx := openTurnFixture(t)
	start, err := fx.turns.SkillContext(fx.userID, fx.canvasID, contextSession)
	if err != nil {
		t.Fatal(err)
	}
	cleared, err := fx.turns.ChangeSkillContext(fx.userID, fx.canvasID, assistantturns.SkillContextChange{SessionID: contextSession, Action: "clear", RequestID: "clear", ExpectedRevision: 0})
	if err != nil {
		t.Fatal(err)
	}
	if cleared.ScopeID != start.ScopeID || cleared.Lifecycle != "active" || len(cleared.ActivePins) != 0 {
		t.Fatalf("clear isolated history unexpectedly: %+v", cleared)
	}
	reset, err := fx.turns.ChangeSkillContext(fx.userID, fx.canvasID, assistantturns.SkillContextChange{SessionID: contextSession, Action: "new_scope", RequestID: "reset", ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	if reset.ScopeID == start.ScopeID || reset.Lifecycle != "reset_pending" {
		t.Fatalf("reset not staged %+v", reset)
	}
	_, err = fx.turns.ChangeSkillContext(fx.userID, fx.canvasID, assistantturns.SkillContextChange{SessionID: contextSession, Action: "clear", RequestID: "racing", ExpectedRevision: 2})
	contextReason(t, err, "skill_scope_reset_pending")
	_, err = fx.turns.AcknowledgeSkillScope(fx.userID, fx.canvasID, contextSession, start.ScopeID, 2)
	contextReason(t, err, "skill_context_revision_conflict")
	ack, err := fx.turns.AcknowledgeSkillScope(fx.userID, fx.canvasID, contextSession, reset.ScopeID, 2)
	if err != nil || ack.Lifecycle != "active" {
		t.Fatalf("ack %+v %v", ack, err)
	}
	ack, err = fx.turns.AcknowledgeSkillScope(fx.userID, fx.canvasID, contextSession, reset.ScopeID, 2)
	if err != nil || ack.Revision != 2 {
		t.Fatal("ack retry changed revision")
	}
}

func TestSkillContextOwnerAndSessionIsolation(t *testing.T) {
	fx := openTurnFixture(t)
	if _, err := fx.turns.SkillContext("foreign", fx.canvasID, contextSession); err == nil {
		t.Fatal("foreign owner read canvas context")
	}
	if _, err := fx.turns.SkillContext(fx.userID, fx.canvasID, ""); err == nil {
		t.Fatal("empty session accepted")
	}
	first, _ := fx.turns.SkillContext(fx.userID, fx.canvasID, contextSession)
	other, _ := fx.turns.SkillContext(fx.userID, fx.canvasID, "durable:66666666-7777-8888-9999-000000000000")
	if first.ScopeID == other.ScopeID {
		t.Fatal("sessions share active scope")
	}
	turnID := "abcd1234abcd1234"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	if err := fx.turns.BindDurableSession(fx.userID, turnID, contextSession, false); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.turns.BoundSkillContext(fx.userID, turnID, other.SessionID); err == nil {
		t.Fatal("turn switched context session")
	}
	if _, err := fx.turns.BoundSkillContext(fx.userID, turnID, contextSession); err != nil {
		t.Fatal(err)
	}
}

func TestValidatedSkillContextChecksReceiptAndCASBeforePackageAccess(t *testing.T) {
	fx := openTurnFixture(t)
	pin := skills.Pin{SkillID: "story", VersionID: "v1", ContentHash: strings.Repeat("a", 64)}
	calls := 0
	unavailable := errors.New("package removed")
	validate := func(tx *gorm.DB, pins []skills.Pin) ([]skills.Pin, error) {
		calls++
		if tx == nil || len(pins) != 1 || pins[0] != pin {
			t.Fatalf("validator needs the transaction and effective pins: %+v", pins)
		}
		if calls > 1 {
			return nil, unavailable
		}
		return pins, nil
	}
	change := assistantturns.SkillContextChange{SessionID: contextSession, Action: "activate", RequestID: "select", Pins: []skills.Pin{pin}}
	activated, err := fx.turns.ChangeSkillContextValidated(fx.userID, fx.canvasID, change, validate)
	if err != nil || calls != 1 {
		t.Fatalf("initial activation: %+v %v, validations=%d", activated, err, calls)
	}
	replayed, err := fx.turns.ChangeSkillContextValidated(fx.userID, fx.canvasID, change, validate)
	if err != nil || replayed.Revision != activated.Revision || calls != 1 {
		t.Fatalf("receipt replay revalidated package: %+v %v, validations=%d", replayed, err, calls)
	}
	stale := change
	stale.RequestID = "stale"
	_, err = fx.turns.ChangeSkillContextValidated(fx.userID, fx.canvasID, stale, validate)
	contextReason(t, err, "skill_context_revision_conflict")
	if calls != 1 {
		t.Fatal("stale mutation checked package before CAS")
	}
	refresh := assistantturns.SkillContextChange{SessionID: contextSession, Action: "refresh", RequestID: "refresh", ExpectedRevision: 1}
	_, err = fx.turns.ChangeSkillContextValidated(fx.userID, fx.canvasID, refresh, validate)
	if !errors.Is(err, unavailable) || calls != 2 {
		t.Fatalf("refresh did not validate current pins: %v, validations=%d", err, calls)
	}
	clear := refresh
	clear.Action, clear.RequestID = "clear", "clear"
	cleared, err := fx.turns.ChangeSkillContextValidated(fx.userID, fx.canvasID, clear, validate)
	if err != nil || cleared.Revision != 2 || len(cleared.ActivePins) != 0 || calls != 2 {
		t.Fatalf("removing expired pins should not validate them: %+v %v, validations=%d", cleared, err, calls)
	}
	if _, err := fx.turns.ChangeSkillContextValidated(fx.userID, fx.canvasID, change, nil); err == nil {
		t.Fatal("validated entrypoint accepted a missing validator")
	}
}
