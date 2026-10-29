package app

import "testing"

func TestProviderCancellationUncertainMessageIsLocal(t *testing.T) {
	if got := providerCancellationUncertainMessage("取消请求结果不明确"); got != "取消请求结果不明确，取消状态待确认" {
		t.Fatalf("local cancellation message = %q", got)
	}
}
