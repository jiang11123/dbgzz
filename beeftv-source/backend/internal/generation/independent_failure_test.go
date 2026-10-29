package generation

import (
	"strings"
	"testing"
)

// Independent synthetic probes; copy into generation only after the worker stops.
func TestIndependentAppErrorFallback(t *testing.T) {
	cases := []struct {
		status int
		reason string
		want   FailureCategory
	}{
		{401, "unauthorized", CategoryAuth},
		{429, "", CategoryThrottled},
		{402, "", CategoryQuotaUnknown},
	}
	for _, tc := range cases {
		f := ClassifyAppError(tc.status, tc.status, tc.reason, "opaque failure")
		if f.Category != tc.want {
			t.Errorf("status %d category = %s, want %s", tc.status, f.Category, tc.want)
		}
		if strings.HasPrefix(f.UserMessage(), "生成失败") {
			t.Errorf("status %d retained generic copy after classification: %s", tc.status, f.UserMessage())
		}
	}
}

func TestIndependentPromptFieldsCannotClassifyFailure(t *testing.T) {
	for _, input := range []string{
		`{"error":{"message":"opaque failure"},"prompt":"content safety policy"}`,
		`{"error":{"message":"opaque failure"},"prompt":"invalid parameter"}`,
		`{"error":{"message":"opaque failure"},"request_id":"probe-invalid-parameter-123"}`,
	} {
		f := ClassifyHTTP(503, "Service Unavailable", input)
		if f.Category != CategoryProviderUnavailable {
			t.Errorf("non-error fields changed HTTP 503 classification to %s", f.Category)
		}
	}
}

func TestIndependentAmbiguousModerationDoesNotBlameSingleInput(t *testing.T) {
	message := "Your prompt or reference image was blocked by the content safety policy. Please adjust your prompt or reference image and try again."
	for _, body := range []string{message, `{"error":{"message":"` + message + `"}}`} {
		f := ClassifyHTTP(451, "", body)
		if !f.IsModeration() {
			t.Errorf("451 explicit moderation not recognized: %s", f.Category)
		}
		// Inspect the reason, not action text which may mention both regardless.
		reason := strings.ToLower(f.Reason)
		hasPrompt := strings.Contains(reason, "提示词") || strings.Contains(reason, "prompt")
		hasReference := strings.Contains(reason, "参考") || strings.Contains(reason, "素材") || strings.Contains(reason, "image")
		if hasPrompt != hasReference {
			t.Errorf("ambiguous rejection attributed to one input: %s", f.Reason)
		}
		if strings.Contains(f.UserMessage(), "已退") || strings.Contains(f.UserMessage(), "未扣") {
			t.Error("unsupported billing promise")
		}
	}
}

func TestIndependentHTTPStatusSurvivesHTML(t *testing.T) {
	for status, want := range map[int]FailureCategory{401: CategoryAuth, 402: CategoryQuotaUnknown, 429: CategoryThrottled} {
		f := ClassifyHTTP(status, "", "<html><body>opaque failure</body></html>")
		if f.Category != want {
			t.Errorf("HTTP %d + HTML = %s, want %s", status, f.Category, want)
		}
	}
}

func TestIndependentSpacedCredentialsCannotReachUser(t *testing.T) {
	for _, message := range []string{
		"请求失败 api_key = PROBE_PRIVATE_ALPHA",
		"请求失败 Authorization: Bearer PROBE_PRIVATE_BETA",
		"请求失败 Cookie: session=PROBE_PRIVATE_GAMMA; csrf=PROBE_PRIVATE_DELTA",
		"请求失败 access_token : PROBE_PRIVATE_EPSILON",
		"请求失败 prompt: PROBE_PRIVATE_ZETA more private words",
	} {
		f := ClassifyAppError(400, 400, "invalid_argument", message)
		if strings.Contains(f.UserMessage(), "PROBE_PRIVATE_") {
			t.Error("synthetic sensitive value survived public error sanitization")
		}
	}
}

func TestIndependentPersistedCategoriesRoundTrip(t *testing.T) {
	for _, category := range []FailureCategory{
		CategoryModerationInput, CategoryModerationReference, CategoryModerationOutput,
		CategoryQuotaUser, CategoryQuotaUpstream, CategoryTimeout, CategorySubmissionUncertain,
	} {
		f := Failure{Category: category}
		roundTrip := ClassifyText(f.UserMessage())
		if roundTrip.Category != category {
			t.Errorf("persisted %s changed to %s", category, roundTrip.Category)
		}
	}
}

func TestIndependentExplicitUserQuotaNeedsQuotaAction(t *testing.T) {
	f := ClassifyText(`{"error":{"code":"insufficient_user_quota","message":"user quota exhausted"}}`)
	if f.Category != CategoryQuotaUser {
		t.Errorf("explicit user quota classified %s", f.Category)
	}
	for _, phrase := range []string{"减少同时", "等待已有任务", "并发"} {
		if strings.Contains(f.UserMessage(), phrase) {
			t.Errorf("quota advice confused with concurrency: %s", f.UserMessage())
		}
	}
}
