package generation

import "testing"

func TestNestedErrorPreservesAuthorityAndIDs(t *testing.T) {
	for _, code := range []string{"401", "invalid_api_key"} {
		got := ClassifyText(`{"code":"` + code + `","request_id":"req_outer123","message":"{\"error\":{\"code\":\"model_temporarily_unavailable\",\"request_id\":\"req_inner123\"}}"}`)
		baseline := ClassifyText(`{"code":"` + code + `","request_id":"req_outer123"}`)
		if got.Category != baseline.Category || got.Category == CategoryProviderUnavailable || got.RequestID != "req_outer123" {
			t.Fatalf("outer authority lost: %#v", got)
		}
	}
	got := ClassifyText(`{"code":"upstream_error","request_id":"req_outer123","message":"{\"error\":{\"code\":\"model_temporarily_unavailable\",\"request_id\":\"req_inner123\"}}"}`)
	if got.Category != CategoryProviderUnavailable || got.RequestID != "req_outer123" {
		t.Fatalf("nested error or outer ID lost: %#v", got)
	}
}
