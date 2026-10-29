package workflow

import (
	"context"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

// Request is one guarded outbound call. Kind is recorded on the provider
// analytics context by the app adapter (create/poll/upload/download/workflow-schema).
type Request struct {
	Kind        string
	Method      string
	URL         string
	Headers     []outbound.OutboundHeader
	ContentType string
	Body        []byte
}

// RequestExecutor runs JSON and binary provider calls through the existing
// outbound/doBinary security boundary. The domain never constructs an http.Client.
type RequestExecutor interface {
	Execute(ctx context.Context, req Request) (body []byte, mimeType string, err error)
}

// MediaLoader reads local data-URL bytes. Public URL fetch stays on RequestExecutor
// after the same public-URL check the previous service path used.
type MediaLoader interface {
	LocalBytes(media Media) ([]byte, string, error)
}

// Receipt records the original upstream task identity after acceptance and
// later poll stages. A failed first write must not create a new upstream task.
type Receipt interface {
	Ready(ctx context.Context) error
	RecordAccepted(ctx context.Context, requestID, stage string, nextPollAt *time.Time) error
	UpdateStage(ctx context.Context, requestID, stage string, nextPollAt *time.Time) error
}

// Progress is optional diagnostic logging (receipt-write failure, poll events).
type Progress interface {
	Log(ctx context.Context, level, message, payload string)
}

// PluginAvailability is the user/plugin authorization gate. Execution must
// not proceed when the RunningHub workflow plugin is disabled for the actor.
type PluginAvailability interface {
	EnsureEnabled(ctx context.Context, interfaceType string) error
}

// TimePolicy supplies clock, sleep, poll deadline, and the legacy 2.5s interval.
// Video poll retry/backoff itself stays on VideoPoller until the provider
// worker owns videoPollPolicy.
type TimePolicy interface {
	Now() time.Time
	Sleep(ctx context.Context, d time.Duration) error
	PollDeadline(ctx context.Context) time.Time
	LegacyPollInterval() time.Duration
}

// PollPolicy is the neutral subset of app videoPollPolicy that this domain
// needs. Mapping to internal/app.videoPollPolicy is an integration seam for
// the provider worker.
type PollPolicy struct {
	InitialDelay          time.Duration
	Interval              time.Duration
	MaxNotFoundMisses     int
	MaxMalformedResponses int
	MaxDownloadTries      int
	RetryTransient        bool
}

// PollOutcome is one video-poll query result.
type PollOutcome struct {
	Done   bool
	Result map[string]interface{}
}

// BinarySource is one result read, with the original provider origin retained
// separately from an expiring media URL. Renewal queries the existing task.
type BinarySource struct {
	ProviderURL      string
	URL              string
	Read             func(context.Context) ([]byte, string, error)
	CredentialValues []string
}

// VideoPoller composes the shared provider video poll/download retry loop.
// This domain owns RunningHub status mapping; the provider worker owns the
// generic transient-retry policy implementation.
type VideoPoller interface {
	Poll(ctx context.Context, taskID string, policy PollPolicy, query func(context.Context) (PollOutcome, error)) (map[string]interface{}, error)
	Download(ctx context.Context, taskID string, policy PollPolicy, source BinarySource, renew func(context.Context) (BinarySource, error)) ([]byte, string, error)
}

// StatusError preserves HTTP status and body so upload-auth detection can
// match the previous providerHTTPError path without importing app.
type StatusError struct {
	StatusCode int
	Body       string
	Err        error
}

func (e StatusError) Error() string {
	if e.Err != nil {
		return e.Err.Error()
	}
	if e.StatusCode > 0 {
		return httpStatusMessage(e.StatusCode)
	}
	return "provider request failed"
}

func (e StatusError) Unwrap() error { return e.Err }

func httpStatusMessage(code int) string {
	if code <= 0 {
		return "provider request failed"
	}
	return "provider request failed"
}

// AcceptedNotRecorded means upstream accepted a task but the local receipt
// was not persisted. Resume the original RequestID; do not create a new task.
type AcceptedNotRecorded struct {
	RequestID string
	Stage     string
	Err       error
}

func (e AcceptedNotRecorded) Error() string {
	id := strings.TrimSpace(e.RequestID)
	if id == "" {
		return "任务已受理，但未能保存任务编号。请继续查询原任务，不要重新提交。"
	}
	return "任务已受理，但未能保存任务编号（" + id + "）。请继续查询原任务，不要重新提交。"
}

func (e AcceptedNotRecorded) Unwrap() error { return e.Err }

// CreateUncertain is a create-path transport, decode, or missing-taskId failure.
// The upstream task may already exist; callers must not start a new paid create.
type CreateUncertain struct {
	Err error
}

func (e CreateUncertain) Error() string {
	if e.Err != nil {
		return e.Err.Error()
	}
	return "提交结果尚未确认"
}

func (e CreateUncertain) Unwrap() error { return e.Err }

type noopProgress struct{}

func (noopProgress) Log(context.Context, string, string, string) {}
