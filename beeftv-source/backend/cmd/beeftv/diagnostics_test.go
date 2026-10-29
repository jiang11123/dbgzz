package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

func TestOfflineDiagnosticsNeedsNoRuntimeOrCredentials(t *testing.T) {
	t.Setenv("BEEFTV_BASE_URL", "invalid-offline-url")
	t.Setenv("BEEFTV_OWNER_TOKEN", "")
	t.Setenv("BEEFTV_DESKTOP_TOKEN", "")
	t.Setenv("BEEFTV_DATA_DIR", t.TempDir())
	file := filepath.Join(t.TempDir(), "diagnostics.zip")
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	w := zip.NewWriter(f)
	manifest, _ := w.Create("manifest.json")
	_, _ = manifest.Write([]byte(`{"schemaVersion":3,"collectors":{}}`))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"diagnostics", "analyze", "--file", file}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"diagnostics", "analyze", "--file", file}); err == nil {
		t.Fatal("invalid ZIP accepted")
	}
}
