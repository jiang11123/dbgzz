package skills

import "testing"

func TestOwnerCanDisableWithoutDeletingPinnedPackage(t *testing.T) {
	s, _ := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: Test\ndescription: Test flow\n---\nUse the input."})
	item, err := s.SetSkillAdded("owner", pin.SkillID, false)
	if err != nil || item.IsAdded {
		t.Fatalf("disable: %+v %v", item, err)
	}
	available, err := s.AddedSkills("owner")
	if err != nil || len(available) != 0 {
		t.Fatalf("disabled selectable: %+v %v", available, err)
	}
	if _, err := s.AgentVersion("owner", pin); err == nil {
		t.Fatal("disabled skill still executable")
	}
	if _, err := s.SkillPackageFile("owner", pin.SkillID, "SKILL.md"); err != nil {
		t.Fatal("disable deleted package", err)
	}
	if _, err := s.SetSkillAdded("owner", pin.SkillID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AgentVersion("owner", pin); err != nil {
		t.Fatal("re-enable lost pin", err)
	}
}
