package desktopstorage

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationProgressCountsCopiedBytesAndVerifiedFiles(t *testing.T) {
	source, target := t.TempDir(), filepath.Join(t.TempDir(), "moved")
	data := bytes.Repeat([]byte("original"), 200000)
	if err := os.WriteFile(filepath.Join(source, "media.bin"), data, 0600); err != nil {
		t.Fatal(err)
	}
	var last Progress
	var sawCopy, sawVerify bool
	err := CopyClosedWorkspace(context.Background(), source, target, func(progress Progress) {
		if progress.LoadedBytes > progress.TotalBytes {
			t.Fatal("copied bytes exceed total")
		}
		sawCopy = sawCopy || progress.Phase == "transferring" && progress.LoadedBytes > 0
		sawVerify = sawVerify || progress.Phase == "processing"
		last = progress
	})
	if err != nil {
		t.Fatal(err)
	}
	if !sawCopy || !sawVerify || last.LoadedBytes != int64(len(data)) || last.CompletedFiles != 1 || last.TotalFiles != 1 {
		t.Fatalf("incomplete observations: %+v", last)
	}
	restored, err := os.ReadFile(filepath.Join(target, "media.bin"))
	if err != nil || !bytes.Equal(restored, data) {
		t.Fatal("migrated data changed")
	}
	if _, err := os.Stat(filepath.Join(source, "media.bin")); err != nil {
		t.Fatal("source was removed")
	}
}
