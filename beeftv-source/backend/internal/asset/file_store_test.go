package asset

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type failingReader struct {
	content string
	read    bool
}

func (r *failingReader) Read(buffer []byte) (int, error) {
	if r.read {
		return 0, errors.New("injected read failure")
	}
	r.read = true
	return copy(buffer, r.content), nil
}

func TestFileStoreWriteIsAtomicWhenReaderFails(t *testing.T) {
	dataDir := t.TempDir()
	store := NewFileStore(dataDir)
	const key = "workspaces/local/image/original.png"
	if err := store.Write(key, strings.NewReader("original")); err != nil {
		t.Fatal(err)
	}

	if err := store.Write(key, &failingReader{content: "partial"}); err == nil {
		t.Fatal("Write() error = nil for failing reader")
	}
	body, err := os.ReadFile(filepath.Join(dataDir, "resources", filepath.FromSlash(key)))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "original" {
		t.Fatalf("stored body = %q, want original", body)
	}
	temporary, err := filepath.Glob(filepath.Join(dataDir, "resources", "workspaces", "local", "image", ".beeftv-resource-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(temporary) != 0 {
		t.Fatalf("temporary files after failed write = %v", temporary)
	}
}

func TestFileStoreRejectsTraversalAndSupportsOpenDelete(t *testing.T) {
	store := NewFileStore(t.TempDir())
	for _, key := range []string{"", "../escape", "/absolute"} {
		if _, err := store.path(key); err == nil {
			t.Fatalf("path(%q) accepted invalid key", key)
		}
		if err := store.Write(key, strings.NewReader("x")); err == nil {
			t.Fatalf("Write(%q) accepted invalid key", key)
		}
	}

	const key = "workspaces/local/video/result.mp4"
	if err := store.Write(key, strings.NewReader("video")); err != nil {
		t.Fatal(err)
	}
	file, err := store.Open(key)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(file)
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("read/close: %v / %v", err, closeErr)
	}
	if string(body) != "video" {
		t.Fatalf("Open() body = %q", body)
	}
	if err := store.Delete(key); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Open(key); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Open() after Delete error = %v, want not-exist", err)
	}
}

func TestFileStoreAliasesShareWriteSpace(t *testing.T) {
	dataDir := t.TempDir()
	trailing := dataDir + string(filepath.Separator)
	alias := filepath.Join(t.TempDir(), "alias-root")
	if err := os.Symlink(dataDir, alias); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	first := NewFileStore(dataDir)
	second := NewFileStore(trailing)
	third := NewFileStore(alias)
	if first.writeSpace() == "" {
		t.Fatal("canonical write space is empty")
	}
	if first.writeSpace() != second.writeSpace() || first.writeSpace() != third.writeSpace() {
		t.Fatalf("writeSpace dataDir=%q trailing=%q alias=%q", first.writeSpace(), second.writeSpace(), third.writeSpace())
	}
}

func TestFileStoreRejectsSymlinkEscape(t *testing.T) {
	dataDir := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	resourceRoot := filepath.Join(dataDir, "resources")
	if err := os.MkdirAll(resourceRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(resourceRoot, "escape")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	store := NewFileStore(dataDir)
	if _, err := store.Open("escape/secret"); err == nil {
		t.Fatal("Open() followed a symlink outside the resource root")
	}
	if err := store.Write("escape/new", strings.NewReader("leak")); err == nil {
		t.Fatal("Write() followed a symlink outside the resource root")
	}
	if err := store.Delete("escape/secret"); err == nil {
		t.Fatal("Delete() followed a symlink outside the resource root")
	}
	body, err := os.ReadFile(filepath.Join(outside, "secret"))
	if err != nil || string(body) != "keep" {
		t.Fatalf("outside file changed: %q, %v", body, err)
	}
}

func TestFileStoreDeleteRejectsDirectory(t *testing.T) {
	dataDir := t.TempDir()
	directory := filepath.Join(dataDir, "resources", "workspaces", "local", "folder")
	if err := os.MkdirAll(directory, 0o750); err != nil {
		t.Fatal(err)
	}
	store := NewFileStore(dataDir)
	if err := store.Delete("workspaces/local/folder"); err == nil {
		t.Fatal("Delete() removed a directory")
	}
	if info, err := os.Stat(directory); err != nil || !info.IsDir() {
		t.Fatalf("directory missing after rejected delete: %v", err)
	}
}
