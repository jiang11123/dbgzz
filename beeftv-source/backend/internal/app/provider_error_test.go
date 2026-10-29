package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNumericProviderErrorRetainsSemanticStatus(t *testing.T) {
	var response imageResponse
	if err := json.Unmarshal([]byte(`{"error":{"code":400,"type":"invalid_request_error","message":"invalid size"}}`), &response); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(response.Error)
	if err != nil {
		t.Fatal(err)
	}
	if message := providerPayloadErrorMessage(string(encoded)); !strings.Contains(message, "参数") {
		t.Fatalf("numeric code erased provider cause: %s", message)
	}
}

func TestBusinessErrorEnvelopesDoNotBecomeSuccessfulMedia(t *testing.T) {
	for _, payload := range []map[string]any{
		{"error": "content safety policy blocked the request"},
		{"success": false, "message": "generation failed"},
		{"error": map[string]any{"code": "prompt_blocked"}},
	} {
		if _, _, failed := providerPayloadBusinessFailure(payload); !failed {
			t.Fatalf("business error treated as success: %#v", payload)
		}
	}
	if _, _, failed := providerPayloadBusinessFailure(map[string]any{"code": 200, "data": map[string]any{"task_id": "task-123"}}); failed {
		t.Fatal("successful 200 envelope rejected")
	}
}

func TestProviderFailureDetailsReadsTopLevelModerationError(t *testing.T) {
	code, message := providerFailureDetails(map[string]any{
		"code":    contentModerationErrorCode,
		"message": "prompt rejected",
	})
	if code != contentModerationErrorCode {
		t.Fatalf("unexpected code: %q", code)
	}
	if message != "prompt rejected" {
		t.Fatalf("unexpected message: %q", message)
	}
}

func TestProviderFailureDetailsReadsNestedError(t *testing.T) {
	code, message := providerFailureDetails(map[string]any{
		"error": map[string]any{"code": "invalid_request", "message": "invalid size"},
	})
	if code != "invalid_request" || message != "invalid size" {
		t.Fatalf("unexpected failure details: code=%q message=%q", code, message)
	}
}

func TestProviderFailureDetailsPrefersNestedBusinessCode(t *testing.T) {
	code, message := providerFailureDetails(map[string]any{
		"code": float64(400),
		"data": map[string]any{"code": contentModerationErrorCode, "message": "prompt rejected"},
	})
	if code != contentModerationErrorCode || message != "prompt rejected" {
		t.Fatalf("unexpected wrapped failure details: code=%q message=%q", code, message)
	}
}

func TestContentModerationFailureRequiresExactProviderCode(t *testing.T) {
	if !isContentModerationFailure(`{"code":"sensitive_words_detected"}`) {
		t.Fatal("expected moderation error to be detected")
	}
	if isContentModerationFailure("上游 HTTP 400") {
		t.Fatal("generic HTTP 400 must remain retryable")
	}
}

func TestProviderPayloadBusinessFailureRecognizesStringErrorCode(t *testing.T) {
	code, message, failed := providerPayloadBusinessFailure(map[string]any{
		"code": "RequestParameterIsWrong",
		"data": nil,
		"msg":  "参数: prompt 的长度: 23142 大于最大长度 10000",
	})
	if !failed || code != "RequestParameterIsWrong" || message != "参数: prompt 的长度: 23142 大于最大长度 10000" {
		t.Fatalf("business failure = (%q, %q, %v)", code, message, failed)
	}
}

func TestProviderPayloadBusinessFailureAcceptsStringSuccessCode(t *testing.T) {
	if code, message, failed := providerPayloadBusinessFailure(map[string]any{"code": "Success", "data": map[string]any{"task_id": "task-1"}}); failed {
		t.Fatalf("success payload was marked failed: (%q, %q)", code, message)
	}
}
