package desktopupdate

import (
	"os"
	"path/filepath"
	"runtime"
)

// The DEB owns its executable tree. It must never be replaced by the ZIP updater.
func packageManagedExecutable() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	return isPackageManaged(exe)
}

func isPackageManaged(exe string) bool {
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	marker, err := os.ReadFile(filepath.Join(filepath.Dir(exe), ".package-managed"))
	return err == nil && string(marker) == "deb\n"
}
