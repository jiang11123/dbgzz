//go:build windows

package workspace

import (
	"context"
	"infinite-canvas/backend/internal/desktopstorage"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestWindowsCrossVolumeSQLiteAndEncryptedConfigSurviveRestart(t *testing.T) {
	volume := os.Getenv("BEEFTV_TEST_SECOND_VOLUME")
	if volume == "" {
		t.Skip("native second volume not requested")
	}
	python, err := exec.LookPath("python")
	if err != nil {
		t.Skip("Python SQLite fixture unavailable")
	}
	source := t.TempDir()
	target, err := os.MkdirTemp(volume, "BeefTV-workspace-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(target)
	code := `import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('create table canvas_projects (id text primary key, title text)'); db.execute("insert into canvas_projects values ('fixture', 'preserved-project')"); db.commit(); db.close()`
	if out, err := exec.Command(python, "-c", code, filepath.Join(source, "open_ai_canvas.db")).CombinedOutput(); err != nil {
		t.Fatalf("fixture failed: %s %v", out, err)
	}
	config, err := NewProviderConfig(source)
	if err != nil {
		t.Fatal(err)
	}
	if err = config.SaveLocalModelConfig([]byte(`{"channels":[{"id":"personal","apiKey":"migration-fixture-secret","enabled":true}]}`)); err != nil {
		t.Fatal(err)
	}
	if err = desktopstorage.CopyClosedWorkspace(context.Background(), source, target); err != nil {
		t.Fatal(err)
	}
	if err = desktopstorage.Save(source, target, source); err != nil {
		t.Fatal(err)
	}
	selected, err := desktopstorage.Resolve(source)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := NewProviderConfig(selected)
	if err != nil {
		t.Fatal(err)
	}
	effective, health, err := reopened.LoadEffectiveModelConfig()
	if err != nil || health != ConfigHealthReady || requireEffectiveChannel(t, effective, "personal")["apiKey"] != "migration-fixture-secret" {
		t.Fatal("Windows encrypted configuration did not survive cross-volume restart")
	}
	code = `import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); assert db.execute('pragma quick_check').fetchone()[0]=='ok'; assert db.execute('select title from canvas_projects where id=?',('fixture',)).fetchone()[0]=='preserved-project'; db.close()`
	if out, err := exec.Command(python, "-c", code, filepath.Join(selected, "open_ai_canvas.db")).CombinedOutput(); err != nil {
		t.Fatalf("migrated SQLite unreadable: %s %v", out, err)
	}
}
