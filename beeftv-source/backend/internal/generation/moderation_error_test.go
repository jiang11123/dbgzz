package generation_test

import (
	"encoding/json"
	"infinite-canvas/backend/internal/generation"
	"os"
	"testing"
)

func TestModerationContract(t *testing.T) {
	data, err := os.ReadFile("../../../fixtures/moderation-errors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct{ Code, Message, Category, Reason, Action string }
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Code, func(t *testing.T) {
			inputs := []string{fixture.Message}
			for _, code := range []string{fixture.Code, "invalid_request_error", "upstream_error", "400"} {
				raw, _ := json.Marshal(map[string]any{"error": map[string]string{"code": code, "message": fixture.Message}, "request_id": "req_moderation_123"})
				inputs = append(inputs, string(raw))
			}
			codeOnly, _ := json.Marshal(map[string]any{"error": map[string]string{"code": fixture.Code}})
			inputs = append(inputs, string(codeOnly))
			for _, input := range inputs {
				first := generation.ClassifyText(input)
				persisted := generation.ClassifyText(first.UserMessage())
				for _, f := range []generation.Failure{first, persisted} {
					if string(f.Category) != fixture.Category || f.Reason != fixture.Reason || f.Action != fixture.Action || !f.IsModeration() || !f.BlocksAutomaticRetry() || f.Retryable {
						t.Fatalf("input %s: %+v", input, f)
					}
				}
				if persisted.RequestID != first.RequestID {
					t.Fatalf("lost ID: %+v -> %+v", first, persisted)
				}
			}
		})
	}
}

func TestGenericWrapperRefinementPreservesAuthoritativeCodes(t *testing.T) {
	persisted := "生成音频未通过上游版权审核。请调整音乐或音频相关提示词；如使用了参考音频，请检查并更换后重新生成。"
	for typeCode, category := range map[string]generation.FailureCategory{"authentication_error": generation.CategoryAuth, "permission_denied": generation.CategoryPermission} {
		for _, field := range []string{"type", "status"} {
			raw, _ := json.Marshal(map[string]any{"error": map[string]string{field: typeCode, "message": persisted}})
			if got := generation.ClassifyText(string(raw)); got.Category != category {
				t.Fatalf("authoritative type %s: %+v", typeCode, got)
			}
		}
	}
	raw, _ := json.Marshal(map[string]any{"error": map[string]string{"code": "moderation_output", "message": persisted}, "request_id": "req_outer123", "task_id": "task_outer123"})
	if got := generation.ClassifyText(string(raw)); got.RequestID != "req_outer123" || got.TaskID != "task_outer123" {
		t.Fatalf("outer IDs lost: %+v", got)
	}
	if got := generation.ClassifyText("The request failed because the output may contain sensitive information."); got.Category != generation.CategoryModerationOutput {
		t.Fatalf("untyped output: %+v", got)
	}
	for _, tc := range []struct {
		Raw  string
		Want generation.FailureCategory
	}{
		{`{"error":{"code":"invalid_request_error","message":"Rate limit exceeded"}}`, generation.CategoryThrottled},
		{`{"error":{"code":"invalid_api_key","message":"The output audio may be related to copyright restrictions."}}`, generation.CategoryAuth},
		{`{"error":{"code":"invalid_request_error","message":"invalid parameter"},"prompt":"The output audio may be related to copyright restrictions."}`, generation.CategoryInvalidParams},
	} {
		if got := generation.ClassifyText(tc.Raw); got.Category != tc.Want {
			t.Fatalf("%s: %+v", tc.Raw, got)
		}
	}
}
