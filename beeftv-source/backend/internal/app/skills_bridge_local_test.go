package app

import (
	"strings"
	"testing"
)

func TestSyncGitHubSkillRejectsLocalMode(t *testing.T) {
	svc := &Service{mode: serviceModeLocal}
	_, err := svc.SyncGitHubSkill("user-1", "skill-1")
	if err == nil || !strings.Contains(err.Error(), "本地工作区") {
		t.Fatalf("local GitHub skill sync error = %v, want local-workspace rejection", err)
	}
}
