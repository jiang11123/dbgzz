package generation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/platform"
)

const DefaultVideoPollInterval = 30 * time.Second

const beefAPIVideoPollInterval = 5 * time.Second

type VideoPollPolicy struct {
	QueryStage            string
	InitialDelay          time.Duration
	Interval              time.Duration
	MaxNotFoundMisses     int
	MaxMalformedResponses int
	MaxDownloadTries      int
	RetryTransient        bool
	Sleep                 func(context.Context, time.Duration) error
	Notify                func(context.Context, string, VideoPollEvent, error)
}

type VideoPollEvent string

const (
	VideoPollEventRetrying  VideoPollEvent = "retrying"
	VideoPollEventRecovered VideoPollEvent = "recovered"
)

type VideoPollOutcome struct {
	Done   bool
	Result map[string]interface{}
}

type VideoDownloadError struct {
	TaskID string
	Cause  error
}

func (e VideoDownloadError) Error() string {
	if strings.TrimSpace(e.TaskID) == "" {
		return fmt.Sprintf("视频结果下载失败：%v", e.Cause)
	}
	return fmt.Sprintf("视频结果下载失败（任务 %s）：%v", e.TaskID, e.Cause)
}

func (e VideoDownloadError) Unwrap() error { return e.Cause }

func DefaultVideoPollPolicy() VideoPollPolicy {
	return VideoPollPolicy{
		InitialDelay:          DefaultVideoPollInterval,
		Interval:              DefaultVideoPollInterval,
		MaxNotFoundMisses:     3,
		MaxMalformedResponses: 3,
		MaxDownloadTries:      3,
		RetryTransient:        true,
		Sleep:                 SleepContext,
		Notify:                NotifyPollEvent,
	}
}

func videoPollPolicyForConfig(ctx context.Context, config Config, policy VideoPollPolicy) VideoPollPolicy {
	if IsBeefAPIVideoConfig(ctx, config) {
		if policy.InitialDelay == DefaultVideoPollInterval {
			policy.InitialDelay = beefAPIVideoPollInterval
		}
		if policy.Interval == DefaultVideoPollInterval {
			policy.Interval = beefAPIVideoPollInterval
		}
	}
	return policy
}

func RunVideoPollLoop(ctx context.Context, taskID string, policy VideoPollPolicy, query func(context.Context) (VideoPollOutcome, error)) (map[string]interface{}, error) {
	policy = NormalizeVideoPollPolicy(policy)
	runtime, _ := RuntimeFromContext(ctx)
	if err := setExecutionStage(ctx, runtime, policy.QueryStage); err != nil {
		return nil, err
	}
	deadline := PollingDeadline(ctx)
	pollContext, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	ctx = pollContext
	nextDelay := policy.InitialDelay
	notFoundMisses := 0
	malformedResponses := 0
	retrying := false
	for time.Now().Before(deadline) {
		if nextDelay > 0 {
			if err := policy.Sleep(ctx, nextDelay); err != nil {
				return nil, err
			}
		}
		outcome, err := query(ctx)
		if err != nil {
			if !policy.RetryTransient {
				return nil, err
			}
			retry, notFound := RetryableVideoPollError(ctx, err)
			if !retry {
				return nil, err
			}
			malformed := IsTransientResponseDecodeError(err)
			if malformed {
				malformedResponses++
				notFoundMisses = 0
				if malformedResponses >= policy.MaxMalformedResponses {
					return nil, err
				}
			} else if notFound {
				malformedResponses = 0
				notFoundMisses++
				if notFoundMisses >= policy.MaxNotFoundMisses {
					return nil, err
				}
			} else {
				malformedResponses = 0
				notFoundMisses = 0
			}
			if !retrying {
				retrying = true
				policy.Notify(ctx, taskID, VideoPollEventRetrying, err)
			}
			nextDelay = max(policy.Interval, ProviderRetryAfter(err))
			continue
		}
		notFoundMisses = 0
		malformedResponses = 0
		nextDelay = policy.Interval
		if retrying {
			retrying = false
			policy.Notify(ctx, taskID, VideoPollEventRecovered, nil)
		}
		if outcome.Done {
			return outcome.Result, nil
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return nil, context.DeadlineExceeded
}

func NormalizeVideoPollPolicy(policy VideoPollPolicy) VideoPollPolicy {
	if policy.QueryStage == "" {
		policy.QueryStage = "正在查询上游任务"
	}
	if policy.Interval <= 0 {
		policy.Interval = DefaultVideoPollInterval
	}
	if policy.MaxNotFoundMisses <= 0 {
		policy.MaxNotFoundMisses = 3
	}
	if policy.MaxMalformedResponses <= 0 {
		policy.MaxMalformedResponses = 3
	}
	if policy.MaxDownloadTries <= 0 {
		policy.MaxDownloadTries = 3
	}
	if policy.Sleep == nil {
		policy.Sleep = SleepContext
	}
	if policy.Notify == nil {
		policy.Notify = func(context.Context, string, VideoPollEvent, error) {}
	}
	return policy
}

func RunVideoDownload(ctx context.Context, taskID string, policy VideoPollPolicy, download func(context.Context) ([]byte, string, error)) ([]byte, string, error) {
	ctx, cancel := context.WithDeadline(ctx, PollingDeadline(ctx))
	defer cancel()
	runtime, _ := RuntimeFromContext(ctx)
	if err := setExecutionStage(ctx, runtime, "正在取回生成结果"); err != nil {
		return nil, "", err
	}
	ctx, cleanup, err := withVideoDownloadPartial(ctx)
	if err != nil {
		return nil, "", err
	}
	defer cleanup()
	policy = NormalizeVideoPollPolicy(policy)
	reporter := newVideoDownloadReporter(runtime.Delivery)
	defer reporter.clear()
	failures := 0
	for attempt := 1; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		data, mimeType, err := download(reporter.beginAttempt(ctx, attempt))
		if err == nil {
			return data, mimeType, nil
		}
		pending := videoResultPending(err)
		// A file still being saved is not a failed transfer. Keep polling the
		// original result until the task deadline, without spending retry slots.
		if !pending {
			failures++
		}
		retry, _ := RetryableVideoPollError(ctx, err)
		if !retry || failures >= policy.MaxDownloadTries {
			return nil, "", VideoDownloadError{TaskID: taskID, Cause: err}
		}
		delay := ProviderRetryAfter(err)
		if delay <= 0 {
			delay = policy.Interval
		}
		reporter.waitForRetry(attempt+1, pending)
		if err := policy.Sleep(ctx, delay); err != nil {
			return nil, "", err
		}
	}
}

func videoResultPending(err error) bool {
	var httpErr HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	var payload map[string]any
	if json.Unmarshal([]byte(httpErr.Body), &payload) != nil {
		return false
	}
	code, _ := FailureDetails(payload)
	return httpErr.StatusCode == http.StatusServiceUnavailable && code == "video_delivery_pending"
}

func RetryableVideoPollError(ctx context.Context, err error) (retry bool, notFound bool) {
	if err == nil || ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return false, false
	}
	var preparation RequestPreparationError
	if errors.As(err, &preparation) {
		return false, false
	}
	var downloadError VideoDownloadError
	if errors.As(err, &downloadError) {
		return false, false
	}
	var expiredBackup videoBackupLinkExpiredError
	if errors.As(err, &expiredBackup) {
		return true, false
	}
	if code, _ := platform.ChannelSlotFailureDetails(err); code != "" {
		return true, false
	}
	var circuitOpen CircuitOpenError
	if errors.As(err, &circuitOpen) {
		return true, false
	}
	if IsTransientResponseDecodeError(err) {
		return true, false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.ErrClosedPipe) || outbound.IsConnectionInterrupted(err) {
		return true, false
	}
	if errors.Is(err, outbound.ErrResumeRestart) {
		return true, false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true, false
	}
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		if IsProviderTaskNotReadyError(httpErr) {
			return true, true
		}
		if httpErr.StatusCode == http.StatusNotFound {
			return true, true
		}
		switch httpErr.StatusCode {
		case http.StatusRequestTimeout, http.StatusConflict, http.StatusTooEarly, http.StatusTooManyRequests:
			return true, false
		default:
			return httpErr.StatusCode >= http.StatusInternalServerError, false
		}
	}
	var networkError net.Error
	if errors.As(err, &networkError) {
		return networkError.Timeout() || networkError.Temporary(), false
	}
	return false, false
}

func IsTransientResponseDecodeError(err error) bool {
	var decodeError ResponseDecodeError
	if errors.As(err, &decodeError) {
		return true
	}
	var syntaxError *json.SyntaxError
	return errors.As(err, &syntaxError)
}

func NotifyPollEvent(ctx context.Context, _ string, event VideoPollEvent, eventErr error) {
	runtime, ok := RuntimeFromContext(ctx)
	if !ok || runtime.Receipts == nil {
		return
	}
	runtime.Receipts.NotifyPoll(ctx, string(event), eventErr)
}

func IsProviderTaskNotReadyError(httpErr HTTPError) bool {
	if httpErr.StatusCode != http.StatusBadRequest && httpErr.StatusCode != http.StatusNotFound {
		return false
	}
	var payload map[string]any
	if json.Unmarshal([]byte(httpErr.Body), &payload) != nil {
		return false
	}
	code, message := FailureDetails(payload)
	for _, value := range []string{code, message} {
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "task_not_exist", "task_not_found", "task not exist", "task not found":
			return true
		}
	}
	return false
}

func ProviderRetryAfter(err error) time.Duration {
	var httpErr HTTPError
	if errors.As(err, &httpErr) && httpErr.RetryAfter > 0 {
		return httpErr.RetryAfter
	}
	return 0
}
