package skills

import "testing"

func TestValidateAgentSkillsCapturesDisplayLabels(t *testing.T) {
	s, _ := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: 短剧资产分批流程\ndescription: 标签测试\n---\n正文"})
	spoofed := pin
	spoofed.SkillName = "伪造名称"
	spoofed.Version = "99"
	pins, err := s.ValidateAgentSkills("owner", []Pin{spoofed})
	if err != nil || len(pins) != 1 {
		t.Fatalf("pins=%+v err=%v", pins, err)
	}
	resource, err := s.AgentVersion("owner", pin)
	if err != nil {
		t.Fatal(err)
	}
	got := pins[0]
	if got.Identity() != pin || got.SkillName != resource.Name || got.Version != resource.Version || got.SkillName == "伪造名称" || got.SkillName == "" {
		t.Fatalf("validated pin must carry the installed name and version: %+v resource=%s/%s", got, resource.Name, resource.Version)
	}
	if again, err := s.AgentVersion("owner", got); err != nil || again.Pin != pin {
		t.Fatalf("labels must not leak into the package identity: %+v %v", again, err)
	}
}
