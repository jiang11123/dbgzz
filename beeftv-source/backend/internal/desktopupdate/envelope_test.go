package desktopupdate

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestVerifyEnvelopeRejectsInvalidSignatureAndTamper(t *testing.T) {
	pubB64, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	key, err := ParsePublicKey(pubB64)
	if err != nil {
		t.Fatal(err)
	}
	payload := testPayload("v1.6.0", "darwin-arm64", "https://example.com/a.zip", strings.Repeat("ab", 32), 12, "notes")
	raw, err := SignEnvelope(priv, payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyEnvelope(raw, key); err != nil {
		t.Fatal(err)
	}

	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	payloadBytes, _ := base64.StdEncoding.DecodeString(env.Payload)
	payloadBytes[0] ^= 0xff
	env.Payload = base64.StdEncoding.EncodeToString(payloadBytes)
	tampered, _ := json.Marshal(env)
	if _, _, err := verifyEnvelope(tampered, key); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("tamper = %v", err)
	}

	env.Signature = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	env.Payload = base64.StdEncoding.EncodeToString(mustMarshal(t, payload))
	badSig, _ := json.Marshal(env)
	if _, _, err := verifyEnvelope(badSig, key); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("bad signature = %v", err)
	}
}

func TestVerifyEnvelopeRejectsUnstableVersionAndShortCommit(t *testing.T) {
	_, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	pub := priv.Public().(ed25519.PublicKey)
	payload := testPayload("1.6.0", "darwin-arm64", "https://example.com/a.zip", strings.Repeat("ab", 32), 12, "")
	raw, err := SignEnvelope(priv, payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyEnvelope(raw, pub); err == nil {
		t.Fatal("expected unstable version to fail")
	}
	payload = testPayload("v1.6.0-beta.1", "darwin-arm64", "https://example.com/a.zip", strings.Repeat("ab", 32), 12, "")
	raw, err = SignEnvelope(priv, payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyEnvelope(raw, pub); err == nil {
		t.Fatal("expected prerelease to fail")
	}
	payload = testPayload("v1.6.0", "darwin-arm64", "https://example.com/a.zip", strings.Repeat("ab", 32), 12, "")
	payload.Commit = "abc123"
	raw, err = SignEnvelope(priv, payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyEnvelope(raw, pub); err == nil {
		t.Fatal("expected short commit to fail")
	}
}

func TestUpdateStateJSONContract(t *testing.T) {
	data, err := json.Marshal(UpdateState{Status: StatusIdle, CurrentVersion: "v1.5.1"})
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	want := []string{"status", "currentVersion", "latestVersion", "releaseNotes", "downloadedBytes", "totalBytes", "bytesPerSecond", "reconnecting", "error"}
	if len(raw) != len(want) {
		t.Fatalf("fields = %v", raw)
	}
	for _, key := range want {
		if _, ok := raw[key]; !ok {
			t.Fatalf("missing %s in %s", key, data)
		}
	}
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
