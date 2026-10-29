package desktopstorage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationCleanupRefusesChangesThenPreservesPointer(t *testing.T) {
	root := filepath.Join(t.TempDir(), "old")
	target := filepath.Join(t.TempDir(), "new")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	sourceFile := filepath.Join(root, "media")
	if err := os.WriteFile(sourceFile, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	files, err := Snapshot(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = CopyClosedWorkspace(context.Background(), root, target); err != nil {
		t.Fatal(err)
	}
	if err = SaveMigration(root, target, root, files); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(sourceFile, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = CleanupPrevious(root, target, Lock); err == nil {
		t.Fatal("deleted changed source")
	}
	if err = os.WriteFile(sourceFile, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = CleanupPrevious(root, target, Lock); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(sourceFile); !os.IsNotExist(err) {
		t.Fatal("old data retained")
	}
	if got, err := Resolve(root); err != nil || got != target {
		t.Fatalf("cleanup deleted pointer: %q %v", got, err)
	}
	if body, err := os.ReadFile(filepath.Join(target, "media")); err != nil || string(body) != "original" {
		t.Fatal("target modified")
	}
}

func TestWorkspaceLockRejectsOtherInstancesAndReleases(t *testing.T) {
	path := t.TempDir()
	first, err := Lock(path)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := Lock(path); err == nil {
		second.Close()
		t.Fatal("second instance acquired workspace")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := Lock(path)
	if err != nil {
		t.Fatal(err)
	}
	next.Close()
}

func TestCrossVolumeMigration(t *testing.T) {
	volume := os.Getenv("BEEFTV_TEST_SECOND_VOLUME")
	if volume == "" {
		t.Skip("native cross-volume fixture not requested")
	}
	root := t.TempDir()
	target, err := os.MkdirTemp(volume, "BeefTV-migration-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(target)
	if err = os.WriteFile(filepath.Join(root, "workspace"), []byte("cross-volume"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = CopyClosedWorkspace(context.Background(), root, target); err != nil {
		t.Fatal(err)
	}
	if err = Save(root, target, root); err != nil {
		t.Fatal(err)
	}
	if got, err := Resolve(root); err != nil || got != target {
		t.Fatalf("restart %q %v", got, err)
	}
	if body, err := os.ReadFile(filepath.Join(target, "workspace")); err != nil || string(body) != "cross-volume" {
		t.Fatal("cross-volume copy lost bytes")
	}
}
