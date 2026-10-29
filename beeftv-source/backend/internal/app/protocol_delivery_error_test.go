package app

import (
	"strings"
	"testing"
)

func TestProtocolResultErrorKeepsDeliveryCode(t *testing.T) {
	err := protocolResultError("Video generated but could not be saved", "task-original-123", []byte(`{"request_id":"request-original-123","error":{"code":"video_delivery_failed","type":"api_error","message":"Video generated but could not be saved"},"secret":"not-for-user"}`))
	if !strings.Contains(err.Error(), "无需重新付费生成") || strings.Contains(err.Error(), "not-for-user") {
		t.Fatal(err)
	}
	payload, ok := err.(providerPayloadError)
	if !ok || !strings.Contains(payload.Raw(), "video_delivery_failed") {
		t.Fatal(err)
	}
	if !strings.Contains(err.Error(), "request-original-123") || !strings.Contains(payload.Raw(), "api_error") {
		t.Fatal(err)
	}
}
