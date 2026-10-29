package environment

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func checkByID(t *testing.T, report Report, id string) Check {
	t.Helper()
	for _, c := range report.Checks {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("missing check %s", id)
	return Check{}
}

func TestRepairIsBoundedAndIdempotent(t *testing.T) {
	dir := t.TempDir()
	project := filepath.Join(dir, "project.db")
	if err := os.WriteFile(project, []byte("original project bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	readOnly := Inspect(context.Background(), dir, false)
	if checkByID(t, readOnly, "directory-tmp").Status != "warning" {
		t.Fatal(readOnly)
	}
	if _, err := os.Stat(filepath.Join(dir, "tmp")); !os.IsNotExist(err) {
		t.Fatal("read-only inspection created tmp")
	}
	first := Inspect(context.Background(), dir, true)
	for _, id := range []string{"directory-tmp", "directory-downloads"} {
		if checkByID(t, first, id).Status != "repaired" {
			t.Fatal(first)
		}
		if checkByID(t, Inspect(context.Background(), dir, true), id).Status != "pass" {
			t.Fatal("repair is not idempotent")
		}
	}
	if data, _ := os.ReadFile(project); string(data) != "original project bytes" {
		t.Fatal("project changed")
	}
	files, _ := filepath.Glob(filepath.Join(dir, ".beeftv-environment-*"))
	if len(files) != 0 {
		t.Fatal("write probe leaked files")
	}
	data, _ := json.Marshal(first)
	if strings.Contains(string(data), dir) {
		t.Fatal("report leaked machine path")
	}
}

func TestRepairPreservesUnexpectedFilesAndSymlinks(t *testing.T) {
	dir, external := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tmp"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(dir, "downloads")); err != nil {
		t.Skip("symlinks unavailable", err)
	}
	report := Inspect(context.Background(), dir, true)
	for _, id := range []string{"directory-tmp", "directory-downloads"} {
		if checkByID(t, report, id).Status != "error" {
			t.Fatal(report)
		}
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "tmp")); string(data) != "keep" {
		t.Fatal("unexpected file replaced")
	}
	if files, _ := os.ReadDir(external); len(files) != 0 {
		t.Fatal("repair escaped workspace")
	}
}

func TestMissingRootDoesNotCreateEmptyWorkspace(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "unmounted")
	r := Inspect(context.Background(), dir, true)
	if checkByID(t, r, "workspace").Status != "error" {
		t.Fatal(r)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("created a replacement data directory")
	}
	if checkByID(t, Inspect(context.Background(), "", true), "workspace").Status != "skipped" {
		t.Fatal("hosted mode must not touch host data")
	}
}

func TestCancelledInspectionAndWritersDoNotMutateWorkspace(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := Inspect(ctx, dir, true)
	if checkByID(t, r, "check-cancelled").Status != "unknown" {
		t.Fatal(r)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := probeWrite(ctx, root); err != context.Canceled {
		t.Fatal(err)
	}
	if status, _ := scratchDirectory(ctx, root, "tmp", true); status != "unknown" {
		t.Fatal(status)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatal("cancelled writers changed workspace")
	}
}

func TestIncompleteOptionalModelIsReportedWithoutDeletingIt(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "models/video-depth-anything-small/v1/checkpoints/video_depth_anything_vits.pth")
	if err := os.MkdirAll(filepath.Dir(file), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := Inspect(context.Background(), dir, true)
	if checkByID(t, r, "depth-model").Status != "warning" {
		t.Fatal(r)
	}
	if data, _ := os.ReadFile(file); string(data) != "partial" {
		t.Fatal("model was changed")
	}
}

func TestEveryNativeCaseReferenceIsPinnedAndConfirmed(t *testing.T) {
	r := Inspect(context.Background(), t.TempDir(), false)
	if len(r.Catalog.Revision) != 40 || len(r.Catalog.Cases) != 13 {
		t.Fatal("missing reviewed snapshot")
	}
	ids := map[string]bool{}
	for _, c := range r.Catalog.Cases {
		if c.Status != "confirmed" || c.Title == "" || ids[c.ID] {
			t.Fatal("unreviewed or duplicate case", c.ID)
		}
		ids[c.ID] = true
	}
	for _, c := range r.Checks {
		for _, id := range c.Cases {
			if !ids[id] {
				t.Fatal("unbound case", id)
			}
		}
	}
}
