//go:build windows

package desktopstorage

import (
	"context"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func denySharing(t *testing.T, path string) func() {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	release := func() {
		if !closed {
			if err := windows.CloseHandle(handle); err != nil {
				t.Fatal(err)
			}
			closed = true
		}
	}
	t.Cleanup(release)
	return release
}

func TestWindowsLockedScratchMigrationAndCleanupRetry(t *testing.T) {
	source, target := scratchFixture(t)
	release := denySharing(t, filepath.Join(source, "cache/tmp/busy.tmp"))
	files, err := Snapshot(source)
	if err != nil {
		t.Fatal(err)
	}
	if err = CopyClosedWorkspace(context.Background(), source, target); err != nil {
		t.Fatal(err)
	}
	if err = VerifySnapshot(target, files, false); err != nil {
		t.Fatal(err)
	}
	if err = SaveMigration(source, target, source, files); err != nil {
		t.Fatal(err)
	}
	if err = CleanupPrevious(source, target, Lock); err == nil {
		t.Fatal("reported full cleanup with locked scratch")
	}
	if !fileInUse(err) || !strings.Contains(err.Error(), "请重启 BeefTV") {
		t.Fatal("lost lock cause or recovery advice", err)
	}
	if err = VerifySnapshot(source, files, false); err != nil {
		t.Fatal("removed durable copies before scratch was released", err)
	}
	// Receipts created by older versions also listed temporary files.
	legacyFiles := make(map[string]string, len(files)+1)
	for path, hash := range files {
		legacyFiles[path] = hash
	}
	legacyFiles[filepath.Join("cache", "tmp", "busy.tmp")] = "old-scratch-hash"
	if err = SaveMigration(source, target, source, legacyFiles); err != nil {
		t.Fatal(err)
	}
	if err = CleanupPrevious(source, target, Lock); !fileInUse(err) || !strings.Contains(err.Error(), "请重启 BeefTV") {
		t.Fatal("old receipt bypassed scratch handling", err)
	}
	if err = VerifySnapshot(source, files, false); err != nil {
		t.Fatal("old receipt lost durable data", err)
	}
	location, err := MigrationLocation(source, target)
	if err != nil || location.PreviousDir == "" {
		t.Fatal("lost cleanup receipt", err)
	}
	release()
	if err = CleanupPrevious(source, target, Lock); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(source, "cache/tmp")); !os.IsNotExist(err) {
		t.Fatal("scratch retained after retry")
	}
	if err = VerifySnapshot(target, files, false); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsLockedDurableFileStopsMigration(t *testing.T) {
	source, target := scratchFixture(t)
	path := filepath.Join(source, "resources/original.tmp")
	release := denySharing(t, path)
	if _, err := Snapshot(source); err == nil {
		t.Fatal("snapshot ignored locked durable file")
	}
	if err := CopyClosedWorkspace(context.Background(), source, target); err == nil {
		t.Fatal("copy ignored locked durable file")
	}
	release()
	if body, err := os.ReadFile(path); err != nil || string(body) != "resources/original.tmp" {
		t.Fatal("source lost", err)
	}
	entries, err := os.ReadDir(target)
	if err != nil || len(entries) != 0 {
		t.Fatal("published incomplete target", err)
	}
}
