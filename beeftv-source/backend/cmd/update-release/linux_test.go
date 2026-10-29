package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPackageLinuxBundleAndExecutableModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Linux archives require Unix executable modes")
	}
	bundle := filepath.Join(t.TempDir(), linuxBundleName)
	for _, name := range []string{"BeefTV", "cli/beeftv", "plugin-packages/core.beeftv-plugin"} {
		file := filepath.Join(bundle, name)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("fixture"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFakeAgentHost(t, filepath.Join(bundle, "agent-host"), "runtime/bin/node")
	out := filepath.Join(t.TempDir(), "BeefTV-v1.7.15-linux-amd64.zip")
	if err := packageBundle(platformLinuxAMD64, bundle, out); err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "private")
	if err := writeKeyFile(keyPath, encodeKey(private), 0o600); err != nil {
		t.Fatal(err)
	}
	notes := filepath.Join(t.TempDir(), "CHANGELOG.md")
	if err := os.WriteFile(notes, []byte("## v1.7.15\n\n- Linux support.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(t.TempDir(), "desktop-update.json")
	args := []string{"sign", "--version", "v1.7.15", "--commit", testCommit, "--changelog", notes, "--private-key", keyPath, "--expect-public-key", encodeKey(public), "--output", manifest, "--require-platforms", "darwin-arm64,darwin-amd64,windows-amd64,linux-amd64"}
	for _, platform := range []string{platformDarwinARM64, platformDarwinAMD64, platformWindowsAMD64} {
		args = append(args, "--asset", platform+"="+packageNamed(t, t.TempDir(), platform, "v1.7.15"))
	}
	if err := run(args, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("signed incomplete four-platform release")
	}
	args = append(args, "--asset", platformLinuxAMD64+"="+out)
	var signed bytes.Buffer
	if err := run(args, &signed, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"verify", "--envelope", manifest, "--public-key-text", encodeKey(public)}, ioDiscard{}, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	reader, err := zip.OpenReader(out)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	for _, name := range []string{"BeefTV-linux/BeefTV", "BeefTV-linux/cli/beeftv", "BeefTV-linux/agent-host/runtime/bin/node"} {
		found := false
		for _, entry := range reader.File {
			if entry.Name == name {
				found = entry.Mode()&0o111 != 0
			}
		}
		if !found {
			t.Fatalf("missing executable %s", name)
		}
	}
	if err := os.Chmod(filepath.Join(bundle, "cli/beeftv"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := packageBundle(platformLinuxAMD64, bundle, out); err == nil {
		t.Fatal("accepted non-executable Linux CLI")
	}
}
