package desktopupdate

import (
	"archive/zip"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// GenerateTestKey returns a base64 raw 32-byte public key and the matching
// private key. Production code never calls this; it exists so a sibling worker
// can sign a local feed without embedding a repository secret.
func GenerateTestKey() (publicKeyB64 string, privateKey ed25519.PrivateKey, err error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", nil, err
	}
	return base64.StdEncoding.EncodeToString(public), private, nil
}

func WriteZip(path string, files map[string][]byte, executable map[string]bool) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	writer := zip.NewWriter(file)
	for name, body := range files {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		mode := os.FileMode(0o644)
		if executable[name] {
			mode = 0o755
		}
		if strings.HasSuffix(name, "/") {
			header.Name = name
			header.SetMode(os.ModeDir | 0o755)
		} else {
			header.SetMode(mode)
		}
		entry, err := writer.CreateHeader(header)
		if err != nil {
			_ = writer.Close()
			return err
		}
		if _, err := entry.Write(body); err != nil {
			_ = writer.Close()
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return file.Sync()
}

func WriteDarwinLayout(root, marker string) error {
	if err := writeAgentLayout(filepath.Join(root, appBundleName, "Contents", "Resources", "agent-host"), "runtime/bin/node", marker); err != nil {
		return err
	}
	exe := filepath.Join(root, appBundleName, "Contents", "MacOS", "BeefTV")
	plist := filepath.Join(root, appBundleName, "Contents", "Info.plist")
	plugin := filepath.Join(root, appBundleName, "Contents", "Resources", pluginDirName, "official.beeftv-plugin")
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(plugin), 0o755); err != nil {
		return err
	}
	script := fmt.Sprintf("#!/bin/sh\necho %s\n", marker)
	if err := os.WriteFile(exe, []byte(script), 0o755); err != nil {
		return err
	}
	cli := filepath.Join(root, appBundleName, "Contents", "MacOS", cliDirName, darwinCLIName)
	if err := os.MkdirAll(filepath.Dir(cli), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(cli, []byte(script), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(plist, []byte(`<plist><dict><key>CFBundleIdentifier</key><string>app.beeftv.desktop</string></dict></plist>`), 0o644); err != nil {
		return err
	}
	return os.WriteFile(plugin, []byte("official-"+marker), 0o644)
}

func WriteWindowsLayout(root, marker string) error {
	if err := writeAgentLayout(filepath.Join(root, "agent-host"), "runtime/node.exe", marker); err != nil {
		return err
	}
	exe := filepath.Join(root, windowsExeName)
	plugin := filepath.Join(root, pluginDirName, "official.beeftv-plugin")
	if err := os.MkdirAll(filepath.Dir(plugin), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(exe, []byte("MZ-"+marker), 0o644); err != nil {
		return err
	}
	cli := filepath.Join(root, cliDirName, windowsCLIName)
	if err := os.MkdirAll(filepath.Dir(cli), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(cli, []byte("MZ-cli-"+marker), 0o644); err != nil {
		return err
	}
	return os.WriteFile(plugin, []byte("official-"+marker), 0o644)
}

func DarwinZipFiles(marker string) (map[string][]byte, map[string]bool) {
	files := map[string][]byte{
		"BeefTV.app/Contents/MacOS/BeefTV":                                     []byte("#!/bin/sh\necho " + marker + "\n"),
		"BeefTV.app/Contents/Info.plist":                                       []byte("<plist></plist>"),
		"BeefTV.app/Contents/Resources/plugin-packages/official.beeftv-plugin": []byte("official-" + marker),
	}
	files["BeefTV.app/Contents/MacOS/cli/beeftv"] = []byte("#!/bin/sh\necho cli-" + marker + "\n")
	execFiles := map[string]bool{"BeefTV.app/Contents/MacOS/BeefTV": true, "BeefTV.app/Contents/MacOS/cli/beeftv": true}
	for name, body := range agentFiles("runtime/bin/node", marker) {
		files["BeefTV.app/Contents/Resources/agent-host/"+name] = body
	}
	execFiles["BeefTV.app/Contents/Resources/agent-host/runtime/bin/node"] = true
	return files, execFiles
}

func WindowsZipFiles(marker string) (map[string][]byte, map[string]bool) {
	files := map[string][]byte{
		"BeefTV.exe":                             []byte("MZ-" + marker),
		"cli/beeftv.exe":                         []byte("MZ-cli-" + marker),
		"plugin-packages/official.beeftv-plugin": []byte("official-" + marker),
	}
	for name, body := range agentFiles("runtime/node.exe", marker) {
		files["agent-host/"+name] = body
	}
	return files, map[string]bool{}
}

func agentFiles(node, marker string) map[string][]byte {
	files := map[string][]byte{}
	for _, name := range []string{"server.mjs", "session-identity.mjs", "canvas-turn.mjs", "request-budget.mjs", "package.json", node, "node_modules/@earendil-works/pi-coding-agent/package.json"} {
		files[name] = []byte(marker)
	}
	return files
}

func writeAgentLayout(root, node, marker string) error {
	for name, body := range agentFiles(node, marker) {
		file := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(file, body, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func testPayload(version, platform, artifactURL, sha256 string, size int64, notes string) Payload {
	return Payload{
		Schema:  1,
		Version: version,
		Commit:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Notes:   notes,
		Platforms: map[string]PlatformArtifact{
			platform: {URL: artifactURL, SHA256: sha256, Size: size},
		},
	}
}
