package app

import "testing"

func TestTaskCancellationPendingRetryMessageIsLocal(t *testing.T) {
	if got := taskCancellationPendingRetryMessage(); got != "上一次取消请求仍在确认中，请稍后重试" {
		t.Fatalf("local retry message = %q", got)
	}
}
