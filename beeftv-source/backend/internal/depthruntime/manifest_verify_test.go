package depthruntime

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
)

func signedTestManifest(t *testing.T, manifest Manifest) ([]byte, ed25519.PublicKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(map[string]string{
		"payload":   base64.StdEncoding.EncodeToString(payload),
		"signature": base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return envelope, public
}

func TestVerifySignedManifestAcceptsVerifiedPlatformEntries(t *testing.T) {
	want := Manifest{Version: 2, Runtimes: map[string]Artifact{
		"windows-amd64/cpu":  {URLs: []string{"https://example.test/cpu.zip"}, Size: 2, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		"windows-amd64/cuda": {URLs: []string{"https://example.test/cuda.zip"}, Size: 3, SHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
	}, Model: Artifact{URLs: []string{"https://example.test/model.pth"}, Size: 4, SHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}}
	envelope, public := signedTestManifest(t, want)

	got, err := verifySignedManifest(envelope, public)

	if err != nil {
		t.Fatal(err)
	}
	if got.Version != 2 || got.Runtimes["windows-amd64/cpu"].Size != 2 || got.Runtimes["windows-amd64/cuda"].Size != 3 {
		t.Fatalf("verified manifest lost platform variants: %#v", got)
	}
}

func TestVerifySignedManifestRejectsTamperedPayload(t *testing.T) {
	envelope, public := signedTestManifest(t, Manifest{Version: 2, Runtimes: map[string]Artifact{
		"windows-amd64/cpu": {URLs: []string{"https://example.test/cpu.zip"}, Size: 2, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
	}, Model: Artifact{URLs: []string{"https://example.test/model.pth"}, Size: 4, SHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}})
	var changed map[string]string
	if err := json.Unmarshal(envelope, &changed); err != nil {
		t.Fatal(err)
	}
	payload, _ := base64.StdEncoding.DecodeString(changed["payload"])
	var manifest Manifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Runtimes["windows-amd64/cpu"] = Artifact{URLs: []string{"https://attacker.test/runtime.zip"}, Size: 2, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	modified, _ := json.Marshal(manifest)
	changed["payload"] = base64.StdEncoding.EncodeToString(modified)
	tampered, _ := json.Marshal(changed)

	if _, err := verifySignedManifest(tampered, public); err == nil {
		t.Fatal("tampered runtime URL was accepted")
	}
}

func TestVerifySignedManifestRejectsWrongKeyAndTrailingJSON(t *testing.T) {
	envelope, _ := signedTestManifest(t, Manifest{Version: 2})
	otherKey, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := verifySignedManifest(envelope, otherKey); err == nil {
		t.Fatal("wrong signing key was accepted")
	}
	if _, err := verifySignedManifest(append(envelope, []byte(` {"payload":"extra"}`)...), otherKey); err == nil {
		t.Fatal("trailing JSON was accepted")
	}
}
