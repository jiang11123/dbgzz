//go:build !windows

package desktopupdate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRelaunchPreservesDataDirectoryAsOneArgument(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "BeefTV.app")
	exe := filepath.Join(target, "Contents", "MacOS", "BeefTV")
	output := filepath.Join(dir, "arguments")
	if err := os.MkdirAll(filepath.Dir(exe), 0700); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + strings.ReplaceAll(output, "'", "'\"'\"'") + "'\n"
	if err := os.WriteFile(exe, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Join(dir, "data with spaces")
	if err := relaunchTarget(HelperRequest{Platform: "darwin-arm64", TargetPath: target, DataDir: dataDir}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		body, err := os.ReadFile(output)
		if err == nil && len(body) > 0 {
			if string(body) != "--data-dir="+dataDir+"\n" {
				t.Fatalf("wrong restart args: %q", body)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("restart fixture did not run")
}
