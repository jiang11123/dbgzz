package desktopupdate

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
)

type Envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type Payload struct {
	Schema    int                         `json:"schema"`
	Version   string                      `json:"version"`
	Commit    string                      `json:"commit"`
	Notes     string                      `json:"notes"`
	Platforms map[string]PlatformArtifact `json:"platforms"`
}

type PlatformArtifact struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

func decodeJSONStrict(data []byte, dest any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dest); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("trailing JSON")
	}
	return nil
}

func verifyEnvelope(raw []byte, key ed25519.PublicKey) (Payload, []byte, error) {
	var envelope Envelope
	if err := decodeJSONStrict(raw, &envelope); err != nil {
		return Payload{}, nil, ErrInvalidSignature
	}
	payloadBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(envelope.Payload))
	if err != nil || len(payloadBytes) == 0 {
		return Payload{}, nil, ErrInvalidSignature
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(envelope.Signature))
	if err != nil || len(signature) != ed25519.SignatureSize {
		return Payload{}, nil, ErrInvalidSignature
	}
	if !ed25519.Verify(key, payloadBytes, signature) {
		return Payload{}, nil, ErrInvalidSignature
	}
	var payload Payload
	if err := decodeJSONStrict(payloadBytes, &payload); err != nil {
		return Payload{}, nil, ErrInvalidSignature
	}
	if err := validatePayload(payload); err != nil {
		return Payload{}, nil, err
	}
	return payload, payloadBytes, nil
}

func validatePayload(payload Payload) error {
	if payload.Schema != payloadSchema {
		return ErrInvalidSignature
	}
	if _, err := parseStableVersion(payload.Version); err != nil {
		return fmt.Errorf("更新版本号无效")
	}
	if !gitSHA.MatchString(strings.TrimSpace(payload.Commit)) {
		return fmt.Errorf("更新提交信息不完整")
	}
	if len(payload.Platforms) == 0 {
		return fmt.Errorf("更新未包含安装包")
	}
	for platform, artifact := range payload.Platforms {
		if !knownPlatform(platform) {
			continue
		}
		if err := validateArtifact(artifact); err != nil {
			return err
		}
	}
	return nil
}

func knownPlatform(platform string) bool {
	switch platform {
	case "darwin-arm64", "darwin-amd64", "windows-amd64", "linux-amd64":
		return true
	default:
		return false
	}
}

func validateArtifact(artifact PlatformArtifact) error {
	parsed, err := url.Parse(strings.TrimSpace(artifact.URL))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return fmt.Errorf("更新包地址无效")
	}
	if !sha256Hex.MatchString(strings.TrimSpace(artifact.SHA256)) {
		return ErrTampered
	}
	if artifact.Size <= 0 {
		return ErrTampered
	}
	if artifact.Size > maxZipTotal {
		return ErrTampered
	}
	return nil
}

func platformArtifact(payload Payload, platform string) (PlatformArtifact, error) {
	artifact, ok := payload.Platforms[platform]
	if !ok {
		return PlatformArtifact{}, ErrWrongPlatform
	}
	if err := validateArtifact(artifact); err != nil {
		return PlatformArtifact{}, err
	}
	return artifact, nil
}

func SignEnvelope(privateKey ed25519.PrivateKey, payload Payload) ([]byte, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return SignEnvelopeBytes(privateKey, payloadBytes)
}

func SignEnvelopeBytes(privateKey ed25519.PrivateKey, payloadBytes []byte) ([]byte, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid private key")
	}
	signature := ed25519.Sign(privateKey, payloadBytes)
	return json.Marshal(Envelope{
		Payload:   base64.StdEncoding.EncodeToString(payloadBytes),
		Signature: base64.StdEncoding.EncodeToString(signature),
	})
}
