package app

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/skillhub"
	"infinite-canvas/backend/internal/skills"
)

func TestSkillRequirementsRejectUnconfiguredMediaBeforeExecution(t *testing.T) {
	s, _, _ := newAssistantTurnService(t)
	item, err := s.CreateSkill("local", SkillMutationRequest{SkillName: "文字技能", Description: "按输入组织结果", Instruction: "列出三点。", Tag: "others", IsPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	pin := skills.Pin{SkillID: item.SkillID, VersionID: item.VersionID, ContentHash: item.ContentHash}
	if _, err := s.ValidateAgentSkills("local", []skills.Pin{pin}); err != nil {
		t.Fatal("text skill required media configuration", err)
	}
	for _, requirement := range []string{"model.video", "model.audio", "model.image", "unknown.capability"} {
		raw, _ := json.Marshal(skillhub.Release{Metadata: skillhub.Metadata{SkillID: "reviewed", Requirements: []string{requirement}}, ReleaseID: "r_1"})
		if err := s.Database().Model(&model.SkillVersion{}).Where("id = ?", pin.VersionID).Update("market_release_json", string(raw)).Error; err != nil {
			t.Fatal(err)
		}
		_, err := s.ValidateAgentSkills("local", []skills.Pin{pin})
		var unavailable *kernel.AppError
		if !errors.As(err, &unavailable) || unavailable.Reason != "skill_capability_unavailable" {
			t.Fatalf("%s executed without known capability: %v", requirement, err)
		}
	}
}

func TestSkillRequirementsGuardContextAndFileEntrypointsWithoutDroppingRecovery(t *testing.T) {
	s, canvasID, _ := newAssistantTurnService(t)
	if err := database.ConfigurePool(s.Database()); err != nil {
		t.Fatal(err)
	}
	item, err := s.CreateSkill("local", SkillMutationRequest{SkillName: "条件技能", Description: "保留输入", Instruction: "列出三点。", Tag: "others", IsPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	pin := skills.Pin{SkillID: item.SkillID, VersionID: item.VersionID, ContentHash: item.ContentHash}
	change := assistantturns.SkillContextChange{SessionID: "durable:11111111-2222-3333-4444-555555555555", Action: "activate", RequestID: "initial", Pins: []skills.Pin{pin}}
	applied, err := s.ChangeAssistantSkillContext("local", canvasID, change)
	if err != nil {
		t.Fatal(err)
	}
	session := s.BindDomain(nil).(*operationSession)
	if _, err := session.AgentSkillFile("local", pin, "SKILL.md"); err != nil {
		t.Fatal("text file required media configuration", err)
	}
	turnID := "aabbccddeeff0011"
	if _, err := s.BeginAssistantTurn("local", canvasID, turnID, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := s.BindAssistantDurableSession("local", turnID, change.SessionID, false); err != nil {
		t.Fatal(err)
	}
	fresh := change
	fresh.RequestID, fresh.ExpectedRevision = "fresh", applied.Revision
	for _, requirement := range []string{"model.video", "model.audio", "model.image", "unknown.capability"} {
		raw, _ := json.Marshal(skillhub.Release{Metadata: skillhub.Metadata{SkillID: "reviewed", Requirements: []string{requirement}}, ReleaseID: "r_1"})
		if err := s.Database().Model(&model.SkillVersion{}).Where("id = ?", pin.VersionID).Update("market_release_json", string(raw)).Error; err != nil {
			t.Fatal(err)
		}
		checks := map[string]func() error{
			"selection":   func() error { _, e := s.ChangeAssistantSkillContext("local", canvasID, fresh); return e },
			"host load":   func() error { _, e := s.LoadAssistantTurnSkillContext("local", canvasID, turnID, fresh); return e },
			"instruction": func() error { _, e := session.AgentSkillVersion("local", pin); return e },
			"file":        func() error { _, e := session.AgentSkillFile("local", pin, "SKILL.md"); return e },
		}
		for name, check := range checks {
			e := check()
			var unavailable *kernel.AppError
			if !errors.As(e, &unavailable) || unavailable.Reason != "skill_capability_unavailable" {
				t.Fatalf("%s bypassed %s: %v", name, requirement, e)
			}
			if _, canDrop := skillContextResourceError(e); canDrop {
				t.Fatal("capability failure permitted dropping a recoverable pin")
			}
		}
		replayed, err := s.ChangeAssistantSkillContext("local", canvasID, change)
		if err != nil || !reflect.DeepEqual(replayed, applied) {
			t.Fatalf("capability change rewrote committed receipt: %+v %v", replayed, err)
		}
		current, err := s.AssistantSkillContext("local", canvasID, change.SessionID)
		if err != nil || !reflect.DeepEqual(current, applied) {
			t.Fatalf("failed capability check mutated selection: %+v %v", current, err)
		}
	}
	if err := s.Database().Model(&model.SkillVersion{}).Where("id = ?", pin.VersionID).Update("market_release_json", "").Error; err != nil {
		t.Fatal(err)
	}
	if restored, err := s.LoadAssistantTurnSkillContext("local", canvasID, turnID, fresh); err != nil || restored.Revision != applied.Revision+1 {
		t.Fatalf("original load could not resume after recovery: %+v %v", restored, err)
	}
}
