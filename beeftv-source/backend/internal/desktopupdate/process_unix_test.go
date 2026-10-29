//go:build unix

package desktopupdate

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestInstallLockPreservesPendingLegacyHelper(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".BeefTV.update.lock")
	legacy, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Close()
	// The old helper has opened the file but has not yet called flock.
	unlock, err := lockInstall(path)
	if err != nil {
		t.Fatal(err)
	}
	unlock()
	if err := syscall.Flock(int(legacy.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(legacy.Fd()), syscall.LOCK_UN)
	if unlock, err := lockInstall(path); err == nil {
		unlock()
		t.Fatal("new helper overlapped a pending legacy helper")
	}
}
