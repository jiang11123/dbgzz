package asset

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSyncDirectoryReportsMissingPath(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing-resource-dir")
	err := syncDirectory(missing)
	if err == nil {
		t.Fatal("syncDirectory() error = nil for a missing path")
	}
	if !os.IsNotExist(err) && !strings.Contains(strings.ToLower(err.Error()), "cannot find") && !strings.Contains(strings.ToLower(err.Error()), "no such file") {
		t.Fatalf("syncDirectory() error = %v, want a missing-path error", err)
	}
}

func TestFileStoreWritePublishesFileAfterAtomicReplace(t *testing.T) {
	dataDir := t.TempDir()
	store := NewFileStore(dataDir)
	const key = "users/280ad63bd8a3628dfe4c88266bd530a1/image/2026/09/24/generated.png"
	if err := store.Write(key, strings.NewReader("gpt-image-2-bytes")); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dataDir, "resources", filepath.FromSlash(key))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "gpt-image-2-bytes" {
		t.Fatalf("published body = %q", body)
	}
	temporary, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".beeftv-resource-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(temporary) != 0 {
		t.Fatalf("temporary files remain after Write: %v", temporary)
	}
}
