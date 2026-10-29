package desktopupdate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStagingNeverDeletesAnotherDownload(t *testing.T) {
	e := &Engine{stagingRoot: t.TempDir()}
	first, err := e.prepareStaging("v1.5.2")
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(first, "keep")
	if err := os.WriteFile(marker, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	second, err := e.prepareStaging("v1.5.2")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("staging directory reused")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("other download removed", err)
	}
}

func TestInstallLockExcludesConcurrentHelperAndReleases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock")
	release, err := lockInstall(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := lockInstall(path)
	if err == nil {
		second()
		release()
		t.Fatal("concurrent lock acquired")
	}
	release()
	third, err := lockInstall(path)
	if err != nil {
		t.Fatal(err)
	}
	third()
}

func TestSuccessfulLaunchRetainsOldProgramForRecovery(t *testing.T) {
	root := t.TempDir()
	old, stage := filepath.Join(root, "old"), filepath.Join(root, "stage")
	if err := WriteDarwinLayout(old, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteDarwinLayout(stage, "NEW"); err != nil {
		t.Fatal(err)
	}
	original := relaunchInstall
	relaunchInstall = func(HelperRequest) error { return nil }
	defer func() { relaunchInstall = original }()
	req := HelperRequest{Schema: 1, ParentPID: unusedPID(t), Platform: "darwin-arm64", TargetPath: filepath.Join(old, appBundleName), StagedPath: stage, BackupPath: filepath.Join(root, "backup")}
	if err := RunHelperRequest(req); err != nil {
		t.Fatal(err)
	}
	kept, err := os.ReadFile(filepath.Join(req.BackupPath, "Contents", "MacOS", "BeefTV"))
	if err != nil || !strings.Contains(string(kept), "OLD") {
		t.Fatalf("backup lost: %v", err)
	}
}

func TestInstallRechecksArchiveAndRejectsEmbeddedData(t *testing.T) {
	root := t.TempDir()
	if err := WriteDarwinLayout(root, "OLD"); err != nil {
		t.Fatal(err)
	}
	target := Target{Path: filepath.Join(root, appBundleName)}
	e := &Engine{locate: func() (Target, error) { return target, nil }}
	archive := filepath.Join(root, "update.zip")
	if err := os.WriteFile(archive, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	stage := &stagedUpdate{archive: archive, artifact: PlatformArtifact{Size: 8, SHA256: strings.Repeat("0", 64)}}
	if err := e.prepareAndStartHelper(context.Background(), stage); !errors.Is(err, ErrTampered) {
		t.Fatalf("err=%v", err)
	}
	e.dataDir = filepath.Join(target.Path, "userdata")
	if err := e.prepareAndStartHelper(context.Background(), stage); err == nil || !strings.Contains(err.Error(), "数据目录") {
		t.Fatalf("err=%v", err)
	}
	data, err := os.ReadFile(filepath.Join(target.Path, "Contents", "MacOS", "BeefTV"))
	if err != nil || !strings.Contains(string(data), "OLD") {
		t.Fatal("old program changed")
	}
}

func TestRejectWindowsAliasesAndOverflowVersions(t *testing.T) {
	for _, name := range []string{"BeefTV.exe:payload", "plugin-packages/NUL.txt", "x/COM1", "x/name.", "x/name /file"} {
		if _, _, err := sanitizeZipName(name); err == nil {
			t.Errorf("accepted %q", name)
		}
	}
	if _, err := parseStableVersion("v999999999999999999999999999.1.1"); err == nil {
		t.Fatal("overflow accepted")
	}
	var dst any
	if err := decodeJSONStrict([]byte(`{} {}`), &dst); err == nil {
		t.Fatal("trailing JSON accepted")
	}
}

func TestWindowsInstallRejectsCollocatedUserData(t *testing.T) {
	root := t.TempDir()
	if err := WriteWindowsLayout(root, "OLD"); err != nil {
		t.Fatal(err)
	}
	custom := filepath.Join(root, pluginDirName, "custom.beeftv-plugin")
	if err := os.WriteFile(custom, []byte("uploaded"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := Target{Platform: "windows-amd64", Path: filepath.Join(root, windowsExeName)}
	e := &Engine{dataDir: root, locate: func() (Target, error) { return target, nil }}
	if err := e.prepareAndStartHelper(context.Background(), &stagedUpdate{platform: "windows-amd64"}); err == nil || !strings.Contains(err.Error(), "数据目录") {
		t.Fatalf("err=%v", err)
	}
	data, err := os.ReadFile(custom)
	if err != nil || string(data) != "uploaded" {
		t.Fatal("custom plugin changed")
	}
}

func TestHelperExitWhileParentAliveMakesInstallRetryable(t *testing.T) {
	done := make(chan error, 1)
	e := &Engine{state: UpdateState{Status: StatusInstalling}, helperDone: done}
	e.monitorHelper()
	done <- errors.New("等待应用退出超时")
	deadline := time.Now().Add(time.Second)
	for e.Status().Status == StatusInstalling && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if e.Status().Status != StatusError {
		t.Fatal("install remained stuck")
	}
	if err := e.begin(actionCheck); err != nil {
		t.Fatalf("retry blocked: %v", err)
	}
	e.end()
}
