package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

type resourceFailingReader struct{ delivered bool }

func (r *resourceFailingReader) Read(buffer []byte) (int, error) {
	if r.delivered {
		return 0, errors.New("injected resource read failure")
	}
	r.delivered = true
	return copy(buffer, "partial"), nil
}

func TestStoreResourceObjectDelegatesToAtomicLocalStore(t *testing.T) {
	dataDir := t.TempDir()
	svc := &Service{dataDir: dataDir, mode: serviceModeLocal, localResourceStorage: true}
	resource := &model.Resource{
		ID:        "resource-atomic",
		UserID:    "local",
		Kind:      "image",
		MimeType:  "image/png",
		ObjectKey: "workspaces/local/image/resource-atomic.png",
	}
	if _, err := svc.storeResourceObject(resource, "asset.png", strings.NewReader("original")); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.storeResourceObject(resource, "asset.png", &resourceFailingReader{}); err == nil {
		t.Fatal("storeResourceObject() error = nil for failing reader")
	}
	body, err := os.ReadFile(filepath.Join(dataDir, "resources", filepath.FromSlash(resource.ObjectKey)))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "original" {
		t.Fatalf("resource body = %q, want original", body)
	}
}

func TestOpenResourceRangeRejectsObjectKeyOutsideLocalStore(t *testing.T) {
	svc := newResourceTestService(t)
	svc.mode = serviceModeLocal
	svc.localResourceStorage = true
	if err := os.WriteFile(filepath.Join(svc.dataDir, "secret"), []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{
		ID:        "resource-traversal",
		UserID:    "local",
		Kind:      "document",
		Status:    model.ResourceStatusReady,
		Provider:  "local",
		ObjectKey: "../secret",
		Size:      7,
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	stream, err := svc.OpenResourceRange("local", resource.ID, "")
	if stream != nil {
		_ = stream.Body.Close()
	}
	if err == nil {
		t.Fatal("OpenResourceRange() opened a path outside the local resource root")
	}
}
