package desktopstorage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func scratchFixture(t *testing.T) (string, string) {
	t.Helper()
	source := t.TempDir()
	for _, name := range []string{"cache/tmp/busy.tmp", "cache/models/model.bin", "resources/original.tmp"} {
		path := filepath.Join(source, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return source, filepath.Join(t.TempDir(), "target")
}

func TestMigrationExcludesOnlyOwnedScratch(t *testing.T) {
	source, target := scratchFixture(t)
	files, err := Snapshot(source)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("unexpected migration files: %v", files)
	}
	usage, err := inspect(source, true)
	if err != nil {
		t.Fatal(err)
	}
	all, err := Inspect(source)
	if err != nil {
		t.Fatal(err)
	}
	if all.UsedBytes-usage.UsedBytes != int64(len("cache/tmp/busy.tmp")) {
		t.Fatal("scratch counted toward migration space")
	}
	if err = CopyClosedWorkspace(context.Background(), source, target); err != nil {
		t.Fatal(err)
	}
	if err = VerifySnapshot(target, files, false); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(target, "cache/tmp")); !os.IsNotExist(err) {
		t.Fatal("scratch copied")
	}
	if err = os.WriteFile(filepath.Join(source, "cache/tmp/new.tmp"), []byte("new scratch"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = VerifySnapshot(source, files, false); err != nil {
		t.Fatal(err)
	}
	if err = SaveMigration(source, target, source, files); err != nil {
		t.Fatal(err)
	}
	if err = CleanupPrevious(source, target, Lock); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(source, "cache/tmp")); !os.IsNotExist(err) {
		t.Fatal("scratch not cleaned")
	}
	if err = VerifySnapshot(target, files, false); err != nil {
		t.Fatal(err)
	}
}
