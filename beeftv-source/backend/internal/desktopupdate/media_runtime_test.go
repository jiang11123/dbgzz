package desktopupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsMediaRuntimeSwapAndRollback(t *testing.T) {
	for _, previousHasMedia := range []bool{false, true} {
		root := t.TempDir()
		old, next := filepath.Join(root, "old"), filepath.Join(root, "new")
		for _, dir := range []string{old, next} {
			if err := WriteWindowsLayout(dir, "app"); err != nil {
				t.Fatal(err)
			}
		}
		write := func(dir, marker string) {
			media := filepath.Join(dir, "media-runtime")
			if err := os.MkdirAll(media, 0o755); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"ffmpeg.exe", "ffprobe.exe", "LICENSE", "README.txt", "manifest.json"} {
				if err := os.WriteFile(filepath.Join(media, name), []byte(marker), 0o644); err != nil {
					t.Fatal(err)
				}
			}
		}
		if previousHasMedia {
			write(old, "old")
		}
		write(next, "new")
		if err := validateWindowsLayout(next); err != nil {
			t.Fatal(err)
		}
		req := HelperRequest{Platform: "windows-amd64", TargetPath: filepath.Join(old, windowsExeName), StagedPath: next, BackupPath: filepath.Join(root, "backup")}
		if err := SwapInstall(req); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(old, "media-runtime", "ffmpeg.exe")
		if b, err := os.ReadFile(path); err != nil || string(b) != "new" {
			t.Fatalf("media not installed: %q %v", b, err)
		}
		if err := RestoreBackup(req); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(path)
		if previousHasMedia {
			if err != nil || string(b) != "old" {
				t.Fatalf("media not restored: %q %v", b, err)
			}
		} else if !os.IsNotExist(err) {
			t.Fatal("new media survived rollback")
		}
	}
}

func TestWindowsHistoricalPayloadPreservesInstalledMediaRuntime(t *testing.T) {
	root := t.TempDir()
	old, next := filepath.Join(root, "old"), filepath.Join(root, "new")
	for _, dir := range []string{old, next} {
		if err := WriteWindowsLayout(dir, "app"); err != nil {
			t.Fatal(err)
		}
	}
	media := filepath.Join(old, "media-runtime")
	if err := os.MkdirAll(media, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(media, "ffmpeg.exe")
	if err := os.WriteFile(path, []byte("installed"), 0o644); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{Platform: "windows-amd64", TargetPath: filepath.Join(old, windowsExeName), StagedPath: next, BackupPath: filepath.Join(root, "backup")}
	if err := SwapInstall(req); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(path); err != nil || string(b) != "installed" {
		t.Fatal("installed runtime lost", err)
	}
	if err := RestoreBackup(req); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("preserved runtime lost during rollback", err)
	}
}

func TestWindowsNestedMediaRuntimeSwapAndRollback(t *testing.T) {
	root := t.TempDir()
	old, next := filepath.Join(root, "old"), filepath.Join(root, "new")
	for _, dir := range []string{old, next} {
		if err := WriteWindowsLayout(dir, "app"); err != nil {
			t.Fatal(err)
		}
	}
	media := filepath.Join(next, "agent-host", "media-runtime")
	if err := os.MkdirAll(media, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ffmpeg.exe", "ffprobe.exe", "LICENSE", "README.txt", "manifest.json"} {
		if err := os.WriteFile(filepath.Join(media, name), []byte("new"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := validateWindowsLayout(next); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(media, "LICENSE")); err != nil {
		t.Fatal(err)
	}
	if err := validateWindowsLayout(next); err == nil {
		t.Fatal("incomplete nested media accepted")
	}
	if err := os.WriteFile(filepath.Join(media, "LICENSE"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{Platform: "windows-amd64", TargetPath: filepath.Join(old, windowsExeName), StagedPath: next, BackupPath: filepath.Join(root, "backup")}
	if err := SwapInstall(req); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(old, "agent-host", "media-runtime", "ffmpeg.exe")
	if b, err := os.ReadFile(path); err != nil || string(b) != "new" {
		t.Fatalf("nested media not installed: %q %v", b, err)
	}
	if err := RestoreBackup(req); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("nested media survived rollback", err)
	}
}

func TestDarwinMediaRuntimeRequiresCompleteTools(t *testing.T) {
	root := t.TempDir()
	if err := WriteDarwinLayout(root, "app"); err != nil {
		t.Fatal(err)
	}
	media := filepath.Join(root, appBundleName, "Contents", "Resources", "agent-host", "media-runtime")
	if err := os.MkdirAll(media, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ffprobe", "LICENSE", "README.txt", "manifest.json"} {
		if err := os.WriteFile(filepath.Join(media, name), []byte("fixture"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := validateDarwinLayout(root); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(media, "ffprobe")); err != nil {
		t.Fatal(err)
	}
	if err := validateDarwinLayout(root); err == nil {
		t.Fatal("missing bundled probe accepted")
	}
}
