package skills

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/skillhub"
)

func testMarketRelease(t *testing.T, version, body string) (skillhub.Release, []byte) {
	t.Helper()
	a, e := archiveFromMarkdown([]byte("---\nname: Market test\ndescription: Repeatable test\n---\n"+body), "", "")
	if e != nil {
		t.Fatal(e)
	}
	b, e := encodeSkillArchive(a.Files)
	if e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256(b)
	h := sha256.Sum256(a.Files["SKILL.md"])
	return skillhub.Release{Metadata: skillhub.Metadata{SkillID: "test-market", Name: "Market test", Description: "Repeatable test", License: "CC0-1.0", VersionLabel: version, Requirements: []string{}, Showcase: []skillhub.Showcase{}}, ReleaseID: version, ContentHash: a.ContentHash, ArchiveSHA256: hex.EncodeToString(sum[:]), ArchiveBytes: int64(len(b)), Files: []skillhub.File{{Path: "SKILL.md", SHA256: hex.EncodeToString(h[:]), Size: int64(len(a.Files["SKILL.md"])), MimeType: "text/markdown"}}, DownloadURL: "archive"}, b
}
func TestMarketInstallUpdateRollbackAndHashFailurePreservePins(t *testing.T) {
	s, _ := agentSkillFixture(t)
	r1, b1 := testMarketRelease(t, "v1", "RULE_ONE")
	r2, b2 := testMarketRelease(t, "v2", "RULE_TWO")
	current, data := r1, b1
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/archive" {
			w.Write(data)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"success": true, "data": current})
	}))
	defer server.Close()
	t.Setenv("BEEFTV_SKILLHUB_URL", server.URL)
	first, e := s.InstallMarket(context.Background(), "owner", r1.SkillID, r1.ReleaseID)
	if e != nil {
		t.Fatal(e)
	}
	pin := Pin{SkillID: first.SkillID, VersionID: first.VersionID, ContentHash: first.ContentHash}
	if first.SourceCommit != "v1" {
		t.Fatal("market release mapping missing", first.SourceCommit)
	}
	current, data = r2, b2
	second, e := s.InstallMarket(context.Background(), "owner", r2.SkillID, r2.ReleaseID)
	if e != nil {
		t.Fatal(e)
	}
	if second.SkillID != first.SkillID || second.VersionID == first.VersionID {
		t.Fatal("update replaced identity")
	}
	old, e := s.AgentVersion("owner", pin)
	if e != nil || !strings.Contains(old.Instruction, "RULE_ONE") {
		t.Fatal("old task pin changed", e)
	}
	rolled, e := s.RollbackMarket("owner", first.SkillID, first.VersionID)
	if e != nil || rolled.VersionID != first.VersionID || !strings.Contains(rolled.Instruction, "RULE_ONE") {
		t.Fatal("rollback did not restore exact content", e)
	}
	current.ArchiveSHA256 = strings.Repeat("0", 64)
	if _, e = s.InstallMarket(context.Background(), "owner", r2.SkillID, r2.ReleaseID); e == nil {
		t.Fatal("accepted corrupt archive")
	}
	after, _ := s.SkillDetail("owner", first.SkillID)
	if after.VersionID != first.VersionID {
		t.Fatal("bad update displaced old version")
	}
	// A metadata-only release still has a distinct distribution identity.
	current, data = r1, b1
	current.ReleaseID = "v1.0.1"
	current.VersionLabel = "1.0.1"
	current.Name = "Revised public title"
	metadataOnly, e := s.InstallMarket(context.Background(), "owner", current.SkillID, current.ReleaseID)
	if e != nil || metadataOnly.VersionID == first.VersionID || metadataOnly.SourceCommit != current.ReleaseID || metadataOnly.SkillName != current.Name {
		t.Fatalf("metadata release was skipped: %+v %v", metadataOnly, e)
	}
}
func TestPublicationRequiresTwoSpecificUserConfirmations(t *testing.T) {
	s, _ := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: Publish test\ndescription: Preview before uploading\n---\nDo the requested task."})
	calls, uploads, submits := 0, 0, 0
	revision := int64(1)
	var archive []byte
	var draft skillhub.Draft
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		draft.SubmissionID, draft.Revision, draft.Status = "submission-one", revision, "draft"
		data := any(skillhub.Draft{SubmissionID: "submission-one", Revision: revision, Status: "draft"})
		if uploads > 0 {
			data = draft
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/uploads"):
			uploads++
			if e := r.ParseMultipartForm(1 << 20); e != nil {
				t.Error(e)
			}
			revision++
			draft.Revision = revision
			data = draft
		case strings.HasSuffix(r.URL.Path, "/validate"):
			draft.Status = "ready_to_submit"
			data = draft
		case strings.HasSuffix(r.URL.Path, "/preview"):
			data = skillhub.Preview{SubmissionID: "submission-one", Revision: revision, PreviewDigest: "preview-one", Files: draft.Files, Metadata: draft.Metadata}
		case strings.HasSuffix(r.URL.Path, "/archive"):
			w.Write(archive)
			return
		case strings.HasSuffix(r.URL.Path, "/submit"):
			submits++
			data = skillhub.Draft{SubmissionID: "submission-one", Revision: revision, Status: "submitted"}
		}
		json.NewEncoder(w).Encode(map[string]any{"success": true, "data": data})
	}))
	defer server.Close()
	t.Setenv("BEEFTV_SKILLHUB_URL", server.URL)
	if e := writeMarketJSON(filepath.Join(s.marketUserDir("owner"), "authorization.json"), marketAuth{Endpoint: server.URL, AccessToken: "btvpub_test_fixture_only", ExpiresAt: time.Now().Add(time.Hour)}); e != nil {
		t.Fatal(e)
	}
	plan, e := s.PublishPrepareInCanvas("owner", pin.SkillID, "canvas-one", skillhub.Metadata{License: "CC0-1.0"}, PublicationTarget{})
	if e != nil {
		t.Fatal(e)
	}
	file, _ := s.planFile("owner", plan.ID)
	archive, e = os.ReadFile(strings.TrimSuffix(file, ".json") + ".zip")
	if e != nil {
		t.Fatal(e)
	}
	draft = skillhub.Draft{Metadata: plan.Metadata, Files: plan.Files, ContentHash: plan.ContentHash, ArchiveSHA256: plan.ArchiveSHA256, ArchiveBytes: int64(len(archive))}
	if calls != 0 {
		t.Fatal("preparing uploaded content")
	}
	if _, e = s.PublishUpload(context.Background(), "owner", plan.ID, "changed-hash"); e == nil || calls != 0 {
		t.Fatal("upload confirmation did not bind exact files")
	}
	u, e := s.PublishUpload(context.Background(), "owner", plan.ID, plan.ArchiveSHA256)
	if e != nil {
		t.Fatal(e)
	}
	if uploads != 1 || submits != 0 || u.Status != "awaiting_submit_confirmation" {
		t.Fatal("upload also submitted", uploads, submits)
	}
	if _, e = s.PublishSubmit(context.Background(), "owner", plan.ID, revision, "changed-preview"); e == nil || submits != 0 {
		t.Fatal("submit accepted changed preview")
	}
	done, e := s.PublishSubmit(context.Background(), "owner", plan.ID, revision, "preview-one")
	if e != nil || done.Status != "submitted" || submits != 1 {
		t.Fatal("confirmed submit failed", e)
	}
	if _, e = s.PublishPlan("other-owner", plan.ID); e == nil {
		t.Fatal("leaked another author's private plan")
	}
}

func TestMarketMinimumClientVersion(t *testing.T) {
	for _, c := range []struct {
		current, minimum string
		want             bool
	}{{"dev", "", true}, {"dev", "1.0.0", false}, {"1.7.22", "1.7.21", true}, {"1.7.22", "1.8.0", false}, {"1.7.22", "garbage", false}, {"1.7.22", "1.7.22", true}, {"v2.0.1-skill.1", "2.0.0", true}, {"v2.0.1-skill.1", "2.0.1", false}} {
		if got := marketClientCompatible(c.current, c.minimum); got != c.want {
			t.Fatalf("%+v got %v", c, got)
		}
	}
}
func TestPrivateForkKeepsReferencesWhenEdited(t *testing.T) {
	s, _ := agentSkillFixture(t)
	a, e := finalizeSkillArchive(map[string][]byte{"SKILL.md": []byte("---\nname: Original\ndescription: Method\n---\nSee references/rules.md"), "LICENSE": []byte("CC0"), "references/rules.md": []byte("KEEP_REFERENCE")}, skillPackageMetadata{Name: "Original", Description: "Method"})
	if e != nil {
		t.Fatal(e)
	}
	original, e := s.createSkillFromArchive("owner", a, SkillInstallRequest{IsPrivate: true}, "market", "https://beeftv.app/skills/original", "original", "", "release", false)
	if e != nil {
		t.Fatal(e)
	}
	fork, e := s.ForkMarket("owner", original.SkillID)
	if e != nil {
		t.Fatal(e)
	}
	if !fork.IsPrivate || fork.SkillID == original.SkillID || fork.SourceType != "markdown" {
		t.Fatalf("invalid fork %+v", fork)
	}
	fork, e = s.UpdateSkill("owner", fork.SkillID, SkillMutationRequest{SkillName: fork.SkillName, Description: fork.Description, Instruction: "Updated method referencing references/rules.md", IsPrivate: true, Tag: "others"})
	if e != nil {
		t.Fatal(e)
	}
	f, e := s.SkillPackageFile("owner", fork.SkillID, "references/rules.md")
	if e != nil || !strings.Contains(f.Content, "KEEP_REFERENCE") {
		t.Fatalf("reference lost %+v %v", f, e)
	}
	if _, e = s.SkillPackageFile("owner", fork.SkillID, "LICENSE"); e != nil {
		t.Fatal("license lost", e)
	}
	unchanged, e := s.SkillDetail("owner", original.SkillID)
	if e != nil || unchanged.VersionID != original.VersionID {
		t.Fatal("fork changed upstream", e)
	}
}
