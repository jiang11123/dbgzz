package assistantruntime

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
)

// InstanceHeader is the supervisor-to-child identity header. The secret nonce
// is never written to health JSON, responses, or logs.
const InstanceHeader = "X-Beeftv-Instance-Nonce"

func randomNonce() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// InstanceProof is the public health field that proves the child holds the
// supervisor nonce without revealing it.
func InstanceProof(nonce string) string {
	if nonce == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(nonce))
	return hex.EncodeToString(sum[:8])
}

func applyInstanceHeaders(req *http.Request, token, nonce string) {
	if req == nil {
		return
	}
	if token != "" {
		req.Header.Set("X-Beeftv-Agent-Token", token)
	}
	if nonce != "" {
		req.Header.Set(InstanceHeader, nonce)
	}
}
