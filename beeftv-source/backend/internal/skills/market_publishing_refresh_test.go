package skills

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/skillhub"
)

func TestPublicationCloudEditRequiresFreshPreviewWithoutReupload(t *testing.T) {
	s, _ := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: Original\ndescription: Original method\n---\nORIGINAL_BODY"})
	plan, e := s.PublishPrepare("owner", pin.SkillID, skillhub.Metadata{License: "CC0-1.0"}, PublicationTarget{})
	if e != nil {
		t.Fatal(e)
	}
	oldPreview := skillhub.Preview{SubmissionID: "cloud-one", Revision: 1, PreviewDigest: "old-preview", Metadata: plan.Metadata}
	plan.SubmissionID = "cloud-one"
	plan.Preview = &oldPreview
	plan.Status = "awaiting_submit_confirmation"
	file, _ := s.planFile("owner", plan.ID)
	if e = writeMarketJSON(file, plan); e != nil {
		t.Fatal(e)
	}
	release, data := testMarketRelease(t, "v2", "CHANGED_CLOUD_BODY")
	release.Name = "Changed on website"
	release.License = "MIT"
	draft := skillhub.Draft{SubmissionID: "cloud-one", Revision: 2, Status: "draft", Metadata: release.Metadata, Files: release.Files, ContentHash: release.ContentHash, ArchiveSHA256: release.ArchiveSHA256, ArchiveBytes: release.ArchiveBytes}
	preview := skillhub.Preview{SubmissionID: "cloud-one", Author: "Actual author", Revision: 2, PreviewDigest: "new-preview", Metadata: release.Metadata, Files: release.Files}
	uploads, submits := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("publishing grant missing")
		}
		var value any = draft
		switch {
		case strings.HasSuffix(r.URL.Path, "/uploads"):
			uploads++
			t.Error("refresh must not overwrite remote files")
		case strings.HasSuffix(r.URL.Path, "/archive"):
			w.Write(data)
			return
		case strings.HasSuffix(r.URL.Path, "/preview"):
			value = preview
		case strings.HasSuffix(r.URL.Path, "/submit"):
			submits++
			var a struct {
				Revision int64  `json:"revision"`
				Digest   string `json:"previewDigest"`
			}
			json.NewDecoder(r.Body).Decode(&a)
			if a.Revision != 2 || a.Digest != "new-preview" {
				w.WriteHeader(409)
				json.NewEncoder(w).Encode(map[string]any{"success": false, "reason": "revision_conflict", "message": "changed"})
				return
			}
			draft.Status = "submitted"
			value = draft
		}
		json.NewEncoder(w).Encode(map[string]any{"success": true, "data": value})
	}))
	defer server.Close()
	t.Setenv("BEEFTV_SKILLHUB_URL", server.URL)
	if e = writeMarketJSON(filepath.Join(s.marketUserDir("owner"), "authorization.json"), marketAuth{Endpoint: server.URL, AccessToken: "test-token", ExpiresAt: time.Now().Add(time.Minute)}); e != nil {
		t.Fatal(e)
	}
	if _, e = s.PublishUpload(context.Background(), "owner", plan.ID, plan.ArchiveSHA256); e == nil || uploads != 0 {
		t.Fatal("confirmed local upload adopted changed cloud files")
	}
	if _, e = s.PublishSubmit(context.Background(), "owner", plan.ID, 1, "old-preview"); e == nil {
		t.Fatal("stale preview submitted")
	}
	changed, e := s.PublicationStatus(context.Background(), "owner", plan.ID)
	if e != nil || changed.Preview != nil || changed.Status != "needs_preview" {
		t.Fatalf("stale confirmation retained %+v %v", changed, e)
	}
	updated, e := s.RefreshPublication(context.Background(), "owner", plan.ID)
	if e != nil {
		t.Fatal(e)
	}
	if updated.Preview.Revision != 2 || updated.Metadata.License != "MIT" || updated.Metadata.Name != "Changed on website" || !strings.Contains(updated.Instruction, "CHANGED_CLOUD_BODY") {
		t.Fatalf("preview differs from visible content %+v", updated)
	}
	if uploads != 0 || submits != 0 {
		t.Fatal("refresh performed an unauthorized write", uploads, submits)
	}
	if _, e = s.PublishSubmit(context.Background(), "owner", plan.ID, 1, "old-preview"); e == nil {
		t.Fatal("old confirmation remained usable")
	}
	if submits != 0 {
		t.Fatal("old confirmation reached server")
	}
	if _, e = s.PublishSubmit(context.Background(), "owner", plan.ID, 2, "new-preview"); e != nil {
		t.Fatal(e)
	}
	if submits != 1 {
		t.Fatal("new explicit confirmation not submitted")
	}
}
