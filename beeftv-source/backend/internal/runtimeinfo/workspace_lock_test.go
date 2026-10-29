package runtimeinfo

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestWorkspaceLockRejectsLiveLegacyProcess(t *testing.T) {
	if os.Getenv("BEEFTV_LOCK_TEST_CHILD") == "1" {
		time.Sleep(time.Minute)
		return
	}
	child := exec.Command(os.Args[0], "-test.run=^TestWorkspaceLockRejectsLiveLegacyProcess$")
	child.Env = append(os.Environ(), "BEEFTV_LOCK_TEST_CHILD=1")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	// A default Windows workspace has exactly the same protection as another drive.
	dir := filepath.Join(t.TempDir(), "AppData", "Roaming", "BeefTV")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(Info{BaseURL: "http://127.0.0.1:59999/api", PID: child.Process.Pid})
	if err := os.WriteFile(filepath.Join(dir, FileName), body, 0600); err != nil {
		t.Fatal(err)
	}
	if lock, err := LockWorkspace(dir); err == nil {
		lock.Close()
		t.Fatal("live legacy writer accepted")
	}
	_ = child.Process.Kill()
	_ = child.Wait()
	lock, err := LockWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if runtime.GOOS == "windows" && !strings.Contains(lock.Name(), string(os.PathSeparator)+".beeftv"+string(os.PathSeparator)+"runtime"+string(os.PathSeparator)) {
		t.Fatal("lock remained inside AppData")
	}
	if duplicate, err := LockWorkspace(dir); err == nil {
		duplicate.Close()
		t.Fatal("second writer accepted")
	}
}
