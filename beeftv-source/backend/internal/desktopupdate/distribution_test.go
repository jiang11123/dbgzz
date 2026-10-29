package desktopupdate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPackageManagedBlocksAllUpdaterActions(t *testing.T) {
	e := NewWithOptions(Options{PackageManaged: true, CurrentVersion: "v1.7.15", FeedURL: "https://example.com/feed", PublicKey: "invalid"})
	if s := e.Status(); s.Status != StatusDisabled || s.Error != "请下载新版 DEB 安装包更新。" {
		t.Fatalf("package update instruction missing: %+v", s)
	}
	if _, err := e.CheckForUpdate(context.Background()); !errors.Is(err, ErrDisabled) {
		t.Fatalf("check was allowed: %v", err)
	}
	if _, err := e.DownloadUpdate(context.Background()); !errors.Is(err, ErrDisabled) {
		t.Fatalf("download was allowed: %v", err)
	}
	if err := e.InstallUpdate(context.Background()); !errors.Is(err, ErrDisabled) {
		t.Fatalf("install was allowed: %v", err)
	}
}

func TestPackageMarkerDoesNotDisablePortableBundle(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "BeefTV")
	if isPackageManaged(exe) {
		t.Fatal("portable updater disabled")
	}
	if err := os.WriteFile(filepath.Join(dir, ".package-managed"), []byte("deb\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if !isPackageManaged(exe) {
		t.Fatal("DEB marker not recognized")
	}
}
