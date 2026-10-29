package desktopupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func linuxFixture(t *testing.T, root, version string) string {
	t.Helper()
	bundle := filepath.Join(root, linuxBundleName)
	for _, name := range []string{"BeefTV", "cli/beeftv", "plugin-packages/core.beeftv-plugin", "agent-host/server.mjs", "agent-host/session-identity.mjs", "agent-host/canvas-turn.mjs", "agent-host/request-budget.mjs", "agent-host/package.json", "agent-host/node_modules/@earendil-works/pi-coding-agent/package.json", "agent-host/runtime/bin/node"} {
		file := filepath.Join(bundle, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(version), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return bundle
}

func TestLinuxWholeBundleReplacementAndRollback(t *testing.T) {
	root := t.TempDir()
	installed := linuxFixture(t, filepath.Join(root, "install"), "old")
	stage := filepath.Join(root, "stage")
	linuxFixture(t, stage, "new")
	req := HelperRequest{Schema: helperRequestSchema, ParentPID: os.Getpid(), Platform: "linux-amd64", TargetPath: installed, StagedPath: stage, BackupPath: filepath.Join(root, "backup")}
	if err := validateHelperRequest(req); err != nil {
		t.Fatal(err)
	}
	target, err := locateLinux("linux-amd64", filepath.Join(installed, "BeefTV"))
	if err != nil || target.Path != installed {
		t.Fatalf("invalid Linux target: %+v %v", target, err)
	}
	if err := SwapInstall(req); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"BeefTV", "cli/beeftv", "agent-host/runtime/bin/node", "plugin-packages/core.beeftv-plugin"} {
		data, err := os.ReadFile(filepath.Join(installed, name))
		if err != nil || string(data) != "new" {
			t.Fatalf("incomplete replacement of %s", name)
		}
	}
	if err := RestoreBackup(req); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"BeefTV", "cli/beeftv", "agent-host/runtime/bin/node", "plugin-packages/core.beeftv-plugin"} {
		data, err := os.ReadFile(filepath.Join(installed, name))
		if err != nil || string(data) != "old" {
			t.Fatalf("incomplete rollback of %s", name)
		}
	}
}

func TestLinuxRejectsIncompleteAndUnexpectedLayout(t *testing.T) {
	root := t.TempDir()
	bundle := linuxFixture(t, root, "fixture")
	if err := validateExtractedLayout(root, "linux-amd64"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "extra"), []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := validateExtractedLayout(root, "linux-amd64"); err == nil {
		t.Fatal("accepted extra root file")
	}
	if err := os.Remove(filepath.Join(root, "extra")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(bundle, "agent-host/runtime/bin/node")); err != nil {
		t.Fatal(err)
	}
	if err := validateExtractedLayout(root, "linux-amd64"); err == nil {
		t.Fatal("accepted missing Node")
	}
}
