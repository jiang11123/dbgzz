package desktopupdate

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func completedUpdateFixture(t *testing.T) (Target, string, HelperRequest, RecoveryState) {
	t.Helper()
	parent := t.TempDir()
	work, err := os.MkdirTemp(parent, ".beeftv-update-")
	if err != nil {
		t.Fatal(err)
	}
	target := Target{Platform: "darwin-arm64", Path: filepath.Join(parent, appBundleName)}
	if runtime.GOOS == "windows" {
		target = Target{Platform: "windows-amd64", Path: filepath.Join(parent, windowsExeName)}
	}
	req := HelperRequest{Schema: 1, ParentPID: unusedPID(t), Platform: target.Platform, TargetPath: target.Path, StagedPath: filepath.Join(work, "payload"), BackupPath: filepath.Join(work, "backup"), PreparedPath: filepath.Join(work, "prepared"), ResultPath: filepath.Join(work, "result.json")}
	result := RecoveryState{Status: "launched", Phase: "done", BackupPath: req.BackupPath, Launched: true, ParentExited: true}
	writeCleanupJSON(t, filepath.Join(work, "request.json"), req)
	writeCleanupJSON(t, req.ResultPath, result)
	if err := os.MkdirAll(req.BackupPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(req.BackupPath, "old-program"), []byte("recovery"), 0o600); err != nil {
		t.Fatal(err)
	}
	return target, work, req, result
}

func writeCleanupJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestStartupCleansCompletedUpdate(t *testing.T) {
	target, work, _, _ := completedUpdateFixture(t)
	lock := filepath.Join(filepath.Dir(target.Path), ".BeefTV.update.lock")
	if err := os.WriteFile(lock, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	marker := filepath.Join(dataDir, "workspace.db")
	if err := os.WriteFile(marker, []byte("user-data"), 0o600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := cleanupCompletedUpdates(target, dataDir); err != nil {
			t.Fatal(err)
		}
	}
	if pathExists(work) || (runtime.GOOS == "windows" && pathExists(lock)) {
		t.Fatal("successful upgrade left installation debris")
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "user-data" {
		t.Fatal("user data changed", err)
	}
}

func TestStartupPreservesUnconfirmedAndUnownedDirectories(t *testing.T) {
	for _, scenario := range []string{"failed", "rolled_back", "launching", "not_launched", "error", "other_target", "other_platform", "external_backup", "missing_request", "unknown_contents", "embedded_data", "symlink"} {
		t.Run(scenario, func(t *testing.T) {
			target, work, req, result := completedUpdateFixture(t)
			dataDir := ""
			switch scenario {
			case "failed", "rolled_back":
				result.Status = scenario
			case "launching":
				result.Phase = "launch"
			case "not_launched":
				result.Launched = false
			case "error":
				result.Error = "launch failed"
			case "other_target":
				req.TargetPath = filepath.Join(t.TempDir(), appBundleName)
			case "other_platform":
				req.Platform = "other"
			case "external_backup":
				req.BackupPath = t.TempDir()
			case "embedded_data":
				dataDir = filepath.Join(work, "backup", "user-data")
			case "unknown_contents":
				if err := os.WriteFile(filepath.Join(work, "personal-file"), []byte("keep"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			writeCleanupJSON(t, filepath.Join(work, "request.json"), req)
			writeCleanupJSON(t, filepath.Join(work, "result.json"), result)
			if scenario == "missing_request" {
				if err := os.Remove(filepath.Join(work, "request.json")); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "symlink" {
				external := filepath.Join(t.TempDir(), "external")
				if err := os.Rename(work, external); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(external, work); err != nil {
					t.Skipf("symlink unavailable: %v", err)
				}
			}
			if err := cleanupCompletedUpdates(target, dataDir); err != nil {
				t.Fatal(err)
			}
			if !pathExists(filepath.Join(work, "backup", "old-program")) {
				t.Fatal("recovery or unrelated files removed")
			}
		})
	}
}

func TestStartupWaitsForInstallingHelper(t *testing.T) {
	target, work, _, _ := completedUpdateFixture(t)
	unlock, err := lockInstall(filepath.Join(filepath.Dir(target.Path), ".BeefTV.update.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if err := cleanupCompletedUpdates(target, ""); err == nil || !pathExists(work) {
		unlock()
		t.Fatal("cleanup must not overlap an installer")
	}
	e := &Engine{locate: func() (Target, error) { return target, nil }}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- e.CleanupAfterStartup(ctx) }()
	unlock()
	if err := <-done; err != nil || pathExists(work) {
		t.Fatal("startup cleanup did not finish after helper exit", err)
	}
}

func TestInstallLockConcurrentRelease(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".BeefTV.update.lock")
	var active, overlaps, acquired atomic.Int32
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 100 {
				unlock, err := lockInstall(path)
				if err != nil {
					continue
				}
				acquired.Add(1)
				if active.Add(1) != 1 {
					overlaps.Add(1)
				}
				time.Sleep(10 * time.Microsecond)
				active.Add(-1)
				unlock()
			}
		})
	}
	wg.Wait()
	if acquired.Load() == 0 || overlaps.Load() != 0 || (runtime.GOOS == "windows" && pathExists(path)) {
		t.Fatalf("acquired=%d overlaps=%d lock remains=%v", acquired.Load(), overlaps.Load(), pathExists(path))
	}
}
