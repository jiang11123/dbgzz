package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSyncDirectoryReportsMissingPath(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing-plugin-dir")
	err := syncDirectory(missing)
	if err == nil {
		t.Fatal("syncDirectory() error = nil for a missing path")
	}
	if !os.IsNotExist(err) && !strings.Contains(strings.ToLower(err.Error()), "cannot find") && !strings.Contains(strings.ToLower(err.Error()), "no such file") {
		t.Fatalf("syncDirectory() error = %v, want a missing-path error", err)
	}
}

func TestWritePluginFileSyncsNameAndLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "named.beeftv-plugin")
	if err := writePluginFile(path, []byte("plugin-bytes")); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "plugin-bytes" {
		t.Fatalf("published body = %q", got)
	}
	temporary, err := filepath.Glob(filepath.Join(dir, ".plugin-*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(temporary) != 0 {
		t.Fatalf("temporary files remain after writePluginFile: %v", temporary)
	}
}

func TestEnsurePluginBlobReusesMatchingBytes(t *testing.T) {
	dir := t.TempDir()
	data := []byte("immutable-plugin")
	path := filepath.Join(dir, blobFileName(pluginHash(data)))
	created, err := ensurePluginBlob(path, data)
	if err != nil || !created {
		t.Fatalf("first blob created=%v err=%v", created, err)
	}
	stale := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(path, stale, stale); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	created, err = ensurePluginBlob(path, data)
	if err != nil || created {
		t.Fatalf("reuse created=%v err=%v", created, err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("matching blob was rewritten")
	}
}

func TestEnsurePluginBlobRejectsHashMismatchWithoutRewrite(t *testing.T) {
	dir := t.TempDir()
	data := []byte("immutable-plugin")
	path := filepath.Join(dir, blobFileName(pluginHash(data)))
	garbage := []byte("other-bytes")
	if err := os.WriteFile(path, garbage, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ensurePluginBlob(path, data); err == nil || !strings.Contains(err.Error(), "内容与哈希不一致") {
		t.Fatalf("mismatch error = %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(garbage) {
		t.Fatal("mismatched blob was rewritten")
	}
}
