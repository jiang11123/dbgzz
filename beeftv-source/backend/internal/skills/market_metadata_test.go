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
	"reflect"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/skillhub"
)

func TestMarketVersionMetadataSurvivesOfflineForkEditAndRollback(t *testing.T) {
	s, db := agentSkillFixture(t)
	raw, _ := db.DB()
	raw.SetMaxOpenConns(1)
	r1, data := testMarketRelease(t, "v1", "ORIGINAL_RULE")
	r1.Name, r1.Description = "Reviewed original title", "Reviewed original description"
	r1.Author, r1.License, r1.SourceURL = "Original author", "CC-BY-SA-4.0", "https://example.invalid/original"
	r2 := r1
	r2.ReleaseID, r2.VersionLabel = "v2", "2.0.0"
	r2.Name, r2.Description = "Reviewed second title", "Reviewed second description"
	r2.Author, r2.License, r2.SourceURL = "Second author", "CC-BY-NC-SA-4.0", "https://example.invalid/second"
	current := r1
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/archive" {
			_, _ = w.Write(data)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": current})
	}))
	t.Cleanup(server.Close)
	t.Setenv("BEEFTV_SKILLHUB_URL", server.URL)
	first, err := s.InstallMarket(context.Background(), "owner", r1.SkillID, r1.ReleaseID)
	if err != nil {
		t.Fatal(err)
	}
	assertRelease := func(item *SkillItem, want skillhub.Release) {
		t.Helper()
		if !reflect.DeepEqual(item.MarketRelease, &want) || item.SourceURL != want.SourceURL {
			t.Fatalf("reviewed metadata changed: %+v want %+v", item, want)
		}
	}
	assertRelease(first, r1)
	var originalVersion model.SkillVersion
	if err := db.First(&originalVersion, "id = ?", first.VersionID).Error; err != nil {
		t.Fatal(err)
	}
	zipBytes, err := os.ReadFile(filepath.Join(s.dataDir, "skill-packages", filepath.FromSlash(originalVersion.PackageKey)))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(zipBytes)
	if hex.EncodeToString(sum[:]) != r1.ArchiveSHA256 || first.ContentHash != r1.ContentHash {
		t.Fatal("saving release metadata changed canonical package bytes or hash")
	}
	current = r2 // Same ZIP and content hash, independently reviewed public metadata.
	second, err := s.InstallMarket(context.Background(), "owner", r2.SkillID, r2.ReleaseID)
	if err != nil {
		t.Fatal(err)
	}
	assertRelease(second, r2)
	if second.VersionID == first.VersionID || second.SkillName != r2.Name {
		t.Fatal("metadata-only update did not create its own version")
	}
	var unchangedVersion model.SkillVersion
	if err := db.First(&unchangedVersion, "id = ?", first.VersionID).Error; err != nil || unchangedVersion.MarketReleaseJSON != originalVersion.MarketReleaseJSON {
		t.Fatal("update mutated old release metadata", err)
	}
	current.ReleaseID, current.ArchiveSHA256 = "bad-release", strings.Repeat("0", 64)
	if _, err := s.InstallMarket(context.Background(), "owner", current.SkillID, current.ReleaseID); err == nil {
		t.Fatal("corrupt update accepted")
	}
	afterFailure, err := s.SkillDetail("owner", first.SkillID)
	if err != nil || afterFailure.VersionID != second.VersionID {
		t.Fatal("failed installation changed active version", err)
	}
	assertRelease(afterFailure, r2)
	server.Close()
	rolled, err := s.RollbackMarket("owner", first.SkillID, first.VersionID)
	if err != nil {
		t.Fatal(err)
	}
	assertRelease(rolled, r1)
	if rolled.SkillName != r1.Name || rolled.Description != r1.Description || rolled.VersionID != first.VersionID {
		t.Fatal("rollback did not restore reviewed version title and description")
	}
	bundle, err := s.SkillPackageBundle("owner", first.SkillID)
	if err != nil || !reflect.DeepEqual(bundle.MarketRelease, &r1) || len(bundle.Files) != 1 {
		t.Fatal("offline package lost metadata or gained a synthetic provenance file", err)
	}
	fork, err := s.ForkMarket("owner", first.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	assertRelease(fork, r1)
	if fork.ContentHash != first.ContentHash || fork.SourceType != "markdown" || !fork.IsPrivate {
		t.Fatal("fork changed original bytes or is not a private draft")
	}
	edited, err := s.UpdateSkill("owner", fork.SkillID, SkillMutationRequest{SkillName: "My revised method", Description: "A private derivative", Instruction: "---\nname: My revised method\ndescription: A private derivative\n---\nEDITED_RULE", MarkdownURL: fork.MarkdownURL, IsPrivate: true, Tag: "others"})
	if err != nil {
		t.Fatal(err)
	}
	assertRelease(edited, r1)
	if edited.ContentHash == first.ContentHash || edited.SkillName != "My revised method" {
		t.Fatal("private edit failed or changed title to original release")
	}
	editedBundle, err := s.SkillPackageBundle("owner", fork.SkillID)
	if err != nil || !reflect.DeepEqual(editedBundle.MarketRelease, &r1) {
		t.Fatal("editing discarded original attribution and license", err)
	}
	if _, err := s.PublishPrepare("owner", fork.SkillID, skillhub.Metadata{}, PublicationTarget{}); err == nil {
		t.Fatal("market derivative silently chose a publication target")
	}
	plan, err := s.PublishPrepare("owner", fork.SkillID, skillhub.Metadata{}, PublicationTarget{Kind: "new"})
	if err != nil || plan.Metadata.License != r1.License || plan.Metadata.SourceURL != r1.SourceURL || !reflect.DeepEqual(plan.Source, &r1) || plan.VersionID != edited.VersionID || plan.ContentHash != edited.ContentHash {
		t.Fatal("publication preparation lost provenance or used the original package instead of the edited version", err)
	}
	if plan.Metadata.SkillID != "" || plan.MarketSkillID != "" {
		t.Fatal("new derivative targeted original author's cloud skill")
	}
	if _, err := s.SkillPackageBundle("another-owner", fork.SkillID); err == nil {
		t.Fatal("release metadata bypassed private package ownership")
	}
	if _, err := s.RollbackMarket("another-owner", first.SkillID, first.VersionID); err == nil {
		t.Fatal("release metadata bypassed rollback ownership")
	}
}

func TestMarketReleaseMetadataDoesNotGuessLegacyAttribution(t *testing.T) {
	if release, err := marketReleaseMetadata(""); err != nil || release != nil {
		t.Fatalf("legacy blank metadata should remain absent: %+v %v", release, err)
	}
	for _, raw := range []string{`{`, `null`, `{}`} {
		if _, err := marketReleaseMetadata(raw); err == nil {
			t.Fatalf("accepted corrupt release metadata %q", raw)
		}
	}
}
