package asset

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestOpenRangeServesPartialBytes(t *testing.T) {
	svc, repo, dataDir := newTestDomain(t)
	objectKey := "users/user-1/image/clip.bin"
	if err := os.MkdirAll(filepath.Join(dataDir, "resources", "users", "user-1", "image"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey)), []byte("abcdefghij"), 0o640); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{
		ID: "resource-range", UserID: "user-1", Kind: "file", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: objectKey, MimeType: "application/octet-stream", Size: 10,
	}
	if err := repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	stream, err := svc.OpenRange("user-1", resource.ID, "bytes=2-5")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	if stream.StatusCode != http.StatusPartialContent || stream.ContentRange != "bytes 2-5/10" || stream.ContentLength != 4 {
		t.Fatalf("stream = %#v", stream)
	}
	body, err := io.ReadAll(stream.Body)
	if err != nil || string(body) != "cdef" {
		t.Fatalf("body = %q err=%v", body, err)
	}
}

func TestOpenRangeRejectsForeignOwnerAndTraversal(t *testing.T) {
	svc, repo, dataDir := newTestDomain(t)
	if err := os.WriteFile(filepath.Join(dataDir, "secret"), []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	owned := model.Resource{
		ID: "resource-owned", UserID: "user-1", Kind: "file", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/file/owned.bin", Size: 4,
	}
	escaped := model.Resource{
		ID: "resource-traversal", UserID: "user-1", Kind: "file", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "../secret", Size: 7,
	}
	for _, resource := range []model.Resource{owned, escaped} {
		if err := repo.CreateResource(&resource); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.OpenRange("user-2", owned.ID, ""); err == nil {
		t.Fatal("foreign owner opened resource")
	}
	stream, err := svc.OpenRange("user-1", escaped.ID, "")
	if stream != nil && stream.Body != nil {
		_ = stream.Body.Close()
	}
	if err == nil {
		t.Fatal("OpenRange() opened a path outside the local resource root")
	}
}

func TestOpenRangeRejectsPendingResource(t *testing.T) {
	svc, repo, _ := newTestDomain(t)
	resource := model.Resource{
		ID: "resource-pending-open", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/pending.png",
	}
	if err := repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.OpenRange("user-1", resource.ID, ""); err == nil {
		t.Fatal("pending resource opened")
	}
}
