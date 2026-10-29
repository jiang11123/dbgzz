package generation_test

import (
	"infinite-canvas/backend/internal/generation"
	"strings"
	"testing"
)

func TestVODSafetyRejectionCopy(t *testing.T) {
	if failure := generation.ClassifyText("VOD image task failed [RequestLimitExceeded]: opaque"); failure.Category != generation.CategoryConcurrency {
		t.Fatalf("capacity mistaken for input size: %+v", failure)
	}
	for _, raw := range []string{
		"VOD image task failed: task failed with status: FAIL, message: recv from gpt image edit api failed. http_code:400, message:Your request was rejected by the safety system. If you believe this is an error, contact us at Azure support ticket",
		"VOD image task failed [ContentModerationFailed]: opaque",
		"VOD image task failed [InvalidParameter.VoilationContent]: opaque",
		"Your request was rejected as a result of our safety system.",
		`{"error":{"code":"ContentModerationFailed","message":"opaque"}}`,
		`{"error":{"code":"InvalidParameter.VoilationContent","message":"opaque"}}`,
	} {
		failure := generation.ClassifyText(raw)
		if failure.Category != generation.CategoryModerationInput || failure.Retryable || !strings.Contains(failure.Reason, "内容安全审核") {
			t.Fatalf("%q: %+v", raw, failure)
		}
	}
	for _, raw := range []string{"safety system unavailable", `{"error":{"code":"invalid_api_key","message":"Your request was rejected by the safety system."}}`, `{"prompt":"Your request was rejected by the safety system."}`} {
		if failure := generation.ClassifyText(raw); failure.Category == generation.CategoryModerationInput {
			t.Fatalf("false positive %q: %+v", raw, failure)
		}
	}
}
