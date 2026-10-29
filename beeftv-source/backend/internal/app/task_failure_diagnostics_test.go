package app

import (
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestTaskFailureDiagnosticsPreserveLocalConstraint(t *testing.T) {
	task := &model.Task{ID: "task-local", Stage: "校验参考图"}
	captureTaskFailureDiagnostics(task, BadAuthRequest("当前图片模型最多支持 2 张参考图"), "unknown")
	d := taskSummaryForOutput(*task).FailureDiagnostics
	if d == nil || d.Source != "local_validation" || d.Summary != "当前图片模型最多支持 2 张参考图" || d.ProviderCode != "" || d.CapturedAt == "" {
		t.Fatalf("diagnostics = %+v", d)
	}
}

func TestTaskFailureDiagnosticsDiskFullStage(t *testing.T) {
	task := &model.Task{ID: "task_12345678", Stage: "处理中"}
	captureTaskFailureDiagnostics(task, errors.New("生成内容写入资源存储失败：write local resource: no space left on device"), "local_result")
	d := task.FailureDiagnostics
	if d == nil || d.Source != "local_result" || d.Stage != "保存生成结果（磁盘空间不足）" || !strings.Contains(d.Summary, "no space left on device") {
		t.Fatalf("lost storage stage: %#v", d)
	}
}

func TestTaskFailureDiagnosticsPreserveHTTPHeaderAndRedact(t *testing.T) {
	task := &model.Task{ID: "task-http", Stage: "正在生成"}
	err := providerHTTPError{StatusCode: 400, RequestID: "req-header-123", Body: `{"error":{"code":"invalid_size","param":"size","message":"size must be 1024x1024; Authorization: Bearer PRIVATE credential"}}`}
	captureTaskFailureDiagnostics(task, err, "unknown")
	d := taskForOutput(*task).FailureDiagnostics
	if d.Source != "upstream_http" || d.HTTPStatus != 400 || d.RequestID != "req-header-123" || d.ProviderCode != "invalid_size" || d.Param != "size" || !strings.Contains(d.Summary, "1024x1024") || strings.Contains(d.Summary, "PRIVATE") {
		t.Fatalf("diagnostics = %+v", d)
	}
	if taskSummaryForOutput(*task).FailureDiagnostics.Summary != d.Summary {
		t.Fatal("detail and summary disagree")
	}
}

func TestTaskTerminalPersistsDiagnosticBeforeReplacingError(t *testing.T) {
	task := &model.Task{ID: "task-terminal", Status: model.TaskStatusRunning, Stage: "素材下载"}
	repo := &taskTerminalRepositoryStub{task: task}
	c := newTaskTerminalCoordinatorForTest(repo, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
	err := errors.New("cannot save /Users/private-name/image.png")
	if got := c.handleExecutionFailure(task, err, true, false); !errors.Is(got, err) {
		t.Fatal(got)
	}
	if task.FailureDiagnostics == nil || task.FailureDiagnostics.Source != "local_result" || strings.Contains(task.FailureDiagnostics.Summary, "private-name") {
		t.Fatalf("diagnostics = %+v", task.FailureDiagnostics)
	}
}
