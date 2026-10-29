package generation

import (
	"net/http"
	"strings"
	"testing"
)

const preparationFailureFixture = `{"error":{"code":"image_reference_upload_failed","type":"server_error","message":"reference upload failed","metadata":{"submission_state":"not_submitted"}}}`

func TestGatewayReferencePreparationRequiresManagedEndpointAndExactEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, origin, final, method, body string
		status                            int
		want                              bool
	}{
		{"managed", "https://enterprise.beefapi.com/v1/images/edits", "https://enterprise.beefapi.com/v1/images/edits", "POST", preparationFailureFixture, 503, true},
		{"replayed", "https://beeftv.app/v1/images/generations", "https://beeftv.app/v1/images/generations", "POST", preparationFailureFixture, 503, true},
		{"custom-provider", "https://example.com/v1/images/edits", "https://example.com/v1/images/edits", "POST", preparationFailureFixture, 503, false},
		{"redirect", "https://enterprise.beefapi.com/v1/images/edits", "https://example.com/v1/images/edits", "POST", preparationFailureFixture, 503, false},
		{"unknown-result", "https://enterprise.beefapi.com/v1/images/edits", "https://enterprise.beefapi.com/v1/images/edits", "POST", strings.ReplaceAll(preparationFailureFixture, "image_reference_upload_failed", "image_result_unknown"), 503, false},
		{"missing-proof", "https://enterprise.beefapi.com/v1/images/edits", "https://enterprise.beefapi.com/v1/images/edits", "POST", `{"error":{"code":"image_reference_upload_failed"}}`, 503, false},
		{"generic-400", "https://enterprise.beefapi.com/v1/images/edits", "https://enterprise.beefapi.com/v1/images/edits", "POST", `{"error":{"code":"upstream_rejected"}}`, 400, false},
		{"wrong-state", "https://enterprise.beefapi.com/v1/images/edits", "https://enterprise.beefapi.com/v1/images/edits", "POST", strings.ReplaceAll(preparationFailureFixture, "not_submitted", "unknown"), 503, false},
		{"query", "https://enterprise.beefapi.com/v1/images/edits", "https://enterprise.beefapi.com/v1/images/edits", "GET", preparationFailureFixture, 503, false},
		{"other-operation", "https://enterprise.beefapi.com/v1/chat/completions", "https://enterprise.beefapi.com/v1/chat/completions", "POST", preparationFailureFixture, 503, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest(tc.method, tc.origin, nil)
			final, _ := http.NewRequest(tc.method, tc.final, nil)
			resp := &http.Response{StatusCode: tc.status, Request: final}
			if got := gatewayReferenceNotSubmitted(req, resp, []byte(tc.body)); got != tc.want {
				t.Fatalf("proof=%v want=%v", got, tc.want)
			}
		})
	}
}
