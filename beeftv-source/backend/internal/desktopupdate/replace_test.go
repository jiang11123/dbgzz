package desktopupdate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSwapInstallRollbackWhenStagedMissing(t *testing.T) {
	root := t.TempDir()
	oldDir := filepath.Join(root, "old")
	staged := filepath.Join(root, "staged")
	if err := WriteDarwinLayout(oldDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteDarwinLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(oldDir, appBundleName)
	if err := os.RemoveAll(filepath.Join(staged, appBundleName)); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Schema:     1,
		ParentPID:  unusedPID(t),
		Platform:   "darwin-arm64",
		TargetPath: target,
		StagedPath: staged,
		BackupPath: filepath.Join(root, "backup", appBundleName),
	}
	if err := SwapInstall(req); err == nil {
		t.Fatal("expected swap failure")
	}
	got, err := os.ReadFile(filepath.Join(target, "Contents", "MacOS", "BeefTV"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "OLD") {
		t.Fatalf("rolled back content = %q", got)
	}
}

func TestLaunchFailureRestoresPreviousInstall(t *testing.T) {
	root := t.TempDir()
	oldDir := filepath.Join(root, "old")
	staged := filepath.Join(root, "staged")
	if err := WriteDarwinLayout(oldDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteDarwinLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Schema:       1,
		ParentPID:    unusedPID(t),
		Platform:     "darwin-arm64",
		TargetPath:   filepath.Join(oldDir, appBundleName),
		StagedPath:   staged,
		BackupPath:   filepath.Join(root, "backup", appBundleName),
		PreparedPath: filepath.Join(root, "prepared"),
		ResultPath:   filepath.Join(root, "result.json"),
	}
	relaunchInstall = func(HelperRequest) error { return errors.New("launch failed") }
	t.Cleanup(func() { relaunchInstall = relaunchTarget })
	if err := RunHelperRequest(req); err == nil {
		t.Fatal("expected launch failure")
	}
	got, err := os.ReadFile(filepath.Join(req.TargetPath, "Contents", "MacOS", "BeefTV"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "OLD") {
		t.Fatalf("restored = %q", got)
	}
	result, err := os.ReadFile(req.ResultPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(result), `"restored":true`) || !strings.Contains(string(result), "rolled_back") {
		t.Fatalf("recovery = %s", result)
	}
}

func TestWindowsSwapPreservesNeighborFilesAndUserPlugins(t *testing.T) {
	root := t.TempDir()
	targetDir := filepath.Join(root, "Beef TV 安装 测试")
	staged := filepath.Join(root, "staged")
	if err := WriteWindowsLayout(targetDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	neighbor := filepath.Join(targetDir, "notes.txt")
	if err := os.WriteFile(neighbor, []byte("keep-me"), 0o644); err != nil {
		t.Fatal(err)
	}
	userData := filepath.Join(root, "AppData", "BeefTV", "plugin-packages")
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}
	custom := filepath.Join(userData, "custom.beeftv-plugin")
	if err := os.WriteFile(custom, []byte("uploaded"), 0o600); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Platform:   "windows-amd64",
		TargetPath: filepath.Join(targetDir, windowsExeName),
		StagedPath: staged,
		BackupPath: filepath.Join(root, "backup"),
	}
	if err := SwapInstall(req); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(targetDir, windowsExeName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "NEW") {
		t.Fatalf("exe = %q", got)
	}
	plugin, err := os.ReadFile(filepath.Join(targetDir, pluginDirName, "official.beeftv-plugin"))
	if err != nil || !strings.Contains(string(plugin), "NEW") {
		t.Fatalf("plugin = %q err=%v", plugin, err)
	}
	kept, err := os.ReadFile(neighbor)
	if err != nil || string(kept) != "keep-me" {
		t.Fatalf("neighbor = %q err=%v", kept, err)
	}
	uploaded, err := os.ReadFile(custom)
	if err != nil || string(uploaded) != "uploaded" {
		t.Fatalf("user plugin = %q err=%v", uploaded, err)
	}
}

func TestWindowsAgentHostSwapAndRollback(t *testing.T) {
	for _, oldHasHost := range []bool{false, true} {
		t.Run(fmt.Sprint(oldHasHost), func(t *testing.T) {
			root := t.TempDir()
			target, staged := filepath.Join(root, "old with spaces"), filepath.Join(root, "staged")
			if err := WriteWindowsLayout(target, "OLD"); err != nil {
				t.Fatal(err)
			}
			if !oldHasHost {
				if err := os.RemoveAll(filepath.Join(target, "agent-host")); err != nil {
					t.Fatal(err)
				}
			}
			if err := WriteWindowsLayout(staged, "NEW"); err != nil {
				t.Fatal(err)
			}
			req := HelperRequest{Platform: "windows-amd64", TargetPath: filepath.Join(target, windowsExeName), StagedPath: staged, BackupPath: filepath.Join(root, "backup")}
			if err := SwapInstall(req); err != nil {
				t.Fatal(err)
			}
			node := filepath.Join(target, "agent-host", "runtime", "node.exe")
			if got, err := os.ReadFile(node); err != nil || string(got) != "NEW" {
				t.Fatalf("host not replaced: %q %v", got, err)
			}
			if err := RestoreBackup(req); err != nil {
				t.Fatal(err)
			}
			if err := RestoreBackup(req); err != nil {
				t.Fatal(err)
			}
			if oldHasHost {
				if got, err := os.ReadFile(node); err != nil || string(got) != "OLD" {
					t.Fatalf("host not restored: %q %v", got, err)
				}
			} else if pathExists(filepath.Join(target, "agent-host")) {
				t.Fatal("new host survived rollback to pre-agent install")
			}
		})
	}
}

func TestWindowsMissingAgentRuntimeDoesNotTouchInstall(t *testing.T) {
	root := t.TempDir()
	target, staged := filepath.Join(root, "old"), filepath.Join(root, "new")
	if err := WriteWindowsLayout(target, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(staged, "agent-host", "runtime", "node.exe")); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{Platform: "windows-amd64", TargetPath: filepath.Join(target, windowsExeName), StagedPath: staged, BackupPath: filepath.Join(root, "backup")}
	if err := SwapInstall(req); err == nil {
		t.Fatal("missing host accepted")
	}
	if got, err := os.ReadFile(req.TargetPath); err != nil || string(got) != "MZ-OLD" {
		t.Fatalf("old exe changed: %q %v", got, err)
	}
}

func TestWindowsRestoreRetriesPluginsAfterExecutableWasRestored(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "installed")
	backup := filepath.Join(root, "backup")
	if err := WriteWindowsLayout(target, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(backup, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(backup, windowsExeName)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, pluginDirName, "official.beeftv-plugin"), []byte("NEW"), 0o644); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{Platform: "windows-amd64", TargetPath: filepath.Join(target, windowsExeName), BackupPath: backup}
	if err := RestoreBackup(req); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(target, pluginDirName, "official.beeftv-plugin"))
	if err != nil || string(got) != "official-OLD" {
		t.Fatalf("plugin not restored: %q, %v", got, err)
	}
}

func TestUnicodeAndSpacesPathsRoundTrip(t *testing.T) {
	root := filepath.Join(t.TempDir(), "BeefTV 更新 测试")
	oldDir := filepath.Join(root, "current")
	staged := filepath.Join(root, "staged")
	if err := WriteDarwinLayout(oldDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteDarwinLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Platform:   "darwin-arm64",
		TargetPath: filepath.Join(oldDir, appBundleName),
		StagedPath: staged,
		BackupPath: filepath.Join(root, "backup", appBundleName),
	}
	if err := SwapInstall(req); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(req.TargetPath, "Contents", "MacOS", "BeefTV"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "NEW") {
		t.Fatalf("installed = %q", got)
	}
}
