package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

const imageRecoveryMaxSends = 12
const imageRecoveryLifetime = 23 * time.Hour
const imageRecoveryWait = 10 * time.Minute
const imageRequestMaxBytes = 64 << 20

type imageAttemptContext struct{}
type imageTaskContext struct{}

type imageWireRequest struct {
	URL            string
	Header         http.Header
	Body           []byte
	ReplayProtocol string
}

func (s *Service) validateImageTaskRetry(task *model.Task) error {
	if task.Type != "canvas_image" {
		return nil
	}
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		if attempt.DispatchState == "submission_unknown" || attempt.DispatchState == "accepted" {
			return BadAuthRequest("图片请求可能已经生成，请保留任务记录并联系支持查询结果，不要重复提交")
		}
		return nil
	}
	if err != nil {
		return err
	}
	if attempt.DispatchState == "rejected_no_job" && !row.ResponseAccepted {
		return nil
	}
	return BadAuthRequest("图片请求可能已经生成，请保留任务记录并联系支持查询结果，不要重复提交")
}

func definiteImageThrottle(err error) bool {
	var upstream providerHTTPError
	return !isImageRecoveryError(err) && errors.As(err, &upstream) && upstream.StatusCode == 429 && classifyProviderHTTP(upstream).Category == generation.CategoryThrottled
}

func definiteMidjourneyCountRejection(err error) bool {
	var upstream providerHTTPError
	if !errors.As(err, &upstream) || upstream.StatusCode < 400 {
		return false
	}
	var body struct {
		TaskID string `json:"task_id"`
		ID     string `json:"id"`
		Error  struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			TaskID  string `json:"task_id"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(upstream.Body), &body) != nil || body.TaskID != "" || body.ID != "" || body.Error.TaskID != "" {
		return false
	}
	return body.Error.Code == "invalid_request" && strings.HasPrefix(strings.ToLower(strings.TrimSpace(body.Error.Message)), "midjourney generates four images per request; n must be 4 or omitted")
}

// A structured VOD parameter failure is a terminal response, even if VOD created
// a task before rejecting its parameters. It is never evidence for an automatic resend.
func definiteVODImageParameterFailure(err error) bool {
	if isImageRecoveryError(err) {
		return false
	}
	var unknown generation.SubmissionUnknownError
	if errors.As(err, &unknown) {
		return false
	}
	var upstream providerHTTPError
	if !errors.As(err, &upstream) || upstream.StatusCode != http.StatusBadRequest {
		return false
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(upstream.Body), &body) != nil {
		return false
	}
	return body.Error.Code == "vod_image_invalid_params" || body.Error.Code == "vod_image_invalid_media"
}

func isImageRecoveryError(err error) bool {
	var recovery imageRecoveryError
	return errors.As(err, &recovery)
}

// Only a definite gateway rate-limit rejection can start a new paid attempt.
// The executor caps the entire logical task to three attempts and backs off.
func (s *Service) retryRejectedImageAttempt(task *model.Task, previous *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error) {
	if previous.DispatchState != "rejected_no_job" || !definiteImageThrottle(taskErr) {
		return nil, nil
	}
	prior, err := s.repo.ImageSubmission(previous.ID, task.ID, task.UserID)
	if err != nil {
		return nil, nil
	}
	if prior.ResponseAccepted {
		return nil, nil
	}
	id, err := s.repo.NextPrefixedID("ATTEMPT")
	if err != nil {
		return nil, err
	}
	attempt := &model.RouteAttempt{ID: id, TaskID: task.ID, RouteRun: task.RouteRun, AttemptNumber: previous.AttemptNumber + 1, ChannelModelID: task.ChannelModelID, Status: "selected", DispatchState: "not_sent", StartedAt: time.Now()}
	attempt.LogicalModelID, attempt.LogicalModelRevisionID = previous.LogicalModelID, previous.LogicalModelRevisionID
	attempt.RouteID, attempt.ChannelID = previous.RouteID, previous.ChannelID
	plain, err := s.decryptSettingSecret(prior.RequestCipher)
	if err != nil {
		return nil, err
	}
	var wire imageWireRequest
	if err := json.Unmarshal([]byte(plain), &wire); err != nil {
		return nil, err
	}
	key, _ := withProviderSubmissionKey(context.Background(), attempt).Value(providerSubmissionKeyContext{}).(string)
	wire.Header.Set("Idempotency-Key", key)
	raw, err := json.Marshal(wire)
	if err != nil {
		return nil, err
	}
	cipher, err := s.encryptSettingSecret(string(raw))
	if err != nil {
		return nil, err
	}
	next := &model.ImageSubmission{AttemptID: id, TaskID: task.ID, UserID: task.UserID, RequestCipher: cipher, CreatedAt: time.Now()}
	if err := s.repo.CreateImageRetry(attempt, next); err != nil {
		return nil, err
	}
	return attempt, nil
}

// A worker timeout and a local result-save failure do not end the upstream
// request. Release this lease so another bounded execution can collect it.
func (s *Service) shouldDeferImageRecovery(task model.Task, taskErr error, providerSucceeded bool) bool {
	if task.Type != "canvas_image" || errors.Is(taskErr, context.Canceled) {
		return false
	}
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil {
		return false
	}
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if err != nil || row.RequestCipher == "" || time.Since(row.CreatedAt) >= imageRecoveryLifetime {
		return false
	}
	if row.ResponseAccepted {
		return providerSucceeded || errors.Is(taskErr, context.DeadlineExceeded) || retrySameImageSubmission(taskErr) || definiteImageThrottle(taskErr)
	}
	return row.SendCount < imageRecoveryMaxSends && isImageRecoveryError(taskErr) && errors.Is(taskErr, context.DeadlineExceeded)
}

func (s *Service) deferImageRecovery(task model.Task) error {
	stage, delay := "正在恢复图片结果", 15*time.Second
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil {
		return err
	}
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if err != nil {
		return err
	}
	if row.ResponseAccepted {
		stage = "图片已生成，保存失败，将稍后重试"
		delay = min(15*time.Minute, time.Minute*time.Duration(1<<min(max(row.SendCount-1, 0), 4)))
	}
	if task.FailureDiagnostics != nil {
		task.FailureDiagnostics.ExecutionResult = "pending"
	}
	return s.repo.DeferRunningTaskForProviderPoll(task.ID, task.LeaseOwner, stage, delay, task.FailureDiagnostics)
}

type imageRecoveryError struct{ cause error }

// This wrapper is only used before the first transport call; it cannot imply
// that a supplier accepted the request or started a paid generation.
type imagePreparationError struct{ cause error }

func (e imagePreparationError) Error() string {
	return "图片请求在本地准备时失败，尚未提交到模型服务"
}
func (e imagePreparationError) Unwrap() error { return e.cause }

func (e imageRecoveryError) Error() string {
	return "图片结果尚未确认，已停止自动重发；请保留任务记录并联系支持查询结果"
}
func (e imageRecoveryError) Unwrap() error { return e.cause }

func recoverableImageEndpoint(req *http.Request) bool {
	return generation.RecoverableImageEndpoint(req)
}

// prepareImageSubmission runs before the first network write. The request is
// encrypted with the existing workspace key, including credentials and media.
// Recoverable BeefAPI canvas_image routes fail closed when the bound owner or
// attempt identity is missing; other hosts decline so the normal POST proceeds.
func prepareImageSubmission(s *Service, req *http.Request) (*model.ImageSubmission, bool, error) {
	if req == nil || !recoverableImageEndpoint(req) {
		return nil, false, nil
	}
	if s == nil {
		return nil, true, generation.ErrImageOwnerMissing
	}
	task, taskOK := req.Context().Value(imageTaskContext{}).(model.Task)
	attemptID, _ := req.Context().Value(imageAttemptContext{}).(string)
	call, _ := generation.CallMetaFromContext(req.Context())
	canvasImage := (taskOK && task.Type == "canvas_image") || strings.HasPrefix(strings.TrimSpace(call.TaskType), "canvas_image")
	if !canvasImage {
		return nil, false, nil
	}
	if !taskOK || attemptID == "" {
		return nil, true, generation.ErrImageOwnerMissing
	}
	key, _ := req.Context().Value(providerSubmissionKeyContext{}).(string)
	if key == "" {
		return nil, true, errors.New("图片请求缺少持久化提交标识")
	}
	row, err := s.repo.ImageSubmission(attemptID, task.ID, task.UserID)
	if err == nil {
		return row, true, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, true, err
	}
	if req.Body == nil {
		return nil, true, errors.New("图片请求内容为空")
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, imageRequestMaxBytes+1))
	_ = req.Body.Close()
	if err != nil {
		return nil, true, err
	}
	if len(body) > imageRequestMaxBytes {
		return nil, true, errors.New("图片请求超过 64 MiB，暂未提交")
	}
	header := req.Header.Clone()
	header.Del("X-Idempotency-Key")
	header.Set("Idempotency-Key", key)
	raw, err := json.Marshal(imageWireRequest{URL: req.URL.String(), Header: header, Body: body, ReplayProtocol: generation.ImageReplayProtocol})
	if err != nil {
		return nil, true, err
	}
	cipher, err := s.encryptSettingSecret(string(raw))
	if err != nil {
		return nil, true, err
	}
	row = &model.ImageSubmission{AttemptID: attemptID, TaskID: task.ID, UserID: task.UserID, RequestCipher: cipher, CreatedAt: time.Now()}
	if err := s.repo.CreateImageSubmission(row); err != nil {
		return nil, true, err
	}
	// A concurrent claimant can only use the first committed request.
	row, err = s.repo.ImageSubmission(attemptID, task.ID, task.UserID)
	return row, true, err
}

func (s *Service) sendImageSubmission(ctx context.Context, task model.Task, row *model.ImageSubmission) ([]byte, string, error) {
	return s.sendImageSubmissionWith(ctx, task, row, func(req *http.Request, admit func() error) ([]byte, string, error) {
		return generation.DoBinaryWithDispatchAdmission(withHTTPRequestRuntime(req), admit)
	}, sleepContext)
}

func (s *Service) sendImageSubmissionWith(ctx context.Context, task model.Task, row *model.ImageSubmission, send func(*http.Request, func() error) ([]byte, string, error), wait func(context.Context, time.Duration) error) ([]byte, string, error) {
	if row.TaskID != task.ID || row.UserID != task.UserID {
		return nil, "", imageRecoveryError{errors.New("图片任务归属不一致")}
	}
	if row.RequestCipher == "" || time.Since(row.CreatedAt) >= imageRecoveryLifetime || (!row.ResponseAccepted && row.SendCount >= imageRecoveryMaxSends) {
		return nil, "", imageRecoveryError{errors.New("图片结果恢复等待已结束")}
	}
	plain, err := s.decryptSettingSecret(row.RequestCipher)
	if err != nil {
		return nil, "", imageRecoveryError{err}
	}
	var wire imageWireRequest
	if err := json.Unmarshal([]byte(plain), &wire); err != nil {
		return nil, "", imageRecoveryError{err}
	}
	deadline := time.Now().Add(imageRecoveryWait)
	if expires := row.CreatedAt.Add(imageRecoveryLifetime); expires.Before(deadline) {
		deadline = expires
	}
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	initialSendCount := row.SendCount
	for {
		if err := ctx.Err(); err != nil {
			return nil, "", imageRecoveryError{err}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, wire.URL, bytes.NewReader(wire.Body))
		if err != nil {
			return nil, "", imageRecoveryError{err}
		}
		req.Header = wire.Header.Clone()
		if wire.ReplayProtocol == generation.ImageReplayProtocol {
			req = req.WithContext(generation.WithImageReplayProtocol(req.Context(), wire.ReplayProtocol))
		} else {
			req, err = generation.NegotiateImageReplay(req)
			if err != nil {
				return nil, "", imageRecoveryError{err}
			}
		}
		if !recoverableImageEndpoint(req) || req.Header.Get("Idempotency-Key") == "" {
			return nil, "", imageRecoveryError{errors.New("图片恢复记录无效")}
		}
		data, mime, sendErr := send(req, func() error {
			if err := ctx.Err(); err != nil {
				return imageRecoveryError{err}
			}
			if err := s.repo.ClaimImageSubmissionSend(row, task.LeaseOwner, imageRecoveryMaxSends); err != nil {
				return imageRecoveryError{err}
			}
			return nil
		})
		if sendErr == nil {
			if err := s.repo.MarkImageSubmissionAccepted(row); err != nil {
				return nil, "", imageRecoveryError{err}
			}
			var payload imageResponse
			if err := json.Unmarshal(data, &payload); err != nil {
				return nil, "", imageRecoveryError{err}
			}
			if _, err := imageDataURLs(payload); err != nil {
				return nil, "", imageRecoveryError{err}
			}
			return data, mime, nil
		}
		if !row.ResponseAccepted && definiteMidjourneyCountRejection(sendErr) {
			return nil, "", sendErr
		}
		if !retrySameImageSubmission(sendErr) {
			var preparation generation.RequestPreparationError
			if errors.As(sendErr, &preparation) {
				return nil, "", sendErr
			}
			var upstream providerHTTPError
			if errors.As(sendErr, &upstream) && (upstream.StatusCode == 409 || upstream.StatusCode == 410 || upstream.StatusCode >= 500) {
				return nil, "", imageRecoveryError{sendErr}
			}
			return nil, "", sendErr
		}
		if (!row.ResponseAccepted && row.SendCount >= imageRecoveryMaxSends) || (row.ResponseAccepted && row.SendCount-initialSendCount >= 3) {
			return nil, "", imageRecoveryError{sendErr}
		}
		delay := time.Second * time.Duration(1<<min(row.SendCount, 5))
		var upstream providerHTTPError
		if errors.As(sendErr, &upstream) && upstream.RetryAfter > delay {
			delay = upstream.RetryAfter
		}
		if err := s.repo.UpdateTaskProgressForLease(task.ID, task.LeaseOwner, "正在恢复图片结果", 0); err != nil {
			return nil, "", imageRecoveryError{err}
		}
		if err := wait(ctx, delay); err != nil {
			return nil, "", imageRecoveryError{err}
		}
	}
}

func retrySameImageSubmission(err error) bool {
	if definiteMidjourneyCountRejection(err) {
		return false
	}
	var preparation generation.RequestPreparationError
	if errors.As(err, &preparation) {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	var circuit providerCircuitOpenError
	if errors.As(err, &circuit) {
		return true
	}
	if code, _ := ChannelSlotFailureDetails(err); code != "" {
		return true
	}
	var upstream providerHTTPError
	if errors.As(err, &upstream) {
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal([]byte(upstream.Body), &body)
		switch body.Error.Code {
		case "image_submission_pending", "image_submission_unavailable", "image_result_unavailable":
			return true
		case "image_result_unknown", "image_result_expired", "idempotency_conflict":
			return false
		}
		if upstream.IdempotencyReplayed {
			return false
		}
		return upstream.StatusCode >= 500 || upstream.StatusCode == 408
	}
	var network net.Error
	return errors.As(err, &network) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF)
}

func (s *Service) recoverImageSubmission(ctx context.Context, task model.Task) (map[string]interface{}, bool, error) {
	attemptID, _ := ctx.Value(imageAttemptContext{}).(string)
	if task.Type != "canvas_image" || attemptID == "" {
		return nil, false, nil
	}
	row, err := s.repo.ImageSubmission(attemptID, task.ID, task.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, nil
	}
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	data, _, err := s.sendImageSubmission(ctx, task, row)
	if err != nil {
		return nil, true, err
	}
	var payload imageResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, true, imageRecoveryError{err}
	}
	images, err := imageDataURLs(payload)
	if err != nil {
		return nil, true, imageRecoveryError{fmt.Errorf("恢复图片响应: %w", err)}
	}
	return map[string]interface{}{"mode": "image", "images": images}, true, nil
}
