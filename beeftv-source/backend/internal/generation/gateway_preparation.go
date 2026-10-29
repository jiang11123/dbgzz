package generation

import (
	"encoding/json"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/providerpreset"
)

// Only the managed gateway can attest that its reference preparation failed
// before forwarding a paid create. A generic 400/5xx or an untrusted provider
// repeating this code remains submission-uncertain.
func gatewayReferenceNotSubmitted(req *http.Request, resp *http.Response, body []byte) bool {
	if req == nil || req.URL == nil || resp == nil || resp.Request == nil || resp.Request.URL == nil || req.Method != http.MethodPost || resp.StatusCode != http.StatusServiceUnavailable || len(body) > 16384 {
		return false
	}
	if !providerpreset.IsBeefAPIEndpoint(req.URL.String()) || !providerpreset.IsBeefAPIEndpoint(resp.Request.URL.String()) {
		return false
	}
	if !strings.HasSuffix(req.URL.Path, "/images/edits") && !strings.HasSuffix(req.URL.Path, "/images/generations") {
		return false
	}
	var receipt struct {
		Error struct {
			Code     string `json:"code"`
			Metadata struct {
				State string `json:"submission_state"`
			} `json:"metadata"`
		} `json:"error"`
	}
	return json.Unmarshal(body, &receipt) == nil && receipt.Error.Code == "image_reference_upload_failed" && receipt.Error.Metadata.State == "not_submitted"
}
