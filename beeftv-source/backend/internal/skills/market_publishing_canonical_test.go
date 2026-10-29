package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/skillhub"
)

func TestPublicationCanonicalArchiveRecoveryNeverReuploads(t *testing.T) {
	for _, loseUploadResponse := range []bool{false, true} {
		name := "normal"
		if loseUploadResponse {
			name = "lost-upload-response"
		}
		t.Run(name, func(t *testing.T) {
			s, _ := agentSkillFixture(t)
			pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: Canonical package\ndescription: Text only\n---\nRead references/rules.md", "references/rules.md": "Keep this attachment"})
			plan, err := s.PublishPrepare("owner", pin.SkillID, skillhub.Metadata{License: "MIT"}, PublicationTarget{Kind: "new"})
			if err != nil {
				t.Fatal(err)
			}
			draft := skillhub.Draft{SubmissionID: "d_fixture", Revision: 1, Status: "draft", Metadata: plan.Metadata}
			draft.Metadata.SkillID = "s_assigned_by_service"
			var canonical []byte
			creates, uploads := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var value any = draft
				switch {
				case r.Method == "POST" && r.URL.Path == "/submissions":
					creates++
					var metadata skillhub.Metadata
					if err := json.NewDecoder(r.Body).Decode(&metadata); err != nil || metadata.SkillID != "" {
						t.Error("new publication sent a cloud/local ID", err)
					}
				case strings.HasSuffix(r.URL.Path, "/uploads"):
					uploads++
					if err := r.ParseMultipartForm(1 << 20); err != nil {
						t.Error(err)
						return
					}
					f, _, err := r.FormFile("file")
					if err != nil {
						t.Error(err)
						return
					}
					defer f.Close()
					raw, err := io.ReadAll(f)
					if err != nil {
						t.Error(err)
						return
					}
					archive, err := archiveFromZip(raw, "")
					if err != nil {
						t.Error(err)
						return
					}
					// Reproduce the service's canonicalization: no local ZIP timestamp.
					var buffer bytes.Buffer
					writer := zip.NewWriter(&buffer)
					for _, path := range sortedSkillPaths(archive.Files) {
						header := &zip.FileHeader{Name: path, Method: zip.Deflate}
						header.SetMode(0600)
						entry, err := writer.CreateHeader(header)
						if err != nil {
							t.Error(err)
							return
						}
						if _, err = entry.Write(archive.Files[path]); err != nil {
							t.Error(err)
							return
						}
					}
					if err := writer.Close(); err != nil {
						t.Error(err)
						return
					}
					canonical = buffer.Bytes()
					sum := sha256.Sum256(canonical)
					draft.ContentHash, draft.Files = archive.ContentHash, append([]skillhub.File{}, plan.Files...)
					draft.ArchiveSHA256, draft.ArchiveBytes = hex.EncodeToString(sum[:]), int64(len(canonical))
					draft.Revision++
					if draft.ArchiveSHA256 == plan.ArchiveSHA256 {
						t.Error("fixture failed to canonicalize ZIP")
					}
					if loseUploadResponse {
						w.WriteHeader(502)
						json.NewEncoder(w).Encode(map[string]any{"success": false, "message": "simulated response loss after storage", "reason": "fixture_response_loss"})
						return
					}
					value = draft
				case strings.HasSuffix(r.URL.Path, "/archive"):
					w.Write(canonical)
					return
				case strings.HasSuffix(r.URL.Path, "/preview"):
					value = skillhub.Preview{SubmissionID: draft.SubmissionID, Revision: draft.Revision, PreviewDigest: "preview-digest", Metadata: draft.Metadata, Files: draft.Files}
				}
				json.NewEncoder(w).Encode(map[string]any{"success": true, "data": value})
			}))
			defer server.Close()
			t.Setenv("BEEFTV_SKILLHUB_URL", server.URL)
			if err = writeMarketJSON(filepath.Join(s.marketUserDir("owner"), "authorization.json"), marketAuth{Endpoint: server.URL, AccessToken: "fixture-only", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
				t.Fatal(err)
			}
			first, err := s.PublishUpload(context.Background(), "owner", plan.ID, plan.ArchiveSHA256)
			if loseUploadResponse && err == nil {
				t.Fatal("response loss was not surfaced")
			}
			if !loseUploadResponse && (err != nil || first.Status != "awaiting_submit_confirmation") {
				t.Fatal("normal canonical preview failed", err)
			}
			recovered, err := s.PublishUpload(context.Background(), "owner", plan.ID, plan.ArchiveSHA256)
			if err != nil {
				t.Fatal(err)
			}
			if creates != 1 || uploads != 1 || recovered.ArchiveSHA256 != plan.ArchiveSHA256 || recovered.Preview == nil || recovered.Metadata.SkillID != draft.Metadata.SkillID || recovered.Status != "awaiting_submit_confirmation" {
				t.Fatalf("recovery rewrote files or lost original confirmation: creates=%d uploads=%d plan=%+v", creates, uploads, recovered)
			}
			draft.Files[0].SHA256 = strings.Repeat("0", 64)
			if _, err := s.PublishUpload(context.Background(), "owner", plan.ID, plan.ArchiveSHA256); err == nil || uploads != 1 {
				t.Fatal("altered manifest accepted or reuploaded")
			}
			draft.Files = append([]skillhub.File{}, plan.Files...)
			canonical = append(canonical, byte(0))
			if _, err := s.PublishUpload(context.Background(), "owner", plan.ID, plan.ArchiveSHA256); err == nil || uploads != 1 {
				t.Fatal("tampered canonical archive accepted or reuploaded")
			}
		})
	}
}
