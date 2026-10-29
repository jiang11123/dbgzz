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

	"infinite-canvas/backend/internal/skillhub"
)

const testMarkdown = "---\nname: example\ndescription: A reusable storyboard method.\n---\nAsk about the story.\n"

func testBundle(t *testing.T) (string, string, *bundle) {
	t.Helper()
	root := t.TempDir()
	directory := filepath.Join(root, "example")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "SKILL.md"), []byte(testMarkdown), 0600); err != nil {
		t.Fatal(err)
	}
	metadata := filepath.Join(root, "metadata.json")
	data, _ := json.Marshal(skillhub.Metadata{Name: "分镜方法", Description: "A reusable method", License: "CC0-1.0", VersionLabel: "1.0.0", Requirements: []string{}, Showcase: []skillhub.Showcase{}})
	if err := os.WriteFile(metadata, data, 0600); err != nil {
		t.Fatal(err)
	}
	b, err := inspectBundle(directory, metadata)
	if err != nil {
		t.Fatal(err)
	}
	return directory, metadata, b
}

func envelope(w http.ResponseWriter, value any) {
	json.NewEncoder(w).Encode(map[string]any{"success": true, "data": value})
}

func TestRemoteSearchFetchAndExplicitInstallWithoutDesktop(t *testing.T) {
	_, _, b := testBundle(t)
	release := skillhub.Release{Metadata: b.Metadata, ReleaseID: "r_one", ContentHash: b.ContentHash, ArchiveSHA256: b.ArchiveSHA256, ArchiveBytes: int64(b.ArchiveBytes), Files: b.Files, DownloadURL: "archive"}
	release.SkillID = "s_example"
	broken := false
	compatibility := "supported"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Desktop-Token") != "" {
			t.Error("public discovery must not receive credentials")
		}
		switch r.URL.Path {
		case "/search":
			if r.URL.Query().Get("q") != "分镜" {
				t.Error("query was changed")
			}
			envelope(w, skillhub.SearchResult{Items: []skillhub.SearchItem{{SkillID: release.SkillID, ReleaseID: release.ReleaseID}}, Total: 1, Page: 1, PageSize: 20})
		case "/skills/s_example/releases/r_one":
			envelope(w, release)
		case "/skills/s_example/releases/r_one/discovery":
			envelope(w, skillhub.DiscoveryRelease{Release: release, Compatibility: skillhub.Compatibility{Status: compatibility, Reasons: []string{}}, Verification: "unverified"})
		case "/archive":
			if broken {
				w.Write([]byte("corrupt"))
			} else {
				w.Write(b.Archive)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	var out bytes.Buffer
	if err := Run(context.Background(), []string{"search", "分镜", "--market", server.URL, "--json"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "r_one") {
		t.Fatal(out.String())
	}
	destination := filepath.Join(t.TempDir(), "downloaded")
	args := []string{"fetch", release.SkillID, "--release", release.ReleaseID, "--market", server.URL, "--output", destination}
	if err := Run(context.Background(), args, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(destination, "SKILL.md"))
	if err != nil || string(data) != testMarkdown {
		t.Fatalf("download mismatch: %v", err)
	}
	if err = Run(context.Background(), args, &out); err == nil {
		t.Fatal("existing destination was overwritten")
	}
	project := t.TempDir()
	if err = Run(context.Background(), []string{"install", release.SkillID, "--release", release.ReleaseID, "--market", server.URL, "--agent", "codex", "--scope", "project", "--project", project}, &out); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(project, ".agents", "skills", "example", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"activated":false`) {
		t.Fatal("installer claimed activation")
	}
	for _, status := range []string{"unsupported", "unverified", ""} {
		compatibility = status
		other := t.TempDir()
		if err = Run(context.Background(), []string{"install", release.SkillID, "--release", release.ReleaseID, "--market", server.URL, "--agent", "codex", "--scope", "project", "--project", other, "--capabilities", "beeftv.canvas"}, &out); err == nil {
			t.Fatalf("%q compatibility was overridden by caller flags", status)
		}
		if _, err = os.Stat(filepath.Join(other, ".agents")); !os.IsNotExist(err) {
			t.Fatal("unsupported install changed the host")
		}
	}
	compatibility = "supported"
	broken = true
	destination = filepath.Join(t.TempDir(), "must-not-exist")
	if err = Run(context.Background(), []string{"fetch", release.SkillID, "--release", release.ReleaseID, "--market", server.URL, "--output", destination}, &out); err == nil {
		t.Fatal("corrupt archive accepted")
	}
	if _, err = os.Stat(destination); !os.IsNotExist(err) {
		t.Fatal("corrupt download reached destination")
	}
}

func TestRemoteUnavailableIsNotAnEmptyCatalog(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
		w.Write([]byte(`{"success":false,"error":{"code":"enterprise_service_not_configured","message":"此服务尚未开放"}}`))
	}))
	defer server.Close()
	var out bytes.Buffer
	err := Run(context.Background(), []string{"search", "分镜", "--market", server.URL}, &out)
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != 9 || failure.Reason != "enterprise_service_not_configured" || out.Len() != 0 {
		t.Fatalf("lost remote failure: %v %s", err, out.String())
	}
}

func TestSkillBundleDeterministicAndRejectsScriptsPrivateStateAndLinks(t *testing.T) {
	directory, metadata, b := testBundle(t)
	again, err := inspectBundle(directory, metadata)
	if err != nil || again.ArchiveSHA256 != b.ArchiveSHA256 {
		t.Fatalf("bundle changed: %v", err)
	}
	if err = os.Mkdir(filepath.Join(directory, "scripts"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = inspectBundle(directory, metadata); err == nil {
		t.Fatal("script directory accepted")
	}
	if err = os.Remove(filepath.Join(directory, "scripts")); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(metadata, filepath.Join(directory, "external.json")); err != nil {
		t.Fatal(err)
	}
	if _, err = inspectBundle(directory, metadata); err == nil {
		t.Fatal("symbolic link accepted")
	}
}
