package generation_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/generation"
)

func TestNoAvailableChannelIsNotUserRateLimiting(t *testing.T) {
	for _, message := range []string{"暂无可用渠道", "分组 Gemini 下模型 gemini-3.7-flash 无可用渠道（distributor）"} {
		body, _ := json.Marshal(map[string]any{"error": map[string]any{"code": "upstream_crowded", "message": message}})
		failure := generation.ClassifyHTTP(503, "", string(body))
		if failure.Category != generation.CategoryProviderUnavailable {
			t.Fatalf("no channel misclassified: %#v", failure)
		}
	}
}

func TestOutboundPolicyErrorsHaveActionableCopyAndDiagnostics(t *testing.T) {
	for _, message := range []string{
		"不允许访问本机或内网地址", "不允许访问本机、内网或链路本地地址",
		"不允许访问保留地址或特殊用途地址", "不允许访问链路本地、未指定或组播地址",
		"外部服务域名解析失败",
	} {
		raw := message + "。HTTP 400。排查编号：任务 job-outbound · 请求 req-outbound。"
		for _, failure := range []generation.Failure{
			generation.ClassifyText(raw), generation.ClassifyAppError(400, 400, "invalid_argument", raw),
		} {
			if failure.Category != generation.CategoryNetwork || failure.HTTPStatus != 400 || failure.RequestID != "req-outbound" || failure.TaskID != "job-outbound" {
				t.Fatalf("lost classification or diagnostics for %q: %+v", message, failure)
			}
			if strings.Contains(failure.Action, "CANVAS_ALLOW_PRIVATE_UPSTREAMS") {
				t.Fatalf("unsafe global bypass advice: %+v", failure)
			}
			if strings.Contains(message, "链路本地、未指定") {
				if !strings.Contains(failure.Action, "允许列表也不能放行") || strings.Contains(failure.Action, "仅将该主机") {
					t.Fatalf("metadata block should not suggest an allowlist bypass: %+v", failure)
				}
			} else if strings.Contains(message, "不允许") && (!strings.Contains(failure.Action, "管理员") || !strings.Contains(failure.Action, "仅将该主机")) {
				t.Fatalf("missing bounded administrator guidance: %+v", failure)
			}
			if strings.Contains(message, "解析失败") && !strings.Contains(failure.Action, "域名是否正确") {
				t.Fatalf("missing DNS guidance: %+v", failure)
			}
		}
	}
}

func TestOutboundPolicyCopyDoesNotOverrideStructuredProviderErrors(t *testing.T) {
	for _, raw := range []string{
		`{"error":{"code":"invalid_api_key","message":"不允许访问本机或内网地址"},"request_id":"req-auth","task_id":"job-auth"}`,
		`{"error":{"code":"invalid_api_key","message":"invalid key"},"prompt":"外部服务域名解析失败","request_id":"req-auth","task_id":"job-auth"}`,
	} {
		failure := generation.ClassifyAppError(401, 401, "invalid_api_key", raw)
		if failure.Category != generation.CategoryAuth || failure.HTTPStatus != 401 || failure.RequestID != "req-auth" || failure.TaskID != "job-auth" {
			t.Fatalf("structured provider error overwritten: %+v", failure)
		}
	}
	if failure := generation.ClassifyText(`{"prompt":"不允许访问本机或内网地址"}`); failure.Category != generation.CategoryUnknown {
		t.Fatalf("request echo classified as local policy failure: %+v", failure)
	}
}

func TestLocalDatabaseFailuresNeverBlameModelParameters(t *testing.T) {
	for _, message := range []string{"table tasks has no column named failure_diagnostics", "no such column: failure_diagnostics", "no such table: tasks", "database is locked", "attempt to write a readonly database", "disk I/O error", "UNIQUE constraint failed: tasks.id", "NOT NULL constraint failed: tasks.type", "CHECK constraint failed: task_status", "FOREIGN KEY constraint failed"} {
		for _, failure := range []generation.Failure{generation.ClassifyText(message), generation.ClassifyAppError(400, 400, "invalid_argument", message), generation.ClassifyHTTP(500, "", message), generation.ClassifyText(fmt.Sprintf(`{"error":{"code":"invalid_argument","message":%q}}`, message))} {
			if string(failure.Category) != "local_storage" || failure.Retryable || !failure.BlocksAutomaticRetry() || !strings.Contains(failure.UserMessage(), "数据库") || strings.Contains(failure.UserMessage(), "failure_diagnostics") {
				t.Errorf("%q: %+v; display=%s", message, failure, failure.UserMessage())
			}
		}
	}
}

func TestLocalDatabaseClassificationPreservesProviderParameters(t *testing.T) {
	for _, echo := range []string{"UNIQUE constraint failed: tasks.id", "NOT NULL constraint failed: tasks.type", "CHECK constraint failed: task_status", "FOREIGN KEY constraint failed"} {
		if got := generation.ClassifyText(fmt.Sprintf(`{"error":{"code":"invalid_parameter","message":"invalid size"},"prompt":%q}`, echo)); got.Category != generation.CategoryInvalidParams {
			t.Errorf("request echo changed classification: %+v", got)
		}
	}
	for _, raw := range []string{`{"error":{"code":"invalid_parameter","message":"invalid size"},"prompt":"table tasks has no column named failure_diagnostics"}`, `{"error":{"code":"invalid_parameter","message":"invalid size"}}`} {
		if got := generation.ClassifyText(raw); got.Category != generation.CategoryInvalidParams {
			t.Errorf("provider parameter failure changed: %+v", got)
		}
	}
	failure := generation.ClassifyAppError(500, 500, "local_storage", "")
	if failure.Category != generation.CategoryLocalStorage || generation.ClassifyText(failure.UserMessage()).Category != generation.CategoryLocalStorage {
		t.Errorf("stable reason or persisted copy lost: %+v", failure)
	}
}

func TestGatewayReferenceGeometryAndRequestSize(t *testing.T) {
	height := `{"error":{"code":"400","message":"Height must be between 300px and 6000px","type":"api_error"}} (request id: 202609270829245377912978268d9d6USz1NP3R)`
	failure := generation.ClassifyText(height)
	if failure.Category != generation.CategoryInvalidParams || !strings.Contains(failure.Action, "300–6000 像素") || failure.RequestID == "" {
		t.Fatalf("height failure: %+v", failure)
	}
	if strings.Contains(failure.UserMessage(), "{") || strings.Contains(failure.UserMessage(), "api_error") {
		t.Fatalf("raw json leaked: %q", failure.UserMessage())
	}
	aspect := generation.ClassifyText(`{"error":{"message":"aspect ratio must be between 0.4 and 2.5"}}`)
	if aspect.Category != generation.CategoryInvalidParams || !strings.Contains(aspect.Action, "0.4–2.5") {
		t.Fatalf("aspect failure: %+v", aspect)
	}
	request := generation.ClassifyText(`{"error":{"message":"Request entity too large"}}`)
	if request.Category != generation.CategoryInputTooLarge || !strings.Contains(request.Reason, "整次请求") {
		t.Fatalf("request size failure: %+v", request)
	}
	file := generation.ClassifyText(`{"error":{"message":"image file too large"}}`)
	if file.Category != generation.CategoryInputTooLarge || !strings.Contains(file.Reason, "单个参考文件") {
		t.Fatalf("file size failure: %+v", file)
	}
	persisted := generation.ClassifyText("第 1 张参考图高度为 200 像素，需要 300–6000 像素；请调整尺寸或更换后再提交")
	if persisted.Category != generation.CategoryInvalidParams || !strings.Contains(persisted.Reason, "第 1 张") {
		t.Fatalf("persisted height: %+v", persisted)
	}
}

func TestGatewayReferenceDurationWithRequestSuffix(t *testing.T) {
	raw := `{"error":{"code":"400","message":"素材转换失败: Duration must be between 1.8s and 30.2s.","type":"api_error"}} (request id: 202609270829245377912978268d9d6USz1NP3R)`
	f := generation.ClassifyText(raw)
	if f.Category != generation.CategoryInvalidParams || f.RequestID != "202609270829245377912978268d9d6USz1NP3R" || !strings.Contains(f.Action, "1.8–30.2 秒") || f.Reason != "参考素材时长不符合模型要求" {
		t.Fatalf("unexpected failure: %+v", f)
	}
	if !f.BlocksAutomaticRetry() {
		t.Fatal("unchanged invalid input must not retry")
	}
}

func TestClassifyHTTPUsesStructuredCodeBeforeStatus(t *testing.T) {
	failure := generation.ClassifyHTTP(http.StatusPaymentRequired, "402 Payment Required", `{"error":{"message":"Your prompt or reference image was blocked by the content safety policy. Please adjust your prompt or reference image and try again.","code":"content_policy_violation"}}`)
	if failure.Category != generation.CategoryModerationInput && failure.Category != generation.CategoryModerationReference {
		t.Fatalf("402 with safety body category = %s", failure.Category)
	}
	if !strings.Contains(failure.UserMessage(), "内容安全审核") {
		t.Fatalf("user message = %q", failure.UserMessage())
	}
}

func TestClassifyHTTP402WithoutBodyIsUnknownBilling(t *testing.T) {
	failure := generation.ClassifyHTTP(http.StatusPaymentRequired, "402 Payment Required", "")
	if failure.Category != generation.CategoryQuotaUnknown {
		t.Fatalf("category = %s", failure.Category)
	}
	message := failure.UserMessage()
	if strings.Contains(message, "余额") || strings.Contains(message, "退还") || strings.Contains(message, "积分") {
		t.Fatalf("402 assumed user balance: %q", message)
	}
	if !strings.Contains(message, "计费或额度") {
		t.Fatalf("user message = %q", message)
	}
}

func TestClassifyHTTP451AloneIsNotSafety(t *testing.T) {
	failure := generation.ClassifyHTTP(451, "451 Unavailable For Legal Reasons", "")
	if failure.IsModeration() {
		t.Fatalf("bare 451 classified as moderation: %+v", failure)
	}
}

func TestClassifyHTTP451SafetyBody(t *testing.T) {
	body := "Your prompt or reference image was blocked by the content safety policy. Please adjust your prompt or reference image and try again."
	failure := generation.ClassifyHTTP(451, "451 Unavailable For Legal Reasons", body)
	if !failure.IsModeration() {
		t.Fatalf("451 safety body category = %s", failure.Category)
	}
	if !strings.Contains(failure.UserMessage(), "请调整提示词或参考素材") {
		t.Fatalf("user message = %q", failure.UserMessage())
	}
}

func TestClassifyHTTP429QuotaVersusRate(t *testing.T) {
	quota := generation.ClassifyHTTP(429, "429 Too Many Requests", `{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}`)
	if quota.Category != generation.CategoryQuotaUnknown {
		t.Fatalf("quota 429 category = %s", quota.Category)
	}
	rate := generation.ClassifyHTTP(429, "429 Too Many Requests", `{"error":{"code":"rate_limit_exceeded","message":"Rate limit reached"}}`)
	if rate.Category != generation.CategoryThrottled {
		t.Fatalf("rate 429 category = %s", rate.Category)
	}
	bare := generation.ClassifyHTTP(429, "429 Too Many Requests", "")
	if bare.Category != generation.CategoryThrottled {
		t.Fatalf("bare 429 category = %s", bare.Category)
	}
}

func TestClassifyProviderJSONShapes(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		body     string
		category generation.FailureCategory
		contains string
	}{
		{name: "openai", status: 400, body: `{"error":{"message":"Invalid size","type":"invalid_request_error","param":"size","code":"invalid_request"},"request_id":"req_abc123"}`, category: generation.CategoryInvalidParams, contains: "参数"},
		{name: "gemini", status: 400, body: `{"error":{"code":400,"message":"API key not valid","status":"UNAUTHENTICATED"}}`, category: generation.CategoryAuth, contains: "鉴权"},
		{name: "dashscope", status: 400, body: `{"code":"InvalidParameter","message":"url error, please check url！","request_id":"req-dash-1"}`, category: generation.CategoryInputInaccessible, contains: "参考素材无法读取"},
		{name: "newapi", status: 200, body: `{"code":"RequestParameterIsWrong","data":null,"msg":"参数: prompt 的长度: 23142 大于最大长度 10000"}`, category: generation.CategoryContextTooLong, contains: "长度限制"},
		{name: "gemini-feedback", status: 200, body: `{"promptFeedback":{"blockReason":"SAFETY"}}`, category: generation.CategoryModerationInput, contains: "内容安全审核"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			failure := generation.ClassifyHTTP(tt.status, "", tt.body)
			if failure.Category != tt.category {
				t.Fatalf("category = %s want %s message=%q", failure.Category, tt.category, failure.UserMessage())
			}
			if !strings.Contains(failure.UserMessage(), tt.contains) {
				t.Fatalf("message = %q want %q", failure.UserMessage(), tt.contains)
			}
		})
	}
}

func TestClassifyDoesNotLeakSecretsOrRawPayload(t *testing.T) {
	body := `{"error":{"message":"blocked by content policy prompt=secret-words api-key=sk-live-secret https://cdn.example.com/file?signature=abc","code":"content_policy_violation"},"request_id":"secret-trace"}`
	message := generation.ClassifyHTTP(400, "", body).UserMessage()
	for _, leaked := range []string{"sk-live-secret", "api-key", "secret-words", "https://cdn.example.com", "signature=", "secret-trace", `{"error"`} {
		if strings.Contains(message, leaked) {
			t.Fatalf("leaked %q in %q", leaked, message)
		}
	}
}

func TestClassifyDoesNotTreatRequestIDNumbersAsHTTP(t *testing.T) {
	failure := generation.ClassifyText(`{"error":{"message":"task 402 failed internally","code":"internal_error"},"request_id":"402"}`)
	if failure.Category == generation.CategoryQuotaUnknown {
		t.Fatalf("request id 402 became billing: %+v", failure)
	}
}

func TestClassifyUnknownFieldsStayUnknown(t *testing.T) {
	failure := generation.ClassifyHTTP(400, "", `{"error":{"mystery":true,"trace":"private"}}`)
	if failure.Category != generation.CategoryInvalidParams {
		t.Fatalf("400 unknown json category = %s", failure.Category)
	}
	if strings.Contains(failure.UserMessage(), "private") || strings.Contains(failure.UserMessage(), "mystery") {
		t.Fatalf("unknown fields leaked: %q", failure.UserMessage())
	}
}

func TestClassifyNonJSONAndHTML(t *testing.T) {
	htmlFailure := generation.ClassifyHTTP(502, "502 Bad Gateway", "<!DOCTYPE html><html><body>nginx 502</body></html>")
	if htmlFailure.Category != generation.CategoryProviderUnavailable {
		t.Fatalf("html 502 category = %s", htmlFailure.Category)
	}
	if strings.Contains(htmlFailure.UserMessage(), "nginx") || strings.Contains(htmlFailure.UserMessage(), "<html") {
		t.Fatalf("html leaked: %q", htmlFailure.UserMessage())
	}
	malformed := generation.ClassifyText("接口返回非 JSON 内容：text/html")
	if malformed.Category != generation.CategoryMalformedResponse {
		t.Fatalf("malformed category = %s", malformed.Category)
	}
}

func TestClassifyWrappedAndDownloadErrors(t *testing.T) {
	httpErr := generation.HTTPError{StatusCode: 502, Status: "502 Bad Gateway", Body: "Bad Gateway"}
	wrapped := generation.ClassifyError(wrapError("视频任务创建失败", httpErr))
	if wrapped.Category != generation.CategoryProviderUnavailable {
		t.Fatalf("wrapped 502 category = %s message=%q", wrapped.Category, wrapped.UserMessage())
	}
	download := generation.WithDownloadFailure(generation.ClassifyHTTP(502, "", ""), "provider-task-1")
	if download.Category != generation.CategoryDownloadFailed {
		t.Fatalf("download category = %s", download.Category)
	}
	if !download.BlocksAutomaticRetry() {
		t.Fatal("download should block automatic retry")
	}
}

type wrappedError struct {
	prefix string
	err    error
}

func wrapError(prefix string, err error) error {
	return wrappedError{prefix: prefix, err: err}
}

func (e wrappedError) Error() string { return e.prefix + "：" + e.err.Error() }
func (e wrappedError) Unwrap() error { return e.err }

func TestClassifyPendingAndCancel(t *testing.T) {
	pending := generation.ClassifyError(generation.StatePendingError{TaskID: "task-safe-1", Cause: generation.HTTPError{StatusCode: 400, Body: `{"code":"task_not_exist"}`}})
	if pending.Category != generation.CategorySubmissionUncertain {
		t.Fatalf("pending category = %s", pending.Category)
	}
	if !pending.BlocksAutomaticRetry() {
		t.Fatal("pending should block automatic retry")
	}
	if errors.Is(context.Canceled, context.Canceled) {
		canceled := generation.ClassifyError(context.Canceled)
		if canceled.Category != generation.CategoryCancelled {
			t.Fatalf("cancel category = %s", canceled.Category)
		}
	}
}

func TestClassify2xxBusinessError(t *testing.T) {
	failure := generation.ClassifyText(`{"code":"sensitive_words_detected","message":"prompt rejected"}`)
	if failure.Category != generation.CategoryModerationInput {
		t.Fatalf("2xx moderation category = %s", failure.Category)
	}
}

func TestHTTPErrorErrorUsesBody(t *testing.T) {
	message := (generation.HTTPError{StatusCode: 451, Body: "Your prompt or reference image was blocked by the content safety policy."}).Error()
	if !strings.Contains(message, "内容安全审核") {
		t.Fatalf("HTTPError.Error() = %q", message)
	}
	generic := (generation.HTTPError{StatusCode: http.StatusPaymentRequired, Body: ""}).Error()
	if !strings.Contains(generic, "计费或额度") {
		t.Fatalf("402 HTTPError.Error() = %q", generic)
	}
}

func TestLikenessCodeNotPromptWording(t *testing.T) {
	echoed := generation.ClassifyText(`{"error":{"message":"invalid parameter: prompt=生成油画肖像"}}`)
	if echoed.Category != generation.CategoryInvalidParams {
		t.Fatalf("echoed portrait category = %s", echoed.Category)
	}
	if strings.Contains(echoed.UserMessage(), "真人形象") {
		t.Fatalf("echoed portrait became likeness: %q", echoed.UserMessage())
	}
	coded := generation.ClassifyText(`{"error":{"code":"InputImageSensitiveContentDetected.PrivacyInformation","message":"blocked by content policy"}}`)
	if !strings.Contains(coded.UserMessage(), "真人形象") {
		t.Fatalf("privacy code message = %q", coded.UserMessage())
	}
}

func TestThinkingModeToolChoice(t *testing.T) {
	failure := generation.ClassifyHTTP(400, "", `{"error":{"message":"Thinking mode does not support this tool_choice","request_id":"req_think1"}}`)
	if !strings.Contains(failure.UserMessage(), "不支持强制工具调用") {
		t.Fatalf("message = %q", failure.UserMessage())
	}
}

func TestBeefAPIErrorCodeInventory(t *testing.T) {
	data, err := os.ReadFile("../../../fixtures/generation-error-codes.json")
	if err != nil {
		t.Fatal(err)
	}
	var inventory map[string]generation.FailureCategory
	if err := json.Unmarshal(data, &inventory); err != nil {
		t.Fatal(err)
	}
	if len(inventory) != 53 {
		t.Fatalf("BeefAPI error code inventory has %d entries, want 53", len(inventory))
	}
	for code, category := range inventory {
		t.Run(code, func(t *testing.T) {
			for _, status := range []int{200, 400, 402, 429, 503} {
				body := fmt.Sprintf(`{"error":{"code":%q,"message":"opaque failure"}}`, code)
				failure := generation.ClassifyHTTP(status, "", body)
				if failure.Category != category || !failure.FromCode || failure.ProviderCode != code {
					t.Errorf("HTTP %d code %s: got category=%s fromCode=%v code=%q; want %s", status, code, failure.Category, failure.FromCode, failure.ProviderCode, category)
				}
			}
		})
	}
}

func TestCanonicalCategoriesRoundTripAndRetryPolicy(t *testing.T) {
	categories := []generation.FailureCategory{
		generation.CategoryAuth, generation.CategoryPermission, generation.CategoryQuotaUser,
		generation.CategoryQuotaUpstream, generation.CategoryQuotaUnknown,
		generation.CategoryModerationInput, generation.CategoryModerationReference, generation.CategoryModerationOutput,
		generation.CategoryInvalidParams, generation.CategoryContextTooLong,
		generation.CategoryInputInaccessible, generation.CategoryInputTooLarge, generation.CategoryModelMissing,
		generation.CategoryThrottled, generation.CategoryConcurrency, generation.CategoryProviderUnavailable,
		generation.CategoryNetwork, generation.CategoryRequestNotSent, generation.CategoryTimeout, generation.CategorySubmissionUncertain,
		generation.CategoryAsyncFailed, generation.CategoryCancelled, generation.CategoryPartialSuccess,
		generation.CategoryDownloadFailed, generation.CategoryResultsMissing,
		generation.CategoryMalformedResponse, generation.CategoryUnknown,
	}
	for _, category := range categories {
		t.Run(string(category), func(t *testing.T) {
			body := fmt.Sprintf(`{"error":{"code":%q,"message":"opaque failure"}}`, category)
			coded := generation.ClassifyHTTP(400, "", body)
			if coded.Category != category || !coded.FromCode {
				t.Fatalf("canonical code %s became %+v", category, coded)
			}
			persisted := generation.ClassifyText((generation.Failure{Category: category}).UserMessage())
			if persisted.Category != category {
				t.Errorf("persisted category = %s, want %s", persisted.Category, category)
			}
			allowAutomaticRetry := category == generation.CategoryThrottled || category == generation.CategoryConcurrency || category == generation.CategoryProviderUnavailable || category == generation.CategoryCancelled || category == generation.CategoryRequestNotSent
			if coded.BlocksAutomaticRetry() == allowAutomaticRetry {
				t.Errorf("automatic retry block = %v, allowed = %v", coded.BlocksAutomaticRetry(), allowAutomaticRetry)
			}
			coded.Uncertain = true
			if !coded.BlocksAutomaticRetry() {
				t.Error("uncertain result allowed automatic resubmission")
			}
		})
	}
}

func TestStructuredUnknownDoesNotReadRequestEchoes(t *testing.T) {
	for _, body := range []string{
		`{"prompt":"content safety policy"}`,
		`{"error":{"message":"opaque"},"prompt":"invalid parameter"}`,
		`{"error":{"mystery":true},"data":{"prompt":"invalid parameter"}}`,
		`{"error":{"message":"opaque"},"request_id":"req_invalid_parameter_123"}`,
		`{"error":{"message":"opaque prompt=content safety policy"}}`,
		`[{"prompt":"content safety policy"}]`,
		`{"padding":"` + strings.Repeat("x", 17<<10) + `","prompt":"content safety policy"}`,
	} {
		failure := generation.ClassifyHTTP(503, "", body)
		if failure.Category != generation.CategoryProviderUnavailable {
			t.Errorf("request echo classified as %s", failure.Category)
		}
	}
}

func TestSensitiveAssignmentsAreRemovedBeforeChineseFallback(t *testing.T) {
	for _, message := range []string{
		"请求失败 api_key = PROBE_PRIVATE_ALPHA",
		`请求失败 "api_key" : "PROBE_PRIVATE_ALPHA with spaces"`,
		"请求失败 Authorization: Bearer PROBE_PRIVATE_BETA",
		"请求失败 Cookie : session=PROBE_PRIVATE_GAMMA; csrf=PROBE_PRIVATE_DELTA",
		"请求失败 access_token : PROBE_PRIVATE_EPSILON",
		"请求失败 prompt: PROBE_PRIVATE_ZETA more private words",
		"请求失败 提示词: PROBE_PRIVATE_ZETA more private words",
	} {
		body, err := json.Marshal(map[string]any{"error": map[string]string{"message": message}})
		if err != nil {
			t.Fatal(err)
		}
		for _, failure := range []generation.Failure{
			generation.ClassifyText(message),
			generation.ClassifyText(string(body)),
			generation.ClassifyAppError(400, 400, "invalid_argument", message),
		} {
			if strings.Contains(failure.UserMessage()+failure.ProviderMessage, "PROBE_PRIVATE_") || strings.Contains(failure.UserMessage()+failure.ProviderMessage, "more private words") {
				t.Errorf("sensitive assignment was not fully removed")
			}
		}
	}
	keyFailure := generation.ClassifyText(`{"error":{"code":"invalid_api_key"}}`)
	if keyFailure.ProviderCode != "invalid_api_key" {
		t.Fatalf("machine code was truncated by credential sanitizer: %q", keyFailure.ProviderCode)
	}
}

func TestDurationAdviceRequiresAnExplicitNumericRange(t *testing.T) {
	for _, message := range []string{
		"duration must be between 5 and 10 seconds",
		"duration must be in range [5, 10] seconds",
	} {
		for _, raw := range []string{message, fmt.Sprintf(`{"error":{"code":"invalid_request","message":%q}}`, message)} {
			failure := generation.ClassifyText(raw)
			if failure.Category != generation.CategoryInvalidParams || !strings.Contains(failure.Action, "5–10 秒") {
				t.Errorf("explicit range lost: category=%s action=%q", failure.Category, failure.Action)
			}
			if category := generation.ClassifyText(failure.UserMessage()).Category; category != generation.CategoryInvalidParams {
				t.Errorf("persisted duration advice became %s", category)
			}
		}
	}
	for _, message := range []string{
		"duration is invalid",
		"duration must be between 10 and 5 seconds",
		"invalid parameter prompt=duration must be between 5 and 10 seconds",
		"duration must be between 5 and 10 frames",
	} {
		failure := generation.ClassifyText(fmt.Sprintf(`{"error":{"code":"invalid_request","message":%q}}`, message))
		if strings.Contains(failure.Action, "5–10") || strings.Contains(failure.Action, "10–5") {
			t.Errorf("invented duration limit from %q", message)
		}
	}
}

func TestReferenceDurationAdviceSurvivesPersistence(t *testing.T) {
	for _, text := range []string{
		`{"error":{"code":"400","message":"素材转换失败: Height must be between 300px and 6000px."}}`,
		`{"error":{"code":"400","message":"aspect ratio must be between 0.4 and 2.5"}}`,
		"第 1 段参考音频时长为 16.00 秒，需要 不超过 15 秒；请裁剪或更换这段素材后再提交",
		"第 1 张参考图高度为 216 像素，需要 至少 300 像素；请调整尺寸或更换后再提交",
		"第 2 段参考音频时长为 0.90 秒，需要 2–30 秒；请裁剪或更换这段素材后再提交",
		"参考素材时长不符合模型要求。请检查每段参考音频和视频，将不符合要求的素材调整为 1.8–30.2 秒后重新提交。",
	} {
		failure := generation.ClassifyText(text)
		reloaded := generation.ClassifyText(failure.UserMessage())
		if reloaded.Category != generation.CategoryInvalidParams || reloaded.Reason != failure.Reason || reloaded.Action != failure.Action {
			t.Fatalf("reference duration lost on reload: %#v -> %#v", failure, reloaded)
		}
	}
}

func TestWholeRequestTooLargeIsNotASingleFileAdvice(t *testing.T) {
	for _, body := range []string{"", "<html>413 Request Entity Too Large</html>"} {
		if got := generation.ClassifyHTTP(413, "", body); got.Category != generation.CategoryInputTooLarge || !strings.Contains(got.Reason, "整次请求") {
			t.Fatalf("empty/HTML 413 advice: %#v", got)
		}
	}
	for _, raw := range []string{
		"video request body is too large",
		"video request body exceeds the 64 MiB request limit; use public media URLs instead of inline base64",
		`{"error":{"code":"video_request_body_too_large","message":"","type":"api_error"}}`,
	} {
		failure := generation.ClassifyText(raw)
		for _, got := range []generation.Failure{failure, generation.ClassifyText(failure.UserMessage())} {
			if got.Category != generation.CategoryInputTooLarge || !strings.Contains(got.Reason, "整次请求") || !strings.Contains(got.Action, "素材链接") || got.Retryable {
				t.Fatalf("request size explanation lost: %#v", got)
			}
		}
	}
}

func TestGatewayVideoPreflightErrorFixture(t *testing.T) {
	data, err := os.ReadFile("../../../web/test/fixtures/reference-video-errors.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Message, Reason, Action string }
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, item := range cases {
		body, _ := json.Marshal(map[string]any{"error": map[string]string{"code": "invalid_reference_video", "message": item.Message}})
		failure := generation.ClassifyText(string(body))
		if !strings.Contains(failure.Reason, item.Reason) || !strings.Contains(failure.Action, item.Action) {
			t.Fatalf("lost guidance for %s: %+v", item.Message, failure)
		}
		persisted := generation.ClassifyText(failure.UserMessage())
		if !strings.Contains(persisted.UserMessage(), item.Action) {
			t.Fatalf("lost persisted guidance: %+v", persisted)
		}
	}
}

func TestReferencePixelDiagnosticIDIsNotDuplicated(t *testing.T) {
	input := "第 1 个参考视频像素总量为 331776（432×768）。需要 407696–8295044 像素；请调整尺寸。排查编号：请求 202609290516575609492488268d9d6HqaXq7bq。"
	failure := generation.ClassifyText(input)
	if strings.Count(failure.UserMessage(), "202609290516575609492488268d9d6HqaXq7bq") != 1 {
		t.Fatalf("duplicate ID: %s", failure.UserMessage())
	}
}

func TestMediaCopyPreservesAuthenticationAndIgnoresRequestEcho(t *testing.T) {
	for _, message := range []string{"asset access denied", "unsupported video codec", "Frame rate must be between 24 and 60."} {
		body, _ := json.Marshal(map[string]any{"error": map[string]string{"code": "invalid_api_key", "message": message}, "request_id": "req_media_auth_123"})
		failure := generation.ClassifyText(string(body))
		if failure.Category != generation.CategoryAuth || failure.RequestID != "req_media_auth_123" {
			t.Fatalf("auth overwritten: %+v", failure)
		}
	}
	failure := generation.ClassifyText(`{"error":{"code":"unknown","message":"Failure"},"prompt":"unsupported video codec"}`)
	if failure.Category != generation.CategoryUnknown {
		t.Fatalf("request echo classified: %+v", failure)
	}
}

func TestWindowsSocketFailureIsActionable(t *testing.T) {
	for _, message := range []string{"An existing connection was forcibly closed by the remote host.", "An established connection was aborted by the software in your host machine."} {
		failure := generation.ClassifyError(errors.New(`Get "https://private.example/task?token=secret": read tcp: wsarecv: ` + message))
		if failure.Category != generation.CategoryNetwork || strings.Contains(failure.UserMessage(), "wsarecv") || strings.Contains(failure.UserMessage(), "secret") {
			t.Fatalf("failure=%+v message=%s", failure, failure.UserMessage())
		}
	}
}
