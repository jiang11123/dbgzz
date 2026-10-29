//go:build windows

package desktopupdate

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestCleanupWindowsRetriesBusyHelper(t *testing.T) {
	target, work, _, _ := completedUpdateFixture(t)
	helper := filepath.Join(work, "BeefTV-update-helper.exe")
	file, err := os.OpenFile(helper, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := cleanupCompletedUpdates(target, ""); err == nil {
		t.Fatal("removed helper while its executable handle was open")
	}
	for _, name := range []string{"request.json", "result.json", "backup/old-program"} {
		if !pathExists(filepath.Join(work, filepath.FromSlash(name))) {
			t.Fatalf("lost retry state %s", name)
		}
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := cleanupCompletedUpdates(target, ""); err != nil || pathExists(work) {
		t.Fatal("cleanup did not recover after helper closed", err)
	}
}

func TestWindowsInstallLockExcludesLegacyHelper(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".BeefTV.update.lock")
	legacy, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Close()
	var overlapped windows.Overlapped
	if err := windows.LockFileEx(windows.Handle(legacy.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped); err != nil {
		t.Fatal(err)
	}
	if unlock, err := lockInstall(path); err == nil {
		unlock()
		t.Fatal("new helper overlapped legacy helper")
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	unlock, err := lockInstall(path)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600); err == nil {
		file.Close()
		t.Fatal("legacy helper opened a lock held by new helper")
	}
}
