package generation_test

import (
	"encoding/json"
	"fmt"
	"infinite-canvas/backend/internal/generation"
	"os"
	"testing"
)

func TestVODImageErrorContract(t *testing.T) {
	if got := generation.ClassifyText(`{"error":{"code":"access_denied","message":"你的请求触发了上游内容安全策略，类别：内容安全。本次请求已被上游拒绝。"}}`); !got.IsModeration() {
		t.Fatalf("legacy gateway moderation lost: %+v", got)
	}
	if got := generation.ClassifyText("VOD image task failed [ModelGenerateFailed]: Your request was rejected by the safety system."); !got.IsModeration() {
		t.Fatalf("legacy generic model safety lost: %+v", got)
	}
	var contract struct {
		Copies map[string]struct {
			Category       generation.FailureCategory
			Reason, Action string
			Uncertain      bool
		}
		Cases map[string]map[string]string
	}
	data, err := os.ReadFile("../../../fixtures/vod-image-errors.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	check := func(t *testing.T, raw, key string) {
		t.Helper()
		want := contract.Copies[key]
		got := generation.ClassifyText(raw)
		if got.Category != want.Category || got.Reason != want.Reason || got.Action != want.Action || got.Uncertain != want.Uncertain {
			t.Fatalf("%q: got %+v; want %+v", raw, got, want)
		}
		saved := generation.ClassifyText(got.UserMessage())
		if saved.Reason != got.Reason || saved.Action != got.Action || saved.Uncertain != got.Uncertain {
			t.Fatalf("persistence lost copy: %+v -> %+v", got, saved)
		}
	}
	for stage, codes := range contract.Cases {
		for code, key := range codes {
			t.Run(stage+"/"+code, func(t *testing.T) {
				text := fmt.Sprintf("VOD %s: opaque", code)
				if stage == "task" {
					text = fmt.Sprintf("VOD image task failed [%s]: opaque", code)
				}
				check(t, text, key)
				for _, wrapper := range []string{"", "unknown", "failed", "badrequest", "api_error", "upstream_error", "upstream_rejected", "invalid_request", "invalid_request_error", "invalid_parameter", "invalidparameter", "invalid_argument", "bad_response", "bad_response_body", "400", "401", "403", "500", "502", "503"} {
					check(t, fmt.Sprintf(`{"error":{"code":%q,"message":%q}}`, wrapper, text), key)
				}
			})
		}
	}
	for key, copy := range contract.Copies {
		t.Run("gateway/"+key, func(t *testing.T) {
			code := "vod_image_" + key
			if key == "moderation" {
				code = "content_policy_violation"
			}
			text := copy.Reason + "。" + copy.Action + "。"
			check(t, fmt.Sprintf(`{"error":{"code":%q,"message":%q}}`, code, text), key)
			if copy.Uncertain {
				check(t, fmt.Sprintf(`{"error":{"code":"image_result_unknown","message":%q}}`, text), key)
			}
		})
	}
	for _, text := range []string{"VOD image task failed [TaskTimeout]: opaque", "图片任务执行超时。请联系支持查询原任务结果，不要立即重新生成。"} {
		if got := generation.ClassifyText(fmt.Sprintf(`{"error":{"code":"invalid_api_key","message":%q}}`, text)); got.Category != generation.CategoryAuth {
			t.Fatalf("authoritative auth replaced: %+v", got)
		}
		if got := generation.ClassifyText(fmt.Sprintf(`{"prompt":%q}`, text)); got.Category != generation.CategoryUnknown {
			t.Fatalf("prompt echo classified: %+v", got)
		}
	}
}
