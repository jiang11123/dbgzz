package agentops_test

import (
	"encoding/json"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/skills"
	"testing"
)

func TestSkillReadRequiresExactExplicitPin(t *testing.T) {
	pin := skills.Pin{SkillID: "skill-one", VersionID: "version-one", ContentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	scope := &agentops.AssistantScope{CanvasID: "canvas", SkillPins: map[skills.Pin]bool{pin: true}}
	for _, op := range []string{"skill.get", "skill.file"} {
		raw, _ := json.Marshal(pin)
		if err := scope.Allows(registeredScopeOp(t, op), raw); err != nil {
			t.Fatal(err)
		}
		for _, other := range []skills.Pin{{SkillID: pin.SkillID, VersionID: "new-version", ContentHash: pin.ContentHash}, {SkillID: "unselected", VersionID: pin.VersionID, ContentHash: pin.ContentHash}, {SkillID: pin.SkillID, VersionID: pin.VersionID, ContentHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}} {
			raw, _ := json.Marshal(other)
			if err := scope.Allows(registeredScopeOp(t, op), raw); err == nil {
				t.Fatalf("unselected version accepted: %+v", other)
			}
		}
		empty := &agentops.AssistantScope{CanvasID: "canvas"}
		if err := empty.Allows(registeredScopeOp(t, op), raw); err == nil {
			t.Fatal("installed list implicitly authorized read")
		}
	}
}

func TestSkillReadAllowsConversationAndInstalledPinsOnly(t *testing.T) {
	earlier := skills.Pin{SkillID: "skill-earlier", VersionID: "version-one", ContentHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
	installed := skills.Pin{SkillID: "skill-installed", VersionID: "version-two", ContentHash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
	scope := &agentops.AssistantScope{CanvasID: "canvas", PermissionMode: "canvas", SkillPins: map[skills.Pin]bool{earlier: true},
		SkillInstalled: func(pin skills.Pin) bool { return pin == installed }}
	for _, op := range []string{"skill.get", "skill.file"} {
		for _, pin := range []skills.Pin{earlier, installed} {
			raw, _ := json.Marshal(pin)
			if err := scope.Allows(registeredScopeOp(t, op), raw); err != nil {
				t.Fatalf("%s %+v: %v", op, pin, err)
			}
		}
		stale := installed
		stale.VersionID = "version-old"
		raw, _ := json.Marshal(stale)
		if err := scope.Allows(registeredScopeOp(t, op), raw); err == nil {
			t.Fatal("non-current installed version accepted")
		}
	}
	if err := scope.Allows(registeredScopeOp(t, "skill.catalog"), json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
}
