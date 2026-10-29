package generation

import (
	"strings"
	"testing"
)

func TestVideoReservationQuotaRequiresFundingEvidence(t *testing.T) {
	if got := ClassifyText("当前账号额度不足：请检查账号余额，或联系管理员调整额度后重试"); got.Category != CategoryQuotaUser {
		t.Fatal(got)
	}
	for _, tc := range []struct {
		status int
		body   string
		want   FailureCategory
	}{
		{402, `{"error":{"code":"video_reservation_failed","message":"insufficient balance for this video request (request id: request-123456)"}}`, CategoryQuotaUser},
		{503, `{"error":{"code":"video_reservation_failed","message":"video submission is temporarily unavailable"}}`, CategoryProviderUnavailable},
		{402, `{"error":{"code":"video_reservation_failed","message":"unknown funding failure"}}`, CategoryQuotaUnknown},
		{402, `{"error":{"message":"insufficient balance"}}`, CategoryQuotaUnknown},
	} {
		f := ClassifyHTTP(tc.status, "", tc.body)
		if f.Category != tc.want {
			t.Fatalf("status=%d category=%s want=%s", tc.status, f.Category, tc.want)
		}
		if tc.want == CategoryQuotaUser && (!strings.Contains(f.UserMessage(), "令牌、套餐") || strings.Contains(f.UserMessage(), "供应商")) {
			t.Fatal(f.UserMessage())
		}
	}
}

func TestVideoDeliveryFailureSurvivesPersistenceAndDownload(t *testing.T) {
	f := ClassifyText(`{"status":"failed","error":{"code":"video_delivery_failed","message":"Video generated but could not be saved. Contact support; do not regenerate automatically."}}`)
	if f.Category != CategoryDeliveryFailed || !strings.Contains(f.UserMessage(), "无需重新付费生成") {
		t.Fatal(f)
	}
	if got := ClassifyText(f.UserMessage()); got.Category != CategoryDeliveryFailed {
		t.Fatal(got)
	}
	if got := WithDownloadFailure(f, "task-original-123"); got.Category != CategoryDeliveryFailed {
		t.Fatal(got)
	}
}
