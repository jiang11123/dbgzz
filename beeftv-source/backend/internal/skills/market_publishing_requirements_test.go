package skills

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/skillhub"
)

func TestPublicationRequirementsRejectUnknownBeforeSavingOrUploading(t *testing.T) {
	s, _ := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: Plain text\ndescription: Organize text\n---\nList three points."})
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }))
	defer server.Close()
	t.Setenv("BEEFTV_SKILLHUB_URL", server.URL)
	for _, requirement := range []string{"text", "wand", "model.future", " model.audio"} {
		_, err := s.PublishPrepareInCanvas("owner", pin.SkillID, "canvas", skillhub.Metadata{License: "MIT", Requirements: []string{requirement}}, PublicationTarget{})
		var invalid *kernel.AppError
		if !errors.As(err, &invalid) || invalid.Reason != "invalid_skill_requirements" || !strings.Contains(invalid.Message, "[]") {
			t.Fatalf("unknown value was normalized or not recoverable: %q %v", requirement, err)
		}
	}
	plans, err := s.PublishPlans("owner")
	if err != nil || len(plans) != 0 || calls != 0 {
		t.Fatalf("invalid preparation wrote a plan or called upstream: %d %d %v", len(plans), calls, err)
	}
	valid, err := s.PublishPrepare("owner", pin.SkillID, skillhub.Metadata{License: "MIT", Requirements: []string{}}, PublicationTarget{})
	if err != nil || len(valid.Metadata.Requirements) != 0 {
		t.Fatal("plain text preparation failed", err)
	}
	// Recreate a legacy invalid plan without changing any user fixture/profile.
	valid.Metadata.Requirements = []string{"text"}
	file, _ := s.planFile("owner", valid.ID)
	if err := writeMarketJSON(file, valid); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PublishUpload(context.Background(), "owner", valid.ID, valid.ArchiveSHA256); err == nil || calls != 0 {
		t.Fatal("legacy invalid metadata reached authorization or cloud upload", err)
	}
}

func TestPublicationRepreparePreservesOriginalFilesAndRequiresNewConfirmation(t *testing.T) {
	s, _ := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: Plain text\ndescription: Organize text\n---\nRead references/rules.md", "references/rules.md": "KEEP_ORIGINAL_REFERENCE"})
	fork, err := s.ForkMarket("owner", pin.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	pin = Pin{SkillID: fork.SkillID, VersionID: fork.VersionID, ContentHash: fork.ContentHash}
	old, err := s.PublishPrepareInCanvas("owner", pin.SkillID, "canvas-original", skillhub.Metadata{License: "MIT"}, PublicationTarget{})
	if err != nil {
		t.Fatal(err)
	}
	old.Metadata.Requirements = []string{"text"}
	file, _ := s.planFile("owner", old.ID)
	if err := writeMarketJSON(file, old); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(file)
	archive, _ := os.ReadFile(strings.TrimSuffix(file, ".json") + ".zip")
	metadata := old.Metadata
	metadata.Requirements = []string{}
	fresh, err := s.PublishReprepare("owner", old.ID, metadata, PublicationTarget{})
	if err != nil {
		t.Fatal(err)
	}
	newFile, _ := s.planFile("owner", fresh.ID)
	newArchive, _ := os.ReadFile(strings.TrimSuffix(newFile, ".json") + ".zip")
	after, _ := os.ReadFile(file)
	if !bytes.Equal(before, after) || !bytes.Equal(archive, newArchive) || fresh.ID == old.ID || fresh.VersionID != old.VersionID || fresh.ContentHash != old.ContentHash || fresh.ArchiveSHA256 != old.ArchiveSHA256 || fresh.CanvasID != old.CanvasID || fresh.SkillID != old.SkillID {
		t.Fatal("repreparing changed the old record, source pin, files, or canvas")
	}
	if fresh.Status != "awaiting_upload_confirmation" || fresh.SubmissionID != "" || fresh.Preview != nil || len(fresh.Metadata.Requirements) != 0 {
		t.Fatal("repreparing reused authorization or did not preserve explicit correction")
	}
	if _, err := s.PublishReprepare("other", old.ID, metadata, PublicationTarget{}); err == nil {
		t.Fatal("repreparing bypassed ownership")
	}
	if _, err := s.UpdateSkill("owner", pin.SkillID, SkillMutationRequest{SkillName: "Changed", Description: "Changed", Instruction: "Changed source", IsPrivate: true, Tag: "others"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PublishReprepare("owner", old.ID, metadata, PublicationTarget{}); err == nil {
		t.Fatal("repreparing silently replaced the old source version")
	}
}
