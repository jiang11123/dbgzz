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

func TestPublicationTargetRejectsLocalCloudConfusionAndPreservesLegacyDraft(t *testing.T) {
	s, _ := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: Plain text\ndescription: Organize text\n---\nRead references/rules.md", "references/rules.md": "KEEP_ORIGINAL"})
	cloudID := "s_0123456789abcdef0123456789abcdef"
	for _, tc := range []struct {
		metadataID string
		target     PublicationTarget
	}{
		{metadataID: pin.SkillID},
		{metadataID: cloudID},
		{target: PublicationTarget{Kind: "new", MarketSkillID: cloudID}},
		{target: PublicationTarget{Kind: "existing", MarketSkillID: pin.SkillID}},
		{target: PublicationTarget{Kind: "existing"}},
		{target: PublicationTarget{Kind: "unknown"}},
	} {
		_, err := s.PublishPrepare("owner", pin.SkillID, skillhub.Metadata{SkillID: tc.metadataID, License: "MIT"}, tc.target)
		var invalid *kernel.AppError
		if !errors.As(err, &invalid) || invalid.Reason != "invalid_publication_target" {
			t.Fatalf("ambiguous target was accepted: %+v %v", tc, err)
		}
	}
	plans, err := s.PublishPlans("owner")
	if err != nil || len(plans) != 0 {
		t.Fatal("invalid target created a plan", err)
	}
	old, err := s.PublishPrepare("owner", pin.SkillID, skillhub.Metadata{License: "MIT"}, PublicationTarget{Kind: "new"})
	if err != nil {
		t.Fatal(err)
	}
	old.Metadata.SkillID = pin.SkillID // The actual pre-fix model output.
	old.Kind = ""
	file, _ := s.planFile("owner", old.ID)
	if err := writeMarketJSON(file, old); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(file)
	archive, _ := os.ReadFile(strings.TrimSuffix(file, ".json") + ".zip")
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }))
	defer server.Close()
	t.Setenv("BEEFTV_SKILLHUB_URL", server.URL)
	if _, err := s.PublishUpload(context.Background(), "owner", old.ID, old.ArchiveSHA256); err == nil || calls != 0 {
		t.Fatal("legacy ambiguous target reached cloud", err)
	}
	metadata := old.Metadata
	metadata.SkillID = "" // User explicitly chooses new; no automatic redirection.
	fresh, err := s.PublishReprepare("owner", old.ID, metadata, PublicationTarget{Kind: "new"})
	if err != nil {
		t.Fatal(err)
	}
	newFile, _ := s.planFile("owner", fresh.ID)
	after, _ := os.ReadFile(file)
	newArchive, _ := os.ReadFile(strings.TrimSuffix(newFile, ".json") + ".zip")
	if !bytes.Equal(before, after) || !bytes.Equal(archive, newArchive) || fresh.Metadata.SkillID != "" || fresh.Kind != "new" || fresh.SubmissionID != "" || fresh.VersionID != old.VersionID || fresh.ContentHash != old.ContentHash {
		t.Fatal("explicit recovery changed history, files or destination")
	}
	update, err := s.PublishReprepare("owner", old.ID, metadata, PublicationTarget{Kind: "existing", MarketSkillID: cloudID})
	if err != nil || update.Metadata.SkillID != cloudID || update.MarketSkillID != cloudID || update.SkillID != pin.SkillID {
		t.Fatal("explicit cloud update destination was lost", err)
	}
}
