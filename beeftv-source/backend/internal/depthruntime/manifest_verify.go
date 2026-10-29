package depthruntime

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

type signedManifestEnvelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

func decodeManifestJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("清单包含多余内容")
	}
	return nil
}

func verifySignedManifest(raw []byte, public ed25519.PublicKey) (Manifest, error) {
	if len(public) != ed25519.PublicKeySize {
		return Manifest{}, errors.New("缺少可信的深度组件公钥")
	}
	var envelope signedManifestEnvelope
	if err := decodeManifestJSON(raw, &envelope); err != nil {
		return Manifest{}, fmt.Errorf("深度组件签名封装无效: %w", err)
	}
	payload, payloadErr := base64.StdEncoding.DecodeString(strings.TrimSpace(envelope.Payload))
	signature, signatureErr := base64.StdEncoding.DecodeString(strings.TrimSpace(envelope.Signature))
	if payloadErr != nil || signatureErr != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(public, payload, signature) {
		return Manifest{}, errors.New("深度组件清单签名验证失败")
	}
	var manifest Manifest
	if err := decodeManifestJSON(payload, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("深度组件清单内容无效: %w", err)
	}
	if manifest.Version != 2 || len(manifest.Runtimes) == 0 {
		return Manifest{}, errors.New("深度组件清单版本或运行包为空")
	}
	return manifest, nil
}

// VerifyManifest uses the same trust contract in the release gate and installer.
func VerifyManifest(raw []byte, public ed25519.PublicKey) (Manifest, error) {
	return verifySignedManifest(raw, public)
}
