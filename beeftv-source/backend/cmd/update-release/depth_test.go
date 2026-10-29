package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/depthruntime"
)

func TestDepthSigningRoundTripAndTamper(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	t.Setenv(privateKeyEnv, base64.StdEncoding.EncodeToString(private))
	t.Setenv(publicKeyEnv, base64.StdEncoding.EncodeToString(public))
	root := t.TempDir()
	input, output := filepath.Join(root, "payload.json"), filepath.Join(root, "signed.json")
	artifact := depthruntime.Artifact{URLs: []string{"https://example.com/runtime.zip"}, Size: 1, SHA256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", Files: 1, ExpandedSize: 1}
	raw, _ := json.Marshal(depthruntime.Manifest{Version: 2, Runtimes: map[string]depthruntime.Artifact{"windows-amd64/cpu": artifact, "windows-amd64/cuda": artifact}, Model: artifact})
	if err := os.WriteFile(input, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cmdDepthManifest("sign-depth", []string{"--input", input, "--output", output}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := cmdDepthManifest("verify-depth", []string{"--input", output}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	t.Setenv(publicKeyEnv, base64.StdEncoding.EncodeToString(other))
	if err := cmdDepthManifest("verify-depth", []string{"--input", output}, io.Discard, io.Discard); err == nil {
		t.Fatal("accepted wrong public key")
	}
}
