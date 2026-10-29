package desktopupdate

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	// A copied test executable is a real PE launch target for the Windows
	// replacement test, without recursively running this test suite.
	if os.Getenv("BEEFTV_UPDATER_TEST_LAUNCH") == "1" && len(os.Args) == 1 {
		os.Exit(0)
	}
	if done, err := HandleHelperCommand(os.Args); done {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestHandleHelperCommandIgnoresNormalArgs(t *testing.T) {
	done, err := HandleHelperCommand([]string{"BeefTV"})
	if done || err != nil {
		t.Fatalf("done=%v err=%v", done, err)
	}
}

func TestHandleHelperCommandRequiresRequestPath(t *testing.T) {
	done, err := HandleHelperCommand([]string{"BeefTV", helperFlag})
	if !done || err == nil {
		t.Fatalf("done=%v err=%v", done, err)
	}
}

func TestSpawnedHelperReplacesInstall(t *testing.T) {
	root := t.TempDir()
	oldDir := filepath.Join(root, "old")
	if err := WriteDarwinLayout(oldDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	work, err := os.MkdirTemp(oldDir, ".beeftv-update-")
	if err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(work, "payload")
	if err := WriteDarwinLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Schema:         1,
		ParentPID:      unusedPID(t),
		Platform:       "darwin-arm64",
		TargetPath:     filepath.Join(oldDir, appBundleName),
		StagedPath:     staged,
		BackupPath:     filepath.Join(work, "backup"),
		PreparedPath:   filepath.Join(work, "prepared"),
		ResultPath:     filepath.Join(work, "result.json"),
		WaitTimeoutSec: 5,
	}
	if runtime.GOOS == "windows" {
		if err := WriteWindowsLayout(oldDir, "OLD"); err != nil {
			t.Fatal(err)
		}
		// Remove the Darwin fixture before validating the Windows archive layout.
		if err := os.RemoveAll(filepath.Join(staged, appBundleName)); err != nil {
			t.Fatal(err)
		}
		if err := WriteWindowsLayout(staged, "NEW"); err != nil {
			t.Fatal(err)
		}
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(filepath.Join(staged, windowsExeName)); err != nil {
			t.Fatal(err)
		}
		if err := copyFile(exe, filepath.Join(staged, windowsExeName)); err != nil {
			t.Fatal(err)
		}
		req.Platform = "windows-amd64"
		req.TargetPath = filepath.Join(oldDir, windowsExeName)
		t.Setenv("BEEFTV_UPDATER_TEST_LAUNCH", "1")
	}
	encoded, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(work, "request.json")
	if err := os.WriteFile(requestPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	helperPath := filepath.Join(work, "BeefTV-update-helper")
	if runtime.GOOS == "windows" {
		helperPath += ".exe"
	}
	if err := copyFile(exe, helperPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(helperPath, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(helperPath, helperFlag, requestPath)
	cmd.Dir = work
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helper: %v\n%s", err, out)
	}
	installed := filepath.Join(req.TargetPath, "Contents", "MacOS", "BeefTV")
	if runtime.GOOS == "windows" {
		installed = filepath.Join(oldDir, pluginDirName, "official.beeftv-plugin")
	}
	got, err := os.ReadFile(installed)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "NEW") {
		t.Fatalf("installed = %q helper=%s", got, out)
	}
	if !pathExists(req.BackupPath) {
		t.Fatal("process launch alone discarded the recovery copy")
	}
	if err := cleanupCompletedUpdates(Target{Path: req.TargetPath, Platform: req.Platform}, ""); err != nil {
		t.Fatal(err)
	}
	if pathExists(work) || (runtime.GOOS == "windows" && pathExists(filepath.Join(oldDir, ".BeefTV.update.lock"))) {
		t.Fatal("confirmed startup retained update files")
	}
}

func unusedPID(t *testing.T) int {
	t.Helper()
	return 987654321
}
