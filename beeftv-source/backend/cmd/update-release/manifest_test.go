package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testCommit = "0123456789abcdef0123456789abcdef01234567"

func TestSignVerifyRoundTripAndTamper(t *testing.T) {
	dir := t.TempDir()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	privatePath := filepath.Join(dir, "private")
	if err := writeKeyFile(privatePath, encodeKey(private), 0o600); err != nil {
		t.Fatal(err)
	}
	darwinZip := packageNamed(t, dir, platformDarwinARM64, "v1.6.0")
	windowsZip := packageNamed(t, dir, platformWindowsAMD64, "v1.6.0")
	amdZip := packageNamed(t, dir, platformDarwinAMD64, "v1.6.0")
	notesPath := filepath.Join(dir, "CHANGELOG.md")
	if err := os.WriteFile(notesPath, []byte("## v1.6.0\n\n- Keep projects and settings.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	envelopePath := filepath.Join(dir, "desktop-update.json")
	var stdout bytes.Buffer
	args := []string{
		"sign",
		"--version", "v1.6.0",
		"--commit", testCommit,
		"--changelog", notesPath,
		"--private-key", privatePath,
		"--expect-public-key", encodeKey(public),
		"--output", envelopePath,
		"--require-platforms", "darwin-arm64,darwin-amd64,windows-amd64",
		"--asset", "darwin-arm64=" + darwinZip,
		"--asset", "darwin-amd64=" + amdZip,
		"--asset", "windows-amd64=" + windowsZip,
	}
	if err := run(args, &stdout, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "platforms=3") {
		t.Fatalf("expected 3 platforms, got %q", stdout.String())
	}

	var verifyOut bytes.Buffer
	if err := run([]string{"verify", "--envelope", envelopePath, "--public-key-text", encodeKey(public)}, &verifyOut, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(verifyOut.String(), "version=v1.6.0") {
		t.Fatalf("verify stdout %q", verifyOut.String())
	}

	raw, err := os.ReadFile(envelopePath)
	if err != nil {
		t.Fatal(err)
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	payloadBytes, err := base64.StdEncoding.DecodeString(env.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var body payload
	if err := json.Unmarshal(payloadBytes, &body); err != nil {
		t.Fatal(err)
	}
	if body.Schema != 1 || body.Version != "v1.6.0" || body.Commit != testCommit {
		t.Fatalf("unexpected payload %#v", body)
	}
	if body.Notes != "- Keep projects and settings." {
		t.Fatalf("notes %q", body.Notes)
	}
	asset := body.Platforms[platformDarwinARM64]
	if asset.URL != "https://updates.beefapi.com/beeftv/v1.6.0/BeefTV-v1.6.0-darwin-arm64.zip" {
		t.Fatalf("url %q", asset.URL)
	}
	if asset.Size <= 0 || len(asset.SHA256) != 64 {
		t.Fatalf("asset metadata %#v", asset)
	}

	tamperedPayload := append([]byte{}, payloadBytes...)
	tamperedPayload[len(tamperedPayload)-2] ^= 0x01
	tamperedEnv := envelope{Payload: base64.StdEncoding.EncodeToString(tamperedPayload), Signature: env.Signature}
	tamperedPath := filepath.Join(dir, "tampered-payload.json")
	writeJSON(t, tamperedPath, tamperedEnv)
	if err := run([]string{"verify", "--envelope", tamperedPath, "--public-key-text", encodeKey(public)}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("tampered payload should fail verification")
	}

	sig, err := base64.StdEncoding.DecodeString(env.Signature)
	if err != nil {
		t.Fatal(err)
	}
	sig[0] ^= 0x01
	tamperedSig := envelope{Payload: env.Payload, Signature: base64.StdEncoding.EncodeToString(sig)}
	sigPath := filepath.Join(dir, "tampered-sig.json")
	writeJSON(t, sigPath, tamperedSig)
	if err := run([]string{"verify", "--envelope", sigPath, "--public-key-text", encodeKey(public)}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("tampered signature should fail verification")
	}

	_, otherPrivate, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	wrongPublic := otherPrivate.Public().(ed25519.PublicKey)
	if err := run([]string{"verify", "--envelope", envelopePath, "--public-key-text", encodeKey(wrongPublic)}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("wrong public key should fail verification")
	}
}

func TestSignRejectsInvalidInputs(t *testing.T) {
	dir := t.TempDir()
	_, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	privatePath := filepath.Join(dir, "private")
	if err := writeKeyFile(privatePath, encodeKey(private), 0o600); err != nil {
		t.Fatal(err)
	}
	zipPath := packageNamed(t, dir, platformDarwinARM64, "v1.6.0")
	out := filepath.Join(dir, "desktop-update.json")
	base := []string{"sign", "--private-key", privatePath, "--output", out, "--notes", "notes", "--asset", "darwin-arm64=" + zipPath}

	cases := []struct {
		name string
		args []string
		want string
	}{
		{"prerelease", append([]string{"sign", "--version", "v1.6.0-rc.1", "--commit", testCommit}, base[1:]...), "stable"},
		{"short commit", append([]string{"sign", "--version", "v1.6.0", "--commit", "abc123"}, base[1:]...), "full"},
		{"missing notes", []string{"sign", "--version", "v1.6.0", "--commit", testCommit, "--private-key", privatePath, "--output", out, "--asset", "darwin-arm64=" + zipPath}, "notes"},
		{"wrong name", []string{"sign", "--version", "v1.7.0", "--commit", testCommit, "--notes", "n", "--private-key", privatePath, "--output", out, "--asset", "darwin-arm64=" + zipPath}, "must be named"},
		{"missing required platform", []string{"sign", "--version", "v1.6.0", "--commit", testCommit, "--notes", "n", "--private-key", privatePath, "--output", out, "--require-platforms", "windows-amd64", "--asset", "darwin-arm64=" + zipPath}, "requires platform"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := run(tc.args, ioDiscard{}, ioDiscard{})
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tc.want)) {
				t.Fatalf("expected error containing %q, got %v", tc.want, err)
			}
		})
	}

	_, other, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	err = run([]string{
		"sign", "--version", "v1.6.0", "--commit", testCommit, "--notes", "n",
		"--private-key", privatePath, "--expect-public-key", encodeKey(other.Public().(ed25519.PublicKey)),
		"--output", out, "--asset", "darwin-arm64=" + zipPath,
	}, ioDiscard{}, ioDiscard{})
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected public mismatch, got %v", err)
	}
}

func TestPrintLdflags(t *testing.T) {
	public := encodeKey(bytes.Repeat([]byte{1}, ed25519.PublicKeySize))
	var stdout bytes.Buffer
	if err := run([]string{"print-ldflags", "--public-key", public}, &stdout, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	got := strings.TrimSpace(stdout.String())
	if !strings.Contains(got, "infinite-canvas/backend/internal/desktopupdate.FeedURL="+defaultFeedURL) {
		t.Fatalf("missing feed ldflag: %s", got)
	}
	if !strings.Contains(got, "infinite-canvas/backend/internal/desktopupdate.PublicKey="+public) {
		t.Fatalf("missing public key ldflag: %s", got)
	}
	t.Setenv(publicKeyEnv, public)
	t.Setenv("BEEFTV_UPDATER_FEED_URL", "https://example.com/desktop-update.json")
	stdout.Reset()
	if err := run([]string{"print-ldflags"}, &stdout, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "FeedURL=https://example.com/desktop-update.json") {
		t.Fatalf("expected env feed URL, got %s", stdout.String())
	}
	t.Setenv(publicKeyEnv, "")
	if err := run([]string{"print-ldflags"}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("expected missing public key to fail")
	}
}

func packageNamed(t *testing.T, dir, platform, version string) string {
	t.Helper()
	// Signing validates the archive independently of the build host. Set Unix
	// modes in the fixture itself so the macOS contract is also tested on Windows.
	out := filepath.Join(dir, artifactFileName(version, platform))
	if platform == platformDarwinARM64 || platform == platformDarwinAMD64 {
		file, err := os.Create(out)
		if err != nil {
			t.Fatal(err)
		}
		writer := zip.NewWriter(file)
		for name, body := range map[string]string{
			"BeefTV.app/Contents/MacOS/BeefTV":                                                                   "binary",
			"BeefTV.app/Contents/MacOS/cli/beeftv":                                                               "cli",
			"BeefTV.app/Contents/Info.plist":                                                                     "<plist></plist>",
			"BeefTV.app/Contents/Resources/plugin-packages/core.beeftv-plugin":                                   "plugin",
			"BeefTV.app/Contents/Resources/agent-host/server.mjs":                                                "host",
			"BeefTV.app/Contents/Resources/agent-host/session-identity.mjs":                                      "identity",
			"BeefTV.app/Contents/Resources/agent-host/package.json":                                              "{}",
			"BeefTV.app/Contents/Resources/agent-host/runtime/bin/node":                                          "node",
			"BeefTV.app/Contents/Resources/agent-host/node_modules/@earendil-works/pi-coding-agent/package.json": "{}",
		} {
			header := &zip.FileHeader{Name: name, Method: zip.Deflate}
			header.SetMode(0o755)
			entry, err := writer.CreateHeader(header)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := entry.Write([]byte(body)); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		return out
	}
	input := filepath.Join(dir, platform+"-src")
	if err := os.MkdirAll(input, 0o755); err != nil {
		t.Fatal(err)
	}
	switch platform {
	case platformDarwinARM64, platformDarwinAMD64:
		writeFakeDarwinApp(t, filepath.Join(input, "BeefTV.app"))
	case platformWindowsAMD64:
		writeFakeWindowsBin(t, input)
	}
	if err := packageBundle(platform, input, out); err != nil {
		t.Fatal(err)
	}
	return out
}

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := marshalCanonical(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}
