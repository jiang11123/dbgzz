package desktopstorage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationCopiesAndVerifiesCompleteWorkspaceAndKeepsSource(t *testing.T) {
	source := filepath.Join(t.TempDir(), "old")
	target := filepath.Join(t.TempDir(), "new")
	for name, value := range map[string]string{"open_ai_canvas.db": "sqlite-fixture", "open_ai_canvas.db-wal": "latest-write", "resources/video.mp4": "media", "local-model-config.json": "encrypted-config", ".settings-key": "test-key", "local-model-config.json.bak": "backup"} {
		path := filepath.Join(source, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := CopyClosedWorkspace(context.Background(), source, target); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"open_ai_canvas.db", "open_ai_canvas.db-wal", "resources/video.mp4", "local-model-config.json", ".settings-key", "local-model-config.json.bak"} {
		before, err := os.ReadFile(filepath.Join(source, name))
		if err != nil {
			t.Fatal(err)
		}
		after, err := os.ReadFile(filepath.Join(target, name))
		if err != nil || string(before) != string(after) {
			t.Fatalf("did not preserve %s", name)
		}
	}
	root := t.TempDir()
	if err := Save(root, target, source); err != nil {
		t.Fatal(err)
	}
	if got, err := Resolve(root); err != nil || got != target {
		t.Fatalf("restart selected %q: %v", got, err)
	}
	if err := os.Rename(target, target+"-disconnected"); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(root); err == nil {
		t.Fatal("missing selected volume silently became a fresh workspace")
	}
}

func TestMigrationRejectsOverlapExistingDataAndCancellation(t *testing.T) {
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "config"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{source, filepath.Join(source, "child"), filepath.Dir(source)} {
		if _, err := Validate(source, target); err == nil {
			t.Fatalf("accepted overlap %s", target)
		}
	}
	target := t.TempDir()
	if err := os.WriteFile(filepath.Join(target, "foreign"), []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := CopyClosedWorkspace(context.Background(), source, target); err == nil {
		t.Fatal("overwrote occupied target")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	emptyTarget := filepath.Join(t.TempDir(), "cancelled")
	if err := CopyClosedWorkspace(ctx, source, emptyTarget); err == nil {
		t.Fatal("ignored cancellation")
	}
	body, err := os.ReadFile(filepath.Join(source, "config"))
	if err != nil || string(body) != "keep" {
		t.Fatal("source modified on failure")
	}
}
