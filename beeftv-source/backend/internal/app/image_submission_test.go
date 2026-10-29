package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func imageSubmissionFixture(t *testing.T, multipartBody bool) (*Service, *gorm.DB, model.Task, *model.ImageSubmission, []byte) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	s.workerID = newID()
	task := model.Task{ID: "image-task", UserID: "user", Type: "canvas_image", Status: model.TaskStatusRunning, LeaseOwner: "owner", InputJSON: `{"mode":"image"}`}
	expires := time.Now().Add(time.Hour)
	task.LeaseExpiresAt = &expires
	attempt := &model.RouteAttempt{ID: "image-attempt", TaskID: task.ID, Status: "dispatching", DispatchState: "submission_unknown", StartedAt: time.Now()}
	for _, row := range []any{&task, attempt} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	body := []byte(`{"model":"gpt-image-2","prompt":"a boat","n":1}`)
	contentType, path := "application/json", "/v1/images/generations"
	if multipartBody {
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		_ = writer.WriteField("prompt", "the exact image")
		part, _ := writer.CreateFormFile("image", "original.png")
		_, _ = part.Write([]byte("immutable image bytes"))
		_ = writer.Close()
		body, contentType, path = buffer.Bytes(), writer.FormDataContentType(), "/v1/images/edits"
	}
	ctx := withProviderSubmissionKey(withProviderAnalytics(context.Background(), s, task), attempt)
	ctx = generation.WithImageReplayProtocol(ctx, generation.ImageReplayProtocol)
	ctx = context.WithValue(ctx, imageTaskContext{}, task)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://enterprise.beefapi.com"+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer private-test-key")
	req.Header.Set("X-Idempotency-Key", "must-not-override-owner")
	row, handled, err := prepareImageSubmission(s, req)
	if err != nil || !handled {
		t.Fatalf("prepare: handled=%v err=%v", handled, err)
	}
	if strings.Contains(row.RequestCipher, "private-test-key") || strings.Contains(row.RequestCipher, "boat") {
		t.Fatal("plaintext persisted")
	}
	return s, db, task, row, body
}

func noImageWait(context.Context, time.Duration) error { return nil }

func TestImageSubmissionMidjourneyCountRejectionStopsWithoutRecovery(t *testing.T) {
	s, _, task, row, _ := imageSubmissionFixture(t, false)
	calls := 0
	_, _, err := s.sendImageSubmissionWith(context.Background(), task, row, func(_ *http.Request, admit func() error) ([]byte, string, error) {
		if err := admit(); err != nil {
			return nil, "", err
		}
		calls++
		return nil, "", providerHTTPError{StatusCode: 500, Body: `{"error":{"code":"invalid_request","message":"Midjourney generates four images per request; n must be 4 or omitted (request id: safe-request-id)"}}`}
	}, noImageWait)
	failure := classifyTaskFailure(err)
	if calls != 1 || failure.Category != generation.CategoryInvalidParams || failure.Uncertain {
		t.Fatalf("calls=%d failure=%+v", calls, failure)
	}
	attempt, loadErr := s.repo.LatestRouteAttempt(task.ID)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	s.finishTaskRouteAttempt(attempt, &task, err)
	if attempt.DispatchState != "rejected_no_job" {
		t.Fatalf("route state=%s", attempt.DispatchState)
	}
}

func TestImageSubmissionCountRejectionRequiresExplicitEvidence(t *testing.T) {
	for _, body := range []string{
		`{"error":{"code":"invalid_request","message":"internal processing failed"}}`,
		`{"error":{"code":"internal_error","message":"Midjourney generates four images per request; n must be 4 or omitted"}}`,
		`{"task_id":"accepted-task","error":{"code":"invalid_request","message":"Midjourney generates four images per request; n must be 4 or omitted"}}`,
		`<html>Midjourney generates four images per request; n must be 4 or omitted</html>`,
	} {
		err := providerHTTPError{StatusCode: 500, Body: body}
		if definiteMidjourneyCountRejection(err) || !retrySameImageSubmission(err) {
			t.Fatalf("unknown submission treated as a definite rejection: %s", body)
		}
	}
}

func TestImageSubmissionCountErrorCannotErasePriorAcceptance(t *testing.T) {
	s, _, task, row, _ := imageSubmissionFixture(t, false)
	if err := s.repo.MarkImageSubmissionAccepted(row); err != nil {
		t.Fatal(err)
	}
	_, _, err := s.sendImageSubmissionWith(context.Background(), task, row, func(_ *http.Request, admit func() error) ([]byte, string, error) {
		if err := admit(); err != nil {
			return nil, "", err
		}
		return nil, "", providerHTTPError{StatusCode: 500, Body: `{"error":{"code":"invalid_request","message":"Midjourney generates four images per request; n must be 4 or omitted"}}`}
	}, noImageWait)
	if failure := classifyTaskFailure(err); !failure.Uncertain || failure.Category != generation.CategorySubmissionUncertain {
		t.Fatalf("accepted response lost: %+v", failure)
	}
}

func TestImageSubmissionUnknownProviderCannotReplayOrRetryLostResponse(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	if err := db.Delete(row).Error; err != nil {
		t.Fatal(err)
	}
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	attempt.DispatchState = "not_sent"
	if err := s.repo.SaveRouteAttempt(attempt); err != nil {
		t.Fatal(err)
	}
	calls := 0
	executor := newTaskRouteExecutor(s)
	adapter := executor.port.(taskRouteServiceAdapter)
	adapter.process = func(ctx context.Context, current model.Task) (map[string]interface{}, []map[string]interface{}, error) {
		ctx = context.WithValue(withProviderAnalytics(ctx, s, current), imageTaskContext{}, current)
		req, _ := http.NewRequestWithContext(ctx, "POST", "https://unverified.example/v1/images/generations", strings.NewReader(`{}`))
		_, handled, err := prepareImageSubmission(s, req)
		if handled || err != nil {
			t.Fatalf("unknown provider recovery enabled: %v %v", handled, err)
		}
		calls++
		return nil, nil, io.ErrUnexpectedEOF
	}
	executor.port = adapter
	result, err := executor.execute(context.Background(), &task, attempt)
	if err != nil || calls != 1 || !isImageRecoveryError(result.err) {
		t.Fatalf("calls=%d result=%+v err=%v", calls, result, err)
	}
	if s.shouldDeferImageRecovery(task, result.err, false) {
		t.Fatal("unknown provider scheduled replay")
	}
	if _, err := s.beginTaskRouteAttempt(&task); !isRouteDispatchUncertain(err) {
		t.Fatalf("restart allowed dispatch: %v", err)
	}
	if err := s.validateImageTaskRetry(&task); err == nil {
		t.Fatal("new key retry allowed")
	}
	if err := s.terminalCoordinator().handleExecutionFailure(&task, result.err, false, false); err == nil {
		t.Fatal("missing terminal failure")
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.TaskStatusFailed || stored.Stage != "submission_unknown" || !persistedFailureBlocksRetry(stored.Error, stored.Stage) {
		t.Fatalf("unsafe terminal state: %+v", stored)
	}
}

func TestImageSubmissionDeferPreservesDiagnosticsForRestart(t *testing.T) {
	s, _, task, _, _ := imageSubmissionFixture(t, false)
	task.FailureDiagnostics = &model.TaskFailureDiagnostics{ExecutionResult: "unknown", Requests: []model.TaskRequestEvidence{{Operation: "submit", RequestID: "request-before-restart"}}}
	if err := s.deferImageRecovery(task); err != nil {
		t.Fatal(err)
	}
	loaded, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.FailureDiagnostics == nil || loaded.FailureDiagnostics.ExecutionResult != "pending" || len(loaded.FailureDiagnostics.Requests) != 1 || loaded.FailureDiagnostics.Requests[0].RequestID != "request-before-restart" {
		t.Fatalf("recovery lost diagnostics: %+v", loaded.FailureDiagnostics)
	}
}

func TestImageSubmissionDiskRestartReplaysOneGenerationAndCompletesOnce(t *testing.T) {
	s, db, task, row, body := imageSubmissionFixture(t, false)
	var wireCalls, generations int
	key := ""
	send := func(req *http.Request, admit func() error) ([]byte, string, error) {
		if err := admit(); err != nil {
			return nil, "", err
		}
		wireCalls++
		got, _ := io.ReadAll(req.Body)
		if !bytes.Equal(got, body) {
			t.Fatal("replay changed request bytes")
		}
		if key == "" {
			key = req.Header.Get("Idempotency-Key")
			generations++
		}
		if key == "" || req.Header.Get("Idempotency-Key") != key {
			t.Fatal("replay created new generation identity")
		}
		if wireCalls == 1 {
			return nil, "", io.ErrUnexpectedEOF
		}
		return []byte(`{"data":[{"b64_json":"` + strings.SplitN(testReferenceImageDataURL, ",", 2)[1] + `"}]}`), "application/json", nil
	}
	_, _, err := s.sendImageSubmissionWith(context.Background(), task, row, send, func(context.Context, time.Duration) error { return context.DeadlineExceeded })
	if !s.shouldDeferImageRecovery(task, err, false) {
		t.Fatalf("lost response not deferred: %v", err)
	}
	if err := s.deferImageRecovery(task); err != nil {
		t.Fatal(err)
	}
	var databasePath string
	if err := db.Raw("SELECT file FROM pragma_database_list WHERE name = 'main'").Scan(&databasePath).Error; err != nil {
		t.Fatal(err)
	}
	connection, _ := db.DB()
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := database.Open(database.Config{Driver: "sqlite", DSN: databasePath})
	if err != nil {
		t.Fatal(err)
	}
	connection, _ = reopened.DB()
	defer connection.Close()
	restarted := &Service{repo: repository.New(reopened), dataDir: s.dataDir, mode: serviceModeLocal}
	if err := reopened.Model(&model.Task{}).Where("id = ?", task.ID).Update("next_poll_at", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	claimed, err := restarted.repo.ClaimNextTask("restarted-worker", time.Minute)
	if err != nil || claimed == nil {
		t.Fatalf("claim: %+v %v", claimed, err)
	}
	attempt, err := restarted.beginTaskRouteAttempt(claimed)
	if err != nil || attempt.ID != row.AttemptID {
		t.Fatalf("restart created attempt: %+v %v", attempt, err)
	}
	loaded, err := restarted.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if err != nil || loaded.SendCount != 1 {
		t.Fatalf("restart budget: %+v %v", loaded, err)
	}
	data, _, err := restarted.sendImageSubmissionWith(context.Background(), *claimed, loaded, send, noImageWait)
	if err != nil {
		t.Fatal(err)
	}
	var payload imageResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	images, err := imageDataURLs(payload)
	if err != nil {
		t.Fatal(err)
	}
	result, err := restarted.persistGeneratedMediaResult(task.UserID, map[string]interface{}{"mode": "image", "images": images})
	if err != nil {
		t.Fatal(err)
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	stale := *claimed
	if err := restarted.saveTaskCompletionWithinStorageQuota(claimed, resultJSON, nil, false); err != nil {
		t.Fatal(err)
	}
	if err := restarted.saveTaskCompletionWithinStorageQuota(&stale, resultJSON, nil, false); !errors.Is(err, repository.ErrTaskStateConflict) {
		t.Fatalf("duplicate completion accepted: %v", err)
	}
	if _, _, err := restarted.sendImageSubmissionWith(context.Background(), stale, loaded, send, noImageWait); err == nil {
		t.Fatal("terminal task resent")
	}
	var resources, submissions int64
	if err := reopened.Model(&model.Resource{}).Where("user_id = ?", task.UserID).Count(&resources).Error; err != nil {
		t.Fatal(err)
	}
	if err := reopened.Model(&model.ImageSubmission{}).Where("task_id = ?", task.ID).Count(&submissions).Error; err != nil {
		t.Fatal(err)
	}
	completed, err := restarted.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if wireCalls != 2 || generations != 1 || resources != 1 || submissions != 1 || completed.Status != model.TaskStatusSucceeded || completed.ResultJSON == "" {
		t.Fatalf("wire=%d generations=%d resources=%d submissions=%d task=%+v", wireCalls, generations, resources, submissions, completed)
	}
}

func TestImageSubmissionConfirmedThrottleRetriesFrozenRequestOnlyThreeTimes(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, true)
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	attempt.AttemptNumber = 1
	if err := db.Save(attempt).Error; err != nil {
		t.Fatal(err)
	}
	priorPlain, _ := s.decryptSettingSecret(row.RequestCipher)
	var priorWire imageWireRequest
	_ = json.Unmarshal([]byte(priorPlain), &priorWire)
	seen := map[string]bool{priorWire.Header.Get("Idempotency-Key"): true}
	for i := 1; i <= 3; i++ {
		throttled := providerHTTPError{StatusCode: 429, Body: `{"error":{"code":"rate_limit_exceeded"}}`}
		s.finishTaskRouteAttempt(attempt, &task, throttled)
		next, err := s.nextRouteAttemptAfterFailure(&task, attempt, throttled)
		if err != nil {
			t.Fatal(err)
		}
		if i == 3 {
			if next != nil {
				t.Fatal("fourth paid attempt created")
			}
			break
		}
		if next == nil || next.AttemptNumber != i+1 {
			t.Fatalf("next=%+v", next)
		}
		snapshot, err := s.repo.ImageSubmission(next.ID, task.ID, task.UserID)
		if err != nil {
			t.Fatal(err)
		}
		plain, _ := s.decryptSettingSecret(snapshot.RequestCipher)
		var wire imageWireRequest
		_ = json.Unmarshal([]byte(plain), &wire)
		key := wire.Header.Get("Idempotency-Key")
		if key == "" || seen[key] || !bytes.Equal(wire.Body, priorWire.Body) || wire.URL != priorWire.URL || wire.Header.Get("Authorization") != priorWire.Header.Get("Authorization") {
			t.Fatal("new attempt changed input or reused terminal key")
		}
		seen[key] = true
		attempt = next
	}
}

func TestImageSubmissionLostResponsePendingAndReplay(t *testing.T) {
	for _, multipartBody := range []bool{false, true} {
		t.Run(map[bool]string{false: "generation", true: "edit"}[multipartBody], func(t *testing.T) {
			s, _, task, row, body := imageSubmissionFixture(t, multipartBody)
			calls, key := 0, ""
			data, _, err := s.sendImageSubmissionWith(context.Background(), task, row, func(req *http.Request, admit func() error) ([]byte, string, error) {
				if err := admit(); err != nil {
					return nil, "", err
				}
				calls++
				got, _ := io.ReadAll(req.Body)
				if !bytes.Equal(got, body) {
					t.Fatal("request body changed")
				}
				if req.Header.Get("X-Idempotency-Key") != "" {
					t.Fatal("conflicting key retained")
				}
				if calls == 1 {
					key = req.Header.Get("Idempotency-Key")
				}
				if key == "" || req.Header.Get("Idempotency-Key") != key {
					t.Fatal("submission key changed")
				}
				switch calls {
				case 1:
					return nil, "", io.ErrUnexpectedEOF
				case 2:
					return nil, "", providerHTTPError{StatusCode: 409, Body: `{"error":{"code":"image_submission_pending"}}`, IdempotencyReplayed: true}
				default:
					return []byte(`{"data":[{"b64_json":"cG5n"}]}`), "application/json", nil
				}
			}, noImageWait)
			if err != nil || calls != 3 || len(data) == 0 {
				t.Fatalf("calls=%d error=%v", calls, err)
			}
			persisted, _ := s.repo.ImageSubmission(row.AttemptID, task.ID, task.UserID)
			if persisted.SendCount != 3 {
				t.Fatalf("durable send count=%d", persisted.SendCount)
			}
		})
	}
}

func TestImageSubmissionRestartKeepsWireAndBudget(t *testing.T) {
	s, db, task, row, body := imageSubmissionFixture(t, true)
	if err := s.repo.ClaimImageSubmissionSend(row, task.LeaseOwner, imageRecoveryMaxSends); err != nil {
		t.Fatal(err)
	}
	// A fresh service decrypts the original durable wire request, independent of
	// mutable task configuration, protocol packages, or deleted reference files.
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir}
	attempt, err := restarted.beginTaskRouteAttempt(&task)
	if err != nil || attempt.ID != row.AttemptID {
		t.Fatalf("attempt=%v err=%v", attempt, err)
	}
	loaded, _ := restarted.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if loaded.SendCount != 1 {
		t.Fatal("restart reset request budget")
	}
	loaded.CreatedAt = time.Now().Add(-2 * time.Hour)
	_, _, err = restarted.sendImageSubmissionWith(context.Background(), task, loaded, func(req *http.Request, admit func() error) ([]byte, string, error) {
		if err := admit(); err != nil {
			return nil, "", err
		}
		got, _ := io.ReadAll(req.Body)
		if !bytes.Equal(got, body) {
			t.Fatal("restart rebuilt request")
		}
		return []byte(`{"data":[{"b64_json":"cG5n"}]}`), "application/json", nil
	}, noImageWait)
	if err != nil {
		t.Fatal(err)
	}
}

func TestImageSubmissionTerminalResponsesNeverRegenerate(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    int
		code      string
		uncertain bool
	}{
		{"unknown", 409, "image_result_unknown", true}, {"expired", 410, "image_result_expired", true}, {"conflict", 409, "idempotency_conflict", true},
		{"invalid", 400, "invalid_params", false}, {"balance", 402, "insufficient_quota", false}, {"auth", 401, "invalid_api_key", false}, {"moderation", 403, "content_policy_violation", false}, {"throttled", 429, "rate_limit_exceeded", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, task, row, _ := imageSubmissionFixture(t, false)
			calls := 0
			_, _, err := s.sendImageSubmissionWith(context.Background(), task, row, func(req *http.Request, admit func() error) ([]byte, string, error) {
				if err := admit(); err != nil {
					return nil, "", err
				}
				calls++
				return nil, "", providerHTTPError{StatusCode: tc.status, Body: `{"error":{"code":"` + tc.code + `"}}`}
			}, noImageWait)
			if err == nil || calls != 1 {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
			if tc.uncertain && classifyTaskFailure(err).Category != generation.CategorySubmissionUncertain {
				t.Fatalf("unsafe classification: %v", classifyTaskFailure(err))
			}
		})
	}
}

func TestImageSubmissionBudgetCancelAndOwnership(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	calls := 0
	send := func(req *http.Request, admit func() error) ([]byte, string, error) {
		if err := admit(); err != nil {
			return nil, "", err
		}
		calls++
		return nil, "", io.ErrUnexpectedEOF
	}
	_, _, err := s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait)
	if calls != imageRecoveryMaxSends || classifyTaskFailure(err).Category != generation.CategorySubmissionUncertain {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	_, _, _ = s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait)
	if calls != imageRecoveryMaxSends {
		t.Fatal("budget reset")
	}
	row.SendCount = 0
	if err := db.Model(row).Update("send_count", 0).Error; err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, _ = s.sendImageSubmissionWith(ctx, task, row, send, noImageWait)
	if calls != imageRecoveryMaxSends {
		t.Fatal("cancel dispatched")
	}
	other := task
	other.UserID = "other"
	_, _, _ = s.sendImageSubmissionWith(context.Background(), other, row, send, noImageWait)
	if calls != imageRecoveryMaxSends {
		t.Fatal("wrong owner dispatched")
	}
	if err := db.Model(&task).Update("status", model.TaskStatusCancelled).Error; err != nil {
		t.Fatal(err)
	}
	_, _, _ = s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait)
	if calls != imageRecoveryMaxSends {
		t.Fatal("cancelled row dispatched")
	}
	if _, err := s.RetryTask(task.UserID, task.ID); err == nil {
		t.Fatal("cancelled accepted image minted new key")
	}
	if err := s.validateRetryTaskType(task.UserID, task.Type, map[string]any{"metadata": map[string]any{"retryOf": task.ID}}); err == nil {
		t.Fatal("canvas retry bypassed the original submission guard")
	}
}

func TestImageSubmissionPermanentErrorsDoNotFallBackToAnotherRoute(t *testing.T) {
	s, _, task, _, _ := imageSubmissionFixture(t, false)
	task.LogicalModelID = "logical-image"
	attempt, _ := s.repo.LatestRouteAttempt(task.ID)
	attempt.AttemptNumber = 1
	attempt.DispatchState = "rejected_no_job"
	for _, status := range []int{400, 401, 402, 403, 404, 409, 410, 500} {
		next, err := s.nextRouteAttemptAfterFailure(&task, attempt, providerHTTPError{StatusCode: status})
		if err != nil || next != nil {
			t.Fatalf("status %d fell back: %v %v", status, next, err)
		}
	}
	if definiteImageThrottle(providerHTTPError{StatusCode: 429, Body: `{"error":{"code":"insufficient_quota"}}`}) {
		t.Fatal("quota error treated as transient throttle")
	}
}

func TestImageSubmissionRequiresProtocolAndPersistence(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	if err := db.Migrator().DropTable(&model.ImageSubmission{}); err != nil {
		t.Fatal(err)
	}
	ctx := withProviderSubmissionKey(withProviderAnalytics(context.Background(), s, task), &model.RouteAttempt{ID: row.AttemptID, TaskID: task.ID})
	ctx = generation.WithImageReplayProtocol(ctx, generation.ImageReplayProtocol)
	ctx = context.WithValue(ctx, imageTaskContext{}, task)
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://enterprise.beefapi.com/v1/images/generations", strings.NewReader(`{}`))
	_, handled, err := prepareImageSubmission(s, req)
	if !handled || err == nil {
		t.Fatal("storage failure did not fail closed")
	}
	for _, url := range []string{"http://enterprise.beefapi.com/v1/images/generations", "https://evil.beefapi.com/v1/images/generations", "https://beefapi.com.evil.test/v1/images/generations", "https://api.openai.com/v1/images/generations", "https://beefapi.com/v1/responses", "https://beefapi.com:8443/v1/images/edits"} {
		r, _ := http.NewRequest("POST", url, nil)
		if recoverableImageEndpoint(r) {
			t.Fatalf("unverified contract enabled: %s", url)
		}
	}
}

func TestImageSubmissionExpiredMalformedAndStaleLeaseStop(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	calls := 0
	send := func(req *http.Request, admit func() error) ([]byte, string, error) {
		if err := admit(); err != nil {
			return nil, "", err
		}
		calls++
		return []byte(`{"data":[]}`), "application/json", nil
	}
	stale := task
	stale.LeaseOwner = "previous-process"
	_, _, err := s.sendImageSubmissionWith(context.Background(), stale, row, send, noImageWait)
	if err == nil || calls != 0 {
		t.Fatal("stale lease sent")
	}
	_, _, err = s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait)
	var unknown imageRecoveryError
	if !errors.As(err, &unknown) || calls != 1 {
		t.Fatalf("malformed response err=%v", err)
	}
	row.CreatedAt = time.Now().Add(-imageRecoveryLifetime - time.Minute)
	_, _, err = s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait)
	if err == nil || calls != 1 {
		t.Fatal("expired request replayed")
	}
	var stored model.ImageSubmission
	if err := db.First(&stored).Error; err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(stored)
	if string(encoded) != "{}" {
		t.Fatal("snapshot fields exposed")
	}
}

func TestImageSubmissionConcurrentWorkersClaimOneSend(t *testing.T) {
	s, _, task, row, _ := imageSubmissionFixture(t, false)
	var admitted atomic.Int32
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			copy := *row
			if s.repo.ClaimImageSubmissionSend(&copy, task.LeaseOwner, imageRecoveryMaxSends) == nil {
				admitted.Add(1)
			}
		}()
	}
	workers.Wait()
	if admitted.Load() != 1 {
		t.Fatalf("concurrent sends admitted=%d", admitted.Load())
	}
}

func TestImageSubmissionNewAttemptAndSnapshotCommitTogether(t *testing.T) {
	s, db, task, _, _ := imageSubmissionFixture(t, false)
	if err := db.Migrator().DropTable(&model.ImageSubmission{}); err != nil {
		t.Fatal(err)
	}
	attempt := &model.RouteAttempt{ID: "must-rollback", TaskID: task.ID, AttemptNumber: 2}
	err := s.repo.CreateImageRetry(attempt, &model.ImageSubmission{AttemptID: attempt.ID, TaskID: task.ID, UserID: task.UserID})
	if err == nil {
		t.Fatal("missing snapshot table accepted")
	}
	var count int64
	if err := db.Model(&model.RouteAttempt{}).Where("id = ?", attempt.ID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("orphan attempt count=%d err=%v", count, err)
	}
}

func TestImageSubmissionLogicalThrottleAndRestartKeepFrozenRoute(t *testing.T) {
	s, db, task, row, body := imageSubmissionFixture(t, true)
	task.LogicalModelID = "logical"
	task.RouteID = "route"
	attempt, _ := s.repo.LatestRouteAttempt(task.ID)
	attempt.AttemptNumber = 1
	attempt.LogicalModelID = "logical"
	attempt.RouteID = "route"
	attempt.ChannelID = "channel"
	s.finishTaskRouteAttempt(attempt, &task, providerHTTPError{StatusCode: 429, Body: `{"error":{"code":"rate_limit_exceeded"}}`})
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir}
	next, err := restarted.beginTaskRouteAttempt(&task)
	if err != nil || next == nil || next.ID == row.AttemptID || next.AttemptNumber != 2 {
		t.Fatalf("restart next=%+v err=%v", next, err)
	}
	if next.RouteID != attempt.RouteID || next.ChannelID != attempt.ChannelID || next.LogicalModelID != attempt.LogicalModelID {
		t.Fatal("logical route changed")
	}
	frozen, err := s.repo.ImageSubmission(next.ID, task.ID, task.UserID)
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := s.decryptSettingSecret(frozen.RequestCipher)
	var wire imageWireRequest
	_ = json.Unmarshal([]byte(plain), &wire)
	if !bytes.Equal(wire.Body, body) {
		t.Fatal("logical restart rebuilt wire")
	}
	s.finishTaskRouteAttempt(next, &task, providerHTTPError{StatusCode: 429})
	third, err := s.nextRouteAttemptAfterFailure(&task, next, providerHTTPError{StatusCode: 429})
	if err != nil || third == nil || third.AttemptNumber != 3 || third.RouteID != attempt.RouteID {
		t.Fatalf("logical continuation: %v %v", third, err)
	}
}

func TestImageSubmissionWorkerTimeoutAndLocalSaveFailureDeferSameAttempt(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	if err := s.repo.ClaimImageSubmissionSend(row, task.LeaseOwner, imageRecoveryMaxSends); err != nil {
		t.Fatal(err)
	}
	if !s.shouldDeferImageRecovery(task, imageRecoveryError{context.DeadlineExceeded}, false) {
		t.Fatal("timeout lost resumable request")
	}
	if err := s.repo.MarkImageSubmissionAccepted(row); err != nil {
		t.Fatal(err)
	}
	if !s.shouldDeferImageRecovery(task, errors.New("disk full"), true) {
		t.Fatal("local save failure lost accepted request")
	}
	if s.shouldDeferImageRecovery(task, imageRecoveryError{context.Canceled}, false) {
		t.Fatal("cancel resumed")
	}
	if err := s.repo.DeferRunningTaskForProviderPoll(task.ID, task.LeaseOwner, "正在恢复图片结果", 0); err != nil {
		t.Fatal(err)
	}
	claimed, err := s.repo.ClaimNextTask("restarted-owner", time.Minute)
	if err != nil || claimed == nil || claimed.ID != task.ID {
		t.Fatalf("claim=%v err=%v", claimed, err)
	}
	attempt, err := s.beginTaskRouteAttempt(claimed)
	if err != nil || attempt.ID != row.AttemptID {
		t.Fatalf("deferred attempt=%v err=%v", attempt, err)
	}
	if err := db.Model(row).Update("send_count", imageRecoveryMaxSends).Error; err != nil {
		t.Fatal(err)
	}
	if !s.shouldDeferImageRecovery(*claimed, errors.New("disk full"), true) {
		t.Fatal("accepted receipt was tied to uncertain request budget")
	}
	if err := db.Model(row).Update("response_accepted", false).Error; err != nil {
		t.Fatal(err)
	}
	if s.shouldDeferImageRecovery(*claimed, imageRecoveryError{context.DeadlineExceeded}, false) {
		t.Fatal("uncertain budget deferred forever")
	}
}

func TestImageSubmissionTwelfthSuccessSurvivesStorageFailure(t *testing.T) {
	s, db, task, row, body := imageSubmissionFixture(t, false)
	row.SendCount = 11
	if err := db.Model(row).Update("send_count", 11).Error; err != nil {
		t.Fatal(err)
	}
	key, calls := "", 0
	send := func(req *http.Request, admit func() error) ([]byte, string, error) {
		if err := admit(); err != nil {
			return nil, "", err
		}
		calls++
		actual, _ := io.ReadAll(req.Body)
		if !bytes.Equal(actual, body) {
			t.Fatal("accepted collection rebuilt body")
		}
		if key == "" {
			key = req.Header.Get("Idempotency-Key")
		}
		if req.Header.Get("Idempotency-Key") != key {
			t.Fatal("accepted collection changed key")
		}
		return []byte(`{"data":[{"b64_json":"` + strings.SplitN(testReferenceImageDataURL, ",", 2)[1] + `"}]}`), "application/json", nil
	}
	if _, _, err := s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait); err != nil {
		t.Fatal(err)
	}
	result := map[string]interface{}{"mode": "image", "images": []map[string]string{{"dataUrl": testReferenceImageDataURL}}}
	// Fault the fixed workspace filesystem rather than swapping the service's
	// dataDir: the resource domain deliberately retains one workspace owner.
	blockedRoot := filepath.Join(s.dataDir, "resources")
	if err := os.WriteFile(blockedRoot, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	_, saveErr := s.persistGeneratedMediaResult(task.UserID, result)
	if err := os.Remove(blockedRoot); err != nil {
		t.Fatal(err)
	}
	if saveErr == nil {
		t.Fatal("storage fault injection did not fail")
	}
	if !s.shouldDeferImageRecovery(task, saveErr, true) {
		t.Fatal("twelfth accepted response was abandoned")
	}
	if err := s.deferImageRecovery(task); err != nil {
		t.Fatal(err)
	}
	var waiting model.Task
	if err := db.First(&waiting, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if waiting.NextPollAt == nil || time.Until(*waiting.NextPollAt) < 14*time.Minute {
		t.Fatal("accepted result collection can busy loop")
	}
	if err := db.Model(&task).Update("next_poll_at", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	claimed, err := s.repo.ClaimNextTask("new-owner", time.Minute)
	if err != nil || claimed == nil {
		t.Fatalf("claim=%v err=%v", claimed, err)
	}
	loaded, err := s.repo.ImageSubmission(row.AttemptID, task.ID, task.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.sendImageSubmissionWith(context.Background(), *claimed, loaded, send, noImageWait); err != nil {
		t.Fatal(err)
	}
	if _, err := s.persistGeneratedMediaResult(task.UserID, result); err != nil {
		t.Fatal(err)
	}
	if calls != 2 || loaded.SendCount != 13 {
		t.Fatalf("collection count=%d sends=%d", calls, loaded.SendCount)
	}
}

func TestImageSubmissionCachedFailureDoesNotSpendRecoveryBudget(t *testing.T) {
	err := providerHTTPError{StatusCode: 503, Body: `{"error":{"code":"internal_error"}}`, IdempotencyReplayed: true}
	if retrySameImageSubmission(err) {
		t.Fatal("cached terminal failure replayed repeatedly")
	}
}

func TestImageSubmissionDownloadThrottleCannotBecomeNewPaidAttempt(t *testing.T) {
	s, _, task, row, _ := imageSubmissionFixture(t, false)
	if err := s.repo.MarkImageSubmissionAccepted(row); err != nil {
		t.Fatal(err)
	}
	attempt, _ := s.repo.LatestRouteAttempt(task.ID)
	attempt.AttemptNumber = 1
	downloadErr := providerHTTPError{StatusCode: 429}
	s.finishTaskRouteAttempt(attempt, &task, downloadErr)
	if attempt.DispatchState != "accepted" {
		t.Fatal("download failure erased acceptance")
	}
	if next, err := s.nextRouteAttemptAfterFailure(&task, attempt, downloadErr); err != nil || next != nil {
		t.Fatal("download throttle regenerated image")
	}
	if err := s.validateImageTaskRetry(&task); err == nil {
		t.Fatal("accepted image allowed paid retry")
	}
	if !s.shouldDeferImageRecovery(task, downloadErr, false) {
		t.Fatal("accepted image download throttle could not recover")
	}
	if !s.shouldDeferImageRecovery(task, providerHTTPError{StatusCode: 503}, false) {
		t.Fatal("accepted image download outage could not recover")
	}
	if s.shouldDeferImageRecovery(task, providerHTTPError{StatusCode: 403}, false) {
		t.Fatal("permanent download rejection retried forever")
	}
}

func TestRecoverableImageMissingOwnerSendsZeroUpstream(t *testing.T) {
	s, _, task, row, _ := imageSubmissionFixture(t, false)
	ctx := generation.WithImageReplayProtocol(withProviderAnalytics(context.Background(), s, task), generation.ImageReplayProtocol)
	runtime, ok := generation.RuntimeFromContext(ctx)
	if !ok {
		t.Fatal("analytics did not bind runtime")
	}
	runtime.Images = appImagePort{}
	ctx = generation.WithRuntime(ctx, runtime)
	ctx = context.WithValue(ctx, imageTaskContext{}, task)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://beefapi.com/v1/images/generations", strings.NewReader(`{"prompt":"draw"}`))
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = generation.DoBinary(req)
	if !errors.Is(err, generation.ErrImageOwnerMissing) {
		t.Fatalf("missing owner error = %v", err)
	}

	ctx = generation.WithImageReplayProtocol(withProviderAnalytics(context.Background(), s, task), generation.ImageReplayProtocol)
	ctx = context.WithValue(ctx, imageTaskContext{}, task)
	req, _ = http.NewRequestWithContext(ctx, http.MethodPost, "https://enterprise.beefapi.com/v1/images/generations", strings.NewReader(`{}`))
	_, handled, err := prepareImageSubmission(s, req)
	if !handled || !errors.Is(err, generation.ErrImageOwnerMissing) {
		t.Fatalf("missing attempt: handled=%v err=%v", handled, err)
	}
	_, handled, err = prepareImageSubmission(nil, req)
	if !handled || !errors.Is(err, generation.ErrImageOwnerMissing) {
		t.Fatalf("nil service: handled=%v err=%v", handled, err)
	}
	_ = row
}

func TestTwoImagePortsCannotStealOwner(t *testing.T) {
	s1, db1, task1, row1, _ := imageSubmissionFixture(t, false)
	s2, db2, task2, row2, _ := imageSubmissionFixture(t, false)
	port1 := appImagePort{service: s1}
	port2 := appImagePort{service: s2}
	if port1.service == port2.service {
		t.Fatal("image ports shared a service pointer")
	}

	ctx1 := withProviderSubmissionKey(withProviderAnalytics(context.Background(), s1, task1), &model.RouteAttempt{ID: row1.AttemptID, TaskID: task1.ID})
	ctx1 = generation.WithImageReplayProtocol(ctx1, generation.ImageReplayProtocol)
	ctx1 = context.WithValue(ctx1, imageTaskContext{}, task1)
	req1, _ := http.NewRequestWithContext(ctx1, http.MethodPost, "https://enterprise.beefapi.com/v1/images/generations", strings.NewReader(`{"prompt":"owner-one"}`))
	got, handled, err := prepareImageSubmission(port2.service, req1)
	if err != nil || !handled || got == nil {
		t.Fatalf("cross prepare: handled=%v err=%v", handled, err)
	}
	plain1, err := s1.decryptSettingSecret(row1.RequestCipher)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plain1, "owner-one") {
		t.Fatal("second runtime mutated the first owner's frozen request")
	}
	plain2, err := s2.decryptSettingSecret(row2.RequestCipher)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plain2, "owner-one") && got.AttemptID == row2.AttemptID {
		t.Fatal("second runtime stored the first request as its own frozen body")
	}

	var count1 int64
	if err := db1.Model(&model.ImageSubmission{}).Count(&count1).Error; err != nil {
		t.Fatal(err)
	}
	if count1 != 1 {
		t.Fatalf("first owner submissions = %d", count1)
	}
	_ = db2
	_ = task2
}
