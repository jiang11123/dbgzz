package app

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/provider/workflow"
)

func TestRunningHubWorkflowRejectsMediaUploadInLocalMode(t *testing.T) {
	svc := &Service{mode: serviceModeLocal}
	input := canvasGenerationInput{
		Mode: "video",
		Config: providerConfig{
			InterfaceType: string(model.ChannelInterfaceRunningHubVideo),
			BaseURL:       "https://example.com",
		},
		ReferenceImages: []providerMedia{{ID: "ref-1", DataURL: "data:image/png;base64,AAAA"}},
	}
	_, err := svc.runRunningHubWorkflow(context.Background(), input)
	if err == nil || !strings.Contains(err.Error(), "本地工作区") {
		t.Fatalf("local RunningHub media upload error = %v, want local-workspace rejection", err)
	}
}

func TestUploadRunningHubMediaRejectsLocalMode(t *testing.T) {
	svc := &Service{mode: serviceModeLocal}
	_, err := svc.uploadRunningHubMedia(context.Background(), "https://example.com", providerConfig{}, providerMedia{
		ID:      "ref-1",
		DataURL: "data:image/png;base64,AAAA",
	})
	if err == nil || !strings.Contains(err.Error(), "本地工作区") {
		t.Fatalf("local RunningHub upload error = %v, want local-workspace rejection", err)
	}
}

func TestWorkflowPluginsNilServiceFailsClosed(t *testing.T) {
	err := (workflowPlugins{}).EnsureEnabled(context.Background(), string(model.ChannelInterfaceRunningHubImage))
	if err == nil || !strings.Contains(err.Error(), "插件授权") {
		t.Fatalf("nil plugin service error = %v, want fail closed", err)
	}
}

func TestWorkflowReceiptNilServiceFailsClosed(t *testing.T) {
	if err := (workflowReceipt{}).Ready(context.Background()); err == nil || !strings.Contains(err.Error(), "受理回执") {
		t.Fatalf("nil receipt Ready error = %v, want fail closed", err)
	}
	err := (workflowReceipt{}).RecordAccepted(context.Background(), "accepted-1", "submitted", nil)
	if err == nil || !strings.Contains(err.Error(), "受理回执") {
		t.Fatalf("nil receipt service error = %v, want fail closed", err)
	}
}

func TestWorkflowReceiptReadyRequiresLocalTaskContext(t *testing.T) {
	s, owned := workflowPaidTaskFixture(t)
	receipt := workflowReceipt{service: s}
	if err := receipt.Ready(context.Background()); err == nil || !strings.Contains(err.Error(), "本地任务回执上下文") {
		t.Fatalf("Ready without analytics = %v, want local receipt context", err)
	}
	if err := receipt.RecordAccepted(context.Background(), "accepted-1", "submitted", nil); err == nil || !strings.Contains(err.Error(), "本地任务回执上下文") {
		t.Fatalf("RecordAccepted without TaskID = %v, want fail closed", err)
	}
	if err := receipt.Ready(withProviderAnalytics(context.Background(), s, owned)); err != nil {
		t.Fatalf("Ready with owned sqlite task = %v", err)
	}
}

func TestWorkflowPaidCreateRequiresAnalyticsTaskID(t *testing.T) {
	allowLoopbackProviderTest(t)
	creates := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/task/openapi/create") || strings.Contains(r.URL.Path, "/ai-app/run") {
			creates++
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	s, _ := newTimelineTaskTestService(t)
	_, err := s.runRunningHubWorkflow(context.Background(), workflowCreateInput(server.URL))
	if err == nil || !strings.Contains(err.Error(), "本地任务回执上下文") {
		t.Fatalf("error = %v, want missing paid receipt context", err)
	}
	var unknown providerSubmissionUnknownError
	if errors.As(err, &unknown) {
		t.Fatalf("preflight Ready wrapped as unknown: %v", err)
	}
	if creates != 0 {
		t.Fatalf("creates = %d, want 0", creates)
	}
}

func TestWorkflowPaidCreateRejectsStaleAndForeignTaskIdentity(t *testing.T) {
	allowLoopbackProviderTest(t)
	creates := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/task/openapi/create") || strings.Contains(r.URL.Path, "/ai-app/run") {
			creates++
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	s, owned := workflowPaidTaskFixture(t)
	stale := owned
	stale.ID = "invented-stale-id"
	foreign := owned
	foreign.UserID = "other-user"
	for _, tc := range []struct {
		name string
		task model.Task
	}{
		{name: "stale invented ID", task: stale},
		{name: "foreign owner", task: foreign},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := creates
			ctx := withProviderAnalytics(context.Background(), s, tc.task)
			_, err := s.runRunningHubWorkflow(ctx, workflowCreateInput(server.URL))
			if err == nil || !strings.Contains(err.Error(), "本地任务回执上下文") {
				t.Fatalf("error = %v, want owned local receipt rejection", err)
			}
			var unknown providerSubmissionUnknownError
			if errors.As(err, &unknown) {
				t.Fatalf("identity rejection wrapped as unknown: %v", err)
			}
			if creates != before {
				t.Fatalf("creates = %d, want %d", creates, before)
			}
		})
	}
}

func TestWorkflowSettingsAndPollStayAvailableWithoutPaidContext(t *testing.T) {
	allowLoopbackProviderTest(t)
	creates := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/task/openapi/create", "/task/openapi/ai-app/run":
			creates++
			http.NotFound(w, r)
		case "/api/openapi/getJsonApiFormat":
			_, _ = w.Write([]byte(`{"data":{"prompt":""}}`))
		case "/task/openapi/outputs":
			_, _ = w.Write([]byte(`{"code":0,"data":[{"fileUrl":"` + server.URL + `/out.png"}]}`))
		case "/out.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("PNGDATA"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	s := &Service{}
	info, err := s.FetchRunningHubWorkflowInfo(context.Background(), RunningHubWorkflowFetchRequest{
		BaseURL:    server.URL,
		APIKey:     "k",
		WorkflowID: "wf-1",
		Title:      "Demo",
	})
	if err != nil {
		t.Fatal(err)
	}
	if info["kind"] != "workflow" || info["workflowId"] != "wf-1" {
		t.Fatalf("settings fetch = %#v", info)
	}
	result, err := s.pollRunningHubWorkflow(context.Background(), providerConfig{APIKey: "k"}, server.URL, "orig-9", "image")
	if err != nil {
		t.Fatal(err)
	}
	if result["mode"] != "image" {
		t.Fatalf("poll result = %#v", result)
	}
	if creates != 0 {
		t.Fatalf("settings/poll created a paid task: creates = %d", creates)
	}
}

func TestWorkflowAcceptedNotRecordedMapsToUnknownBlocksRetryAndKeepsID(t *testing.T) {
	allowLoopbackProviderTest(t)
	creates := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/task/openapi/create") || strings.Contains(r.URL.Path, "/ai-app/run") {
			creates++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":0,"data":{"taskId":"accepted-77"}}`))
			return
		}
		if strings.Contains(r.URL.Path, "/task/openapi/outputs") {
			t.Fatal("failed receipt must not poll")
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)

	s, task := workflowPaidTaskFixture(t)
	ctx := withProviderAnalytics(context.Background(), s, task)
	client := s.workflowClient(nil)
	client.Receipt = failRecordReceipt{ready: client.Receipt, err: errors.New("disk full")}
	converted := s.workflowInputFromCanvas(ctx, workflowCreateInput(server.URL))
	_, runErr := client.Run(ctx, converted)
	err := s.fenceWorkflowSubmission(ctx, converted, runErr)
	var unknown providerSubmissionUnknownError
	var accepted workflow.AcceptedNotRecorded
	if !errors.As(err, &unknown) || !errors.As(err, &accepted) || accepted.RequestID != "accepted-77" {
		t.Fatalf("error = %v, want unknown wrapping AcceptedNotRecorded", err)
	}
	if creates != 1 {
		t.Fatalf("creates = %d, want 1", creates)
	}
	if err := s.refreshTaskProviderState(&task); err != nil {
		t.Fatal(err)
	}
	if task.ProviderRequestID != "accepted-77" {
		t.Fatalf("later ledger write missing: ProviderRequestID=%q", task.ProviderRequestID)
	}
	assertWorkflowUnknownTerminalBlocksRetry(t, s, &task, err)
	if stored, loadErr := s.repo.Task(task.ID); loadErr != nil {
		t.Fatal(loadErr)
	} else if stored.ProviderRequestID != "accepted-77" {
		t.Fatalf("known ID lost after terminal: %q", stored.ProviderRequestID)
	}
}

func TestWorkflowAcceptedNotRecordedLaterWriteFailureDoesNotClaimRecovery(t *testing.T) {
	s, task := workflowPaidTaskFixture(t)
	err := s.fenceWorkflowSubmission(context.Background(), workflow.Input{}, workflow.AcceptedNotRecorded{
		RequestID: "accepted-77",
		Stage:     "submitted",
		Err:       errors.New("disk full"),
	})
	var unknown providerSubmissionUnknownError
	if !errors.As(err, &unknown) {
		t.Fatalf("error = %v, want unknown", err)
	}
	stored, loadErr := s.repo.Task(task.ID)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if stored.ProviderRequestID != "" {
		t.Fatalf("claimed durable recovery without later write: %q", stored.ProviderRequestID)
	}
}

func TestWorkflowCreateUncertainCannotResubmit(t *testing.T) {
	allowLoopbackProviderTest(t)
	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
	}{
		{
			name: "malformed JSON",
			handler: func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Path, "/task/openapi/create") && !strings.Contains(r.URL.Path, "/ai-app/run") {
					http.NotFound(w, r)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"code":0,`))
			},
		},
		{
			name: "timeout",
			handler: func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Path, "/task/openapi/create") && !strings.Contains(r.URL.Path, "/ai-app/run") {
					http.NotFound(w, r)
					return
				}
				conn, _, _ := w.(http.Hijacker).Hijack()
				_ = conn.Close()
			},
		},
		{
			name: "missing taskId",
			handler: func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Path, "/task/openapi/create") && !strings.Contains(r.URL.Path, "/ai-app/run") {
					http.NotFound(w, r)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"code":0,"data":{}}`))
			},
		},
		{
			name: "empty envelope",
			handler: func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Path, "/task/openapi/create") && !strings.Contains(r.URL.Path, "/ai-app/run") {
					http.NotFound(w, r)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{}`))
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var creates atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/task/openapi/create") || strings.Contains(r.URL.Path, "/ai-app/run") {
					creates.Add(1)
					_, _ = io.Copy(io.Discard, r.Body)
					tc.handler(w, r)
					return
				}
				http.NotFound(w, r)
			}))
			t.Cleanup(server.Close)
			s, task := workflowPaidTaskFixture(t)
			ctx := withProviderAnalytics(context.Background(), s, task)
			_, err := s.runRunningHubWorkflow(ctx, workflowCreateInput(server.URL))
			var unknown providerSubmissionUnknownError
			if !errors.As(err, &unknown) {
				t.Fatalf("error = %v, want unknown", err)
			}
			if creates.Load() != 1 {
				t.Fatalf("creates = %d, want 1", creates.Load())
			}
			assertWorkflowUnknownTerminalBlocksRetry(t, s, &task, err)
		})
	}
}

func TestWorkflowProtocolErrorStaysOrdinary(t *testing.T) {
	allowLoopbackProviderTest(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/task/openapi/create") || strings.Contains(r.URL.Path, "/ai-app/run") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":805,"msg":"NODE_INFO_MISMATCH"}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	s, task := workflowPaidTaskFixture(t)
	ctx := withProviderAnalytics(context.Background(), s, task)
	_, err := s.runRunningHubWorkflow(ctx, workflowCreateInput(server.URL))
	var unknown providerSubmissionUnknownError
	if err == nil || errors.As(err, &unknown) || !strings.Contains(err.Error(), "重新选择该 App") {
		t.Fatalf("error = %v, want ordinary protocol failure", err)
	}
}

type failRecordReceipt struct {
	ready workflow.Receipt
	err   error
}

func (r failRecordReceipt) Ready(ctx context.Context) error {
	return r.ready.Ready(ctx)
}

func (r failRecordReceipt) RecordAccepted(context.Context, string, string, *time.Time) error {
	return r.err
}

func (r failRecordReceipt) UpdateStage(ctx context.Context, requestID, stage string, nextPollAt *time.Time) error {
	return r.ready.UpdateStage(ctx, requestID, stage, nextPollAt)
}

func workflowCreateInput(baseURL string) canvasGenerationInput {
	return canvasGenerationInput{
		Mode: "image",
		Config: providerConfig{
			InterfaceType: string(model.ChannelInterfaceRunningHubImage),
			BaseURL:       baseURL,
			APIKey:        "k",
			WorkflowID:    "wf-1",
			WorkflowJSON:  map[string]interface{}{"1": map[string]interface{}{"class_type": "Note", "inputs": map[string]interface{}{}}},
		},
	}
}

func workflowPaidTaskFixture(t *testing.T) (*Service, model.Task) {
	t.Helper()
	s, db := newTimelineTaskTestService(t)
	s.coordinator = platform.NewLocalCoordinator()
	expires := time.Now().Add(time.Hour)
	task := model.Task{
		ID:             "workflow-task",
		UserID:         "user",
		Type:           "canvas_video",
		Status:         model.TaskStatusRunning,
		LeaseOwner:     "owner",
		LeaseExpiresAt: &expires,
		InputJSON:      `{"mode":"video"}`,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	return s, task
}

func assertWorkflowUnknownTerminalBlocksRetry(t *testing.T, s *Service, task *model.Task, cause error) {
	t.Helper()
	failure := classifyTaskFailure(cause)
	if failure.Category != generation.CategorySubmissionUncertain || failure.Retryable {
		t.Fatalf("classification = %#v", failure)
	}
	if err := s.terminalCoordinator().handleExecutionFailure(task, cause, false, false); err == nil {
		t.Fatal("missing terminal failure")
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.TaskStatusFailed || stored.Stage != "submission_unknown" || !persistedFailureBlocksRetry(stored.Error, stored.Stage) {
		t.Fatalf("unsafe terminal state: %+v", stored)
	}
	if _, err := s.RetryTask(stored.UserID, stored.ID); err == nil || !strings.Contains(err.Error(), submissionUncertainRetryMessage) {
		t.Fatalf("retry = %v, want blocked uncertain retry", err)
	}
	attempt := &model.RouteAttempt{ID: "workflow-attempt-" + stored.ID, TaskID: stored.ID, Status: "dispatching", DispatchState: "not_sent", StartedAt: time.Now()}
	if err := s.repo.CreateRouteAttempt(attempt); err != nil {
		t.Fatal(err)
	}
	s.finishTaskRouteAttempt(attempt, stored, cause)
	loaded, err := s.repo.LatestRouteAttempt(stored.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.DispatchState == "rejected_no_job" {
		t.Fatalf("uncertain acceptance treated as ordinary rejection: %+v", loaded)
	}
	if next, routeErr := s.nextRouteAttemptAfterFailure(stored, loaded, cause); routeErr != nil || next != nil {
		t.Fatalf("fallback after uncertain acceptance: next=%v err=%v", next, routeErr)
	}
}
