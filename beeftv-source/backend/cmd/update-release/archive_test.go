package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPackageDarwinLayoutAndModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("macOS packaging requires a filesystem that preserves Unix executable modes")
	}
	root := t.TempDir()
	app := writeFakeDarwinApp(t, filepath.Join(root, "BeefTV.app"))
	outside := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(outside, []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, ".env"), []byte("SECRET=1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "Contents", "Resources", "user.db"), []byte("sqlite"), 0o644); err != nil {
		t.Fatal(err)
	}
	pluginDir := filepath.Join(app, "Contents", "Resources", "plugin-packages")
	if err := os.WriteFile(filepath.Join(pluginDir, "real.beeftv-plugin"), []byte("plugin-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink("real.beeftv-plugin", filepath.Join(pluginDir, "alias.beeftv-plugin")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(app, "Contents", "MacOS", "escaped")); err != nil {
			t.Fatal(err)
		}
	}

	out := filepath.Join(t.TempDir(), "BeefTV-v1.6.0-darwin-arm64.zip")
	var stdout bytes.Buffer
	err := run([]string{"package", "--platform", "darwin-arm64", "--input", app, "--output", out}, &stdout, ioDiscard{})
	if runtime.GOOS != "windows" {
		if err == nil {
			t.Fatal("expected escaping symlink to fail")
		}
		if err := os.Remove(filepath.Join(app, "Contents", "MacOS", "escaped")); err != nil {
			t.Fatal(err)
		}
		stdout.Reset()
		if err := run([]string{"package", "--platform", "darwin-arm64", "--input", app, "--output", out}, &stdout, ioDiscard{}); err != nil {
			t.Fatal(err)
		}
	} else if err != nil {
		t.Fatal(err)
	}

	names := zipNames(t, out)
	if !names["BeefTV.app/Contents/MacOS/cli/beeftv"] {
		t.Fatal("missing bundled CLI")
	}
	if !names["BeefTV.app/Contents/MacOS/BeefTV"] {
		t.Fatalf("missing executable: %v", names)
	}
	if !names["BeefTV.app/Contents/Resources/agent-host/runtime/bin/node"] || !names["BeefTV.app/Contents/Resources/agent-host/server.mjs"] {
		t.Fatalf("missing agent host: %v", names)
	}
	if names["BeefTV.app/.env"] || names["BeefTV.app/Contents/Resources/user.db"] {
		t.Fatalf("secret or db leaked into zip: %v", names)
	}
	if runtime.GOOS != "windows" {
		if !names["BeefTV.app/Contents/Resources/plugin-packages/alias.beeftv-plugin"] {
			t.Fatalf("dereferenced plugin alias missing: %v", names)
		}
	}
	reader, err := zip.OpenReader(out)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var sawExec, sawSymlink bool
	for _, file := range reader.File {
		if file.Name == "BeefTV.app/Contents/Resources/agent-host/runtime/bin/node" && file.Mode()&0o111 == 0 {
			t.Fatal("bundled Node executable mode not preserved")
		}
		if file.Mode()&os.ModeSymlink != 0 {
			sawSymlink = true
		}
		if file.Name == "BeefTV.app/Contents/MacOS/BeefTV" {
			sawExec = true
			if file.Mode()&0o111 == 0 {
				t.Fatalf("executable mode not preserved: %s", file.Mode())
			}
			opened, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, 8)
			n, _ := opened.Read(buf)
			opened.Close()
			if string(buf[:n]) != "binary" && !bytes.HasPrefix(buf, []byte("binary")) {
				content := readZipFile(t, file)
				if string(content) != "binary" {
					t.Fatalf("unexpected executable content %q", content)
				}
			}
		}
		if file.Name == "BeefTV.app/Contents/Resources/plugin-packages/alias.beeftv-plugin" {
			if got := string(readZipFile(t, file)); got != "plugin-bytes" {
				t.Fatalf("alias content %q", got)
			}
		}
	}
	if !sawExec {
		t.Fatal("executable zip entry missing")
	}
	if sawSymlink {
		t.Fatal("zip contained symlink entries")
	}
	if !strings.Contains(stdout.String(), "sha256=") || !strings.Contains(stdout.String(), "size=") {
		t.Fatalf("package should report sha256 and size, got %q", stdout.String())
	}
}

func TestPackageWindowsLayout(t *testing.T) {
	bin := writeFakeWindowsBin(t, t.TempDir())
	if err := os.WriteFile(filepath.Join(bin, ".env.local"), []byte("nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "extra.dll"), []byte("ignore"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "BeefTV-v1.6.0-windows-amd64.zip")
	if err := run([]string{"package", "--platform", "windows-amd64", "--input", bin, "--output", out}, ioDiscard{}, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	names := zipNames(t, out)
	if !names["cli/beeftv.exe"] {
		t.Fatal("missing bundled CLI")
	}
	if !names["BeefTV.exe"] || !names["plugin-packages/core.beeftv-plugin"] || !names["agent-host/runtime/node.exe"] || !names["agent-host/node_modules/@earendil-works/pi-coding-agent/package.json"] {
		t.Fatalf("windows zip layout %v", names)
	}
	if names[".env.local"] || names["extra.dll"] {
		t.Fatalf("windows zip included extra files: %v", names)
	}
}

func TestPackageWindowsMediaRuntime(t *testing.T) {
	bin := writeFakeWindowsBin(t, t.TempDir())
	media := filepath.Join(bin, "media-runtime")
	if err := os.MkdirAll(media, 0o755); err != nil {
		t.Fatal(err)
	}
	names := []string{"ffmpeg.exe", "LICENSE", "README.txt", "manifest.json"}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(media, name), []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	out := filepath.Join(t.TempDir(), "out.zip")
	if err := packageBundle(platformWindowsAMD64, bin, out); err != nil {
		t.Fatal(err)
	}
	entries := zipNames(t, out)
	for _, name := range names {
		if !entries["media-runtime/"+name] {
			t.Fatalf("media runtime omitted %s", name)
		}
	}
	if err := os.Remove(filepath.Join(media, "LICENSE")); err != nil {
		t.Fatal(err)
	}
	if err := packageBundle(platformWindowsAMD64, bin, filepath.Join(t.TempDir(), "bad.zip")); err == nil || !strings.Contains(err.Error(), "media-runtime") {
		t.Fatalf("incomplete media runtime accepted: %v", err)
	}
}

func TestPackageRejectsInvalidInputs(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out.zip")
	if err := run([]string{"package", "--platform", "linux-arm64", "--input", dir, "--output", out}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("expected unknown platform to fail")
	}
	if err := run([]string{"package", "--platform", "windows-amd64", "--input", dir, "--output", out}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("expected missing exe to fail")
	}
	dataDir := filepath.Join(dir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "open_ai_canvas.db"), []byte("db"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "BeefTV.exe"), []byte("exe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "plugin-packages"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "plugin-packages", "core.beeftv-plugin"), []byte("p"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"package", "--platform", "windows-amd64", "--input", dataDir, "--output", out}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("expected user data directory to be rejected")
	}
}

func TestPackageWindowsNestedMediaRuntimeUsesReleasedRootLayout(t *testing.T) {
	bin := writeFakeWindowsBin(t, t.TempDir())
	media := filepath.Join(bin, "agent-host", "media-runtime")
	names := []string{"ffmpeg.exe", "LICENSE", "README.txt", "manifest.json"}
	writeMedia := func(dir string) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for _, name := range names {
			if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	writeMedia(media)
	out := filepath.Join(t.TempDir(), "out.zip")
	if err := packageBundle(platformWindowsAMD64, bin, out); err != nil {
		t.Fatal(err)
	}
	entries := zipNames(t, out)
	for _, name := range names {
		if !entries["agent-host/media-runtime/"+name] {
			t.Fatalf("nested media runtime omitted %s", name)
		}
	}
	for name := range entries {
		switch strings.Split(name, "/")[0] {
		case "BeefTV.exe", "cli", "agent-host", "plugin-packages":
		default:
			t.Fatalf("released updater rejects root entry %s", name)
		}
	}
	if err := os.Remove(filepath.Join(media, "LICENSE")); err != nil {
		t.Fatal(err)
	}
	writeMedia(filepath.Join(bin, "media-runtime"))
	if err := packageBundle(platformWindowsAMD64, bin, filepath.Join(t.TempDir(), "bad.zip")); err == nil || !strings.Contains(err.Error(), "agent-host/media-runtime/LICENSE") {
		t.Fatalf("standalone media masked an incomplete nested runtime: %v", err)
	}
}

func writeFakeDarwinApp(t *testing.T, app string) string {
	t.Helper()
	macOS := filepath.Join(app, "Contents", "MacOS")
	plugins := filepath.Join(app, "Contents", "Resources", "plugin-packages")
	if err := os.MkdirAll(macOS, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(plugins, 0o755); err != nil {
		t.Fatal(err)
	}
	execPath := filepath.Join(macOS, "BeefTV")
	if err := os.WriteFile(execPath, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(execPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte("<plist></plist>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plugins, "core.beeftv-plugin"), []byte("plugin"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeFakeAgentHost(t, filepath.Join(app, "Contents", "Resources", "agent-host"), "runtime/bin/node")
	writeFakeCLI(t, filepath.Join(macOS, "cli", "beeftv"))
	return app
}

func writeFakeWindowsBin(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "plugin-packages"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "BeefTV.exe"), []byte("exe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plugin-packages", "core.beeftv-plugin"), []byte("plugin"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeFakeAgentHost(t, filepath.Join(dir, "agent-host"), "runtime/node.exe")
	writeFakeCLI(t, filepath.Join(dir, "cli", "beeftv.exe"))
	return dir
}

func writeFakeCLI(t *testing.T, file string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("cli"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestPackageRejectsInvalidCLI(t *testing.T) {
	for _, platform := range []string{platformWindowsAMD64, platformDarwinARM64} {
		for _, defect := range []string{"missing", "empty", "directory", "not-executable"} {
			t.Run(platform+"/"+defect, func(t *testing.T) {
				if platform == platformDarwinARM64 && runtime.GOOS == "windows" {
					t.Skip("requires Unix modes")
				}
				if defect == "not-executable" && platform == platformWindowsAMD64 {
					t.Skip("Windows executable mode is not significant")
				}
				root := t.TempDir()
				var cli string
				if platform == platformWindowsAMD64 {
					writeFakeWindowsBin(t, root)
					cli = filepath.Join(root, "cli", "beeftv.exe")
				} else {
					root = writeFakeDarwinApp(t, filepath.Join(root, "BeefTV.app"))
					cli = filepath.Join(root, "Contents", "MacOS", "cli", "beeftv")
				}
				if err := os.Remove(cli); err != nil {
					t.Fatal(err)
				}
				switch defect {
				case "empty":
					if err := os.WriteFile(cli, nil, 0o755); err != nil {
						t.Fatal(err)
					}
				case "directory":
					if err := os.Mkdir(cli, 0o755); err != nil {
						t.Fatal(err)
					}
				case "not-executable":
					if err := os.WriteFile(cli, []byte("cli"), 0o644); err != nil {
						t.Fatal(err)
					}
				}
				out := filepath.Join(t.TempDir(), "out.zip")
				if err := packageBundle(platform, root, out); err == nil {
					t.Fatal("invalid CLI accepted")
				}
				if _, err := os.Stat(out); !os.IsNotExist(err) {
					t.Fatalf("invalid package was published: %v", err)
				}
			})
		}
	}
}

func writeFakeAgentHost(t *testing.T, root, node string) {
	t.Helper()
	for _, name := range []string{"server.mjs", "session-identity.mjs", "package.json", node, "node_modules/@earendil-works/pi-coding-agent/package.json"} {
		file := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("fixture"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPackageRejectsMissingAgentRuntime(t *testing.T) {
	bin := writeFakeWindowsBin(t, t.TempDir())
	if err := os.Remove(filepath.Join(bin, "agent-host", "runtime", "node.exe")); err != nil {
		t.Fatal(err)
	}
	if err := packageBundle(platformWindowsAMD64, bin, filepath.Join(t.TempDir(), "out.zip")); err == nil || !strings.Contains(err.Error(), "agent-host") {
		t.Fatalf("missing runtime accepted: %v", err)
	}
}

func zipNames(t *testing.T, path string) map[string]bool {
	t.Helper()
	reader, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	names := map[string]bool{}
	for _, file := range reader.File {
		names[file.Name] = true
	}
	return names
}

func readZipFile(t *testing.T, file *zip.File) []byte {
	t.Helper()
	opened, err := file.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(opened); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
