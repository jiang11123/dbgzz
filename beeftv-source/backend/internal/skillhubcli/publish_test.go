package skillhubcli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/privatefile"
	"infinite-canvas/backend/internal/skillhub"
)

func TestPublishingConfirmationRetryAndPrivateCredentials(t *testing.T) {
	directory, metadata, b := testBundle(t)
	stateFile := filepath.Join(t.TempDir(), "state.json")
	approved := false
	createCount, uploadCount := 0, 0
	firstUpload := true
	const token = "fixture-publishing-token"
	draft := skillhub.Draft{SubmissionID: "d_fixture", Revision: 1, Status: "draft", Metadata: b.Metadata}
	previewDigest := "preview-one"
	accountID := 1
	var submitKeys []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/authorizations" && r.URL.Path != "/authorizations/token" && r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("publishing token missing")
		}
		switch r.URL.Path {
		case "/session":
			envelope(w, skillhub.PublishingAccount{UserID: accountID, Username: "author", DisplayName: "Actual author"})
		case "/authorizations":
			envelope(w, skillhub.Authorization{DeviceCode: "fixture-device-secret", UserCode: "USER-ONLY", VerificationURL: "https://beeftv.app/skills/authorize?user_code=USER-ONLY", ExpiresIn: 600, Interval: 5})
		case "/authorizations/token":
			if !approved {
				w.WriteHeader(409)
				w.Write([]byte(`{"success":false,"reason":"authorization_pending"}`))
				return
			}
			envelope(w, skillhub.Token{AccessToken: token, ExpiresIn: 600})
		case "/submissions":
			if r.Method != "POST" || r.Header.Get("Idempotency-Key") == "" {
				t.Error("draft creation not idempotent")
			}
			createCount++
			envelope(w, draft)
		case "/submissions/d_fixture":
			envelope(w, draft)
		case "/submissions/d_fixture/uploads":
			uploadCount++
			if err := r.ParseMultipartForm(10 << 20); err != nil {
				t.Error(err)
			}
			defer r.MultipartForm.RemoveAll()
			draft.ContentHash = b.ContentHash
			draft.ArchiveSHA256 = b.ArchiveSHA256
			draft.Revision++
			draft.Files = b.Files
			if firstUpload {
				firstUpload = false
				w.WriteHeader(503)
				w.Write([]byte(`{"success":false,"reason":"response_lost"}`))
				return
			}
			envelope(w, draft)
		case "/submissions/d_fixture/validate":
			draft.Status = "ready_to_submit"
			envelope(w, draft)
		case "/submissions/d_fixture/preview":
			envelope(w, skillhub.Preview{SubmissionID: draft.SubmissionID, Revision: draft.Revision, PreviewDigest: previewDigest, Metadata: b.Metadata, Files: b.Files})
		case "/submissions/d_fixture/submit":
			submitKeys = append(submitKeys, r.Header.Get("Idempotency-Key"))
			draft.Status = "submitted"
			envelope(w, draft)
		case "/authorizations/revoke":
			envelope(w, map[string]bool{"revoked": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	var out bytes.Buffer
	run := func(args ...string) error {
		out.Reset()
		args = append(args, "--market", server.URL, "--state", stateFile)
		err := Run(context.Background(), args, &out)
		if strings.Contains(out.String(), token) || strings.Contains(out.String(), "fixture-device-secret") {
			t.Fatal("credential leaked to output")
		}
		return err
	}
	if err := run("authorize"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "USER-ONLY") {
		t.Fatal(out.String())
	}
	if err := run("poll"); err == nil {
		t.Fatal("pending authorization accepted")
	}
	approved = true
	if err := run("poll"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"userId":1`) {
		t.Fatal("authorized account missing from receipt")
	}
	if info, err := os.Stat(stateFile); err != nil || privatefile.Check(stateFile, info) != nil {
		t.Fatalf("state permissions: %v", err)
	}
	if err := run("upload", directory, "--metadata", metadata); err == nil || createCount != 0 {
		t.Fatal("upload without exact confirmation reached server")
	}
	uploadArgs := []string{"upload", directory, "--metadata", metadata, "--confirm-upload", "--content-hash", b.ContentHash, "--archive-sha256", b.ArchiveSHA256}
	accountID = 2
	if err := run(uploadArgs...); err == nil || createCount != 0 {
		t.Fatal("changed account reached upload")
	}
	accountID = 1
	if err := run(uploadArgs...); err == nil {
		t.Fatal("lost upload response should be reported")
	}
	if err := run(uploadArgs...); err != nil {
		t.Fatal(err)
	}
	if createCount != 1 || uploadCount != 1 {
		t.Fatalf("upload retry duplicated work: creates=%d uploads=%d", createCount, uploadCount)
	}
	if err := run("preview"); err != nil {
		t.Fatal(err)
	}
	if err := run("submit", "--revision", "2", "--preview-digest", previewDigest); err == nil || len(submitKeys) != 0 {
		t.Fatal("public submit lacked explicit confirmation")
	}
	previewDigest = "preview-two"
	if err := run("submit", "--confirm-submit", "--revision", "2", "--preview-digest", "preview-one"); err == nil || len(submitKeys) != 0 {
		t.Fatal("changed preview submitted")
	}
	for i := 0; i < 2; i++ {
		if err := run("submit", "--confirm-submit", "--revision", "2", "--preview-digest", previewDigest); err != nil {
			t.Fatal(err)
		}
	}
	if len(submitKeys) != 2 || submitKeys[0] == "" || submitKeys[0] != submitKeys[1] {
		t.Fatal("submit retry did not retain idempotency identity")
	}
	if err := run("revoke"); err != nil {
		t.Fatal(err)
	}
	state, err := loadState(stateFile, server.URL, false)
	if err != nil || state.AccessToken != "" || state.DeviceCode != "" {
		t.Fatal("revocation retained local credentials")
	}
}

func TestPublishingStateIsolationAndCredentialFileRejection(t *testing.T) {
	stateFile := filepath.Join(t.TempDir(), "state.json")
	if err := saveState(stateFile, &publishingState{Market: "https://one.example", AccessToken: "fixture"}); err != nil {
		t.Fatal(err)
	}
	if _, err := loadState(stateFile, "https://two.example", false); err == nil {
		t.Fatal("authorization crossed markets")
	}
	unlock, err := lockState(stateFile)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = lockState(stateFile); err == nil {
		t.Fatal("parallel state writers admitted")
	}
	unlock()
	directory, metadata, _ := testBundle(t)
	secret := map[string]string{"accessToken": "btvpub_" + strings.Repeat("a", 32)}
	data, _ := json.Marshal(secret)
	if err = os.WriteFile(filepath.Join(directory, "publish-state.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	_, err = inspectBundle(directory, metadata)
	var failure *Error
	if !errors.As(err, &failure) || failure.Reason != "private_file" {
		t.Fatalf("private state accepted: %v", err)
	}
}
