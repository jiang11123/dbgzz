//go:build !windows

package desktopstorage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScratchPermissionFailurePreservesCauseAndDurableCopies(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	source, target := scratchFixture(t)
	files, err := Snapshot(source)
	if err != nil {
		t.Fatal(err)
	}
	if err = CopyClosedWorkspace(context.Background(), source, target); err != nil {
		t.Fatal(err)
	}
	if err = SaveMigration(source, target, source, files); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(source, "cache")
	if err = os.Chmod(cache, 0500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(cache, 0700)
	err = CleanupPrevious(source, target, Lock)
	if !errors.Is(err, os.ErrPermission) || strings.Contains(err.Error(), "仍在使用中") {
		t.Fatalf("permission failure misclassified: %v", err)
	}
	if err = VerifySnapshot(source, files, false); err != nil {
		t.Fatal("durable copies removed", err)
	}
	location, err := MigrationLocation(source, target)
	if err != nil || location.PreviousDir == "" {
		t.Fatal("cleanup receipt lost", err)
	}
}
