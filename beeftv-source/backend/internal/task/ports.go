package task

import (
	"context"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

// Store is the durable task ledger. Callers pass user identity on every read
// so a foreign caller cannot reuse another owner's client operation or row.
type Store interface {
	TaskForUser(userID, id string) (*model.Task, error)
	TaskByClientOperation(userID, key string) (*model.Task, error)
	ActiveTaskCount(userID string) (int64, error)
	CreateWithLimit(task *model.Task, limit int) error
	Retry(userID string, prepared *model.Task, limit int) (*model.Task, error)
	CancelIfStatus(userID, id string, expected model.TaskStatus, now time.Time) (bool, error)
	List(userID string, limit int, projectID string, activeOnly bool) ([]model.Task, error)
	Logs(userID, id string) ([]model.TaskLog, error)
	LatestProviderRequestID(taskID string) (string, error)
}

// Persistence writes a newly admitted row together with quota accounting.
// The implementation must hold the storage critical section around the
// quota read and the insert so a concurrent admit cannot slip past the cap.
type Persistence interface {
	CreateAdmitted(task *model.Task, limit int) error
}

// Catalog is the typed model/config admission seam. Task never imports the
// catalog or provider packages to rebuild routes itself.
type Catalog interface {
	Select(userID string, req SelectRequest) (SelectResult, error)
	PrepareRetry(task *model.Task, input map[string]any) error
	RequireCustomChannels(input map[string]any) error
	ValidateCapability(input map[string]any) error
	HasExecutableVideoConfig(input map[string]any) bool
}

type SelectRequest struct {
	Input          map[string]any
	Model          string
	LogicalModelID string
	Type           string
	Operation      string
}

type SelectResult struct {
	Input    map[string]any
	Binding  *RouteBinding
	Workflow bool
}

// RouteBinding is the durable model identity copied onto an admitted task.
type RouteBinding struct {
	LogicalModelID         string
	LogicalModelRevisionID string
	RouteID                string
	ChannelModelID         string
	Model                  string
	Provider               string
}

// Secrets protects credentials before they are stored and restores them for retry.
type Secrets interface {
	ResolveManaged(input map[string]any) (map[string]any, error)
	Protect(input map[string]any) error
	DecryptInputJSON(raw string) (string, error)
}

// Media rejects embedded payloads that must live in resource storage first.
type Media interface {
	ContainsInlineData(input map[string]any) bool
	ValidateTransport(userID string, input map[string]any) error
}

// Projects confirms the canvas/project scope is still writable.
type Projects interface {
	EnsureActive(userID, canvasOrProjectID string) error
}

// OwnedMedia loads an owner-scoped resource for local executor validation.
// Task never imports asset/app to rebuild authorization itself.
type OwnedMedia interface {
	Resource(userID, id string) (*model.Resource, error)
}

// Features is the workspace capability gate used by local transcription.
type Features interface {
	Require(name string) error
}

// Policy supplies the live active-task cap. Quota bytes stay in Persistence.
type Policy interface {
	ActiveTaskLimit() (int, error)
}

// Runtime is the process lease/drain owner. Cancel stops local wait through
// this port; it does not mint a new upstream request.
type Runtime interface {
	IsDraining() bool
	StopLocalWait(taskID string)
	Dispatch(fn func()) bool
}

// Images preserves same-key image submission recovery: a possibly accepted
// provider receipt cannot become a new paid attempt on retry.
type Images interface {
	ValidateRetry(task *model.Task) error
}

// Failures classifies persisted errors so unknown acceptance stays distinct
// from a terminal local failure.
type Failures interface {
	BlocksRetry(message, stage string) bool
	IsModeration(message string) bool
	Category(message, stage string) generation.FailureCategory
	UserMessage(message string) string
}

// TextReplay identifies frontend-owned text persistence and finalizes it on cancel.
type TextReplay interface {
	IsRequest(input map[string]any) bool
	Finalize(taskID string, status model.TaskStatus) error
}

// ProviderControl sends an upstream cancel for an already accepted request.
type ProviderControl interface {
	RequestCancel(ctx context.Context, task *model.Task) error
}

// Presenter projects durable rows onto the public read model.
type Presenter interface {
	Task(model.Task) *model.Task
	Summaries([]model.Task) []Summary
	Logs([]model.TaskLog) []model.TaskLog
}

// Logger writes an owner-scoped task log. Failures here must not undo admission.
type Logger interface {
	Log(userID, taskID, level, message, payload string) error
}

// Activity records a coarse usage counter after a successful admit.
type Activity interface {
	Record(userID, kind string, n int)
}

// Dependencies are the explicit collaborators of the task domain.
// NewService does not require every port so reads can omit provider-side
// collaborators. Operations fail closed when a port needed on that path is
// missing:
//
//	admit persist: Store, Catalog, Secrets, Media, Projects, Policy, Runtime, TextReplay, Persist, Present
//	admit PrepareOnly: Catalog, Secrets, Media, Projects, Policy, Runtime, TextReplay
//	admit specialized: Store, Projects, Policy, Runtime, Persist, Present
//	  transcription also needs OwnedMedia and Features; depth also needs OwnedMedia
//	retry: Store, Runtime, Images, Failures, Secrets, Catalog, Policy, Projects, Present
//	cancel: Store, Runtime, Present; Provider and TextReplay are optional
//	reads: Store, Present
//
// Logs and Activity are optional. Provider cancel is best-effort after the
// local cancel has already been committed. Specialized local executors never
// require Catalog, Secrets, Media, or TextReplay.
type Dependencies struct {
	BindTranscriptionModel func(string) (string, error)
	Catalog                Catalog
	Secrets                Secrets
	Media                  Media
	Projects               Projects
	Policy                 Policy
	Persist                Persistence
	Runtime                Runtime
	Images                 Images
	Failures               Failures
	TextReplay             TextReplay
	Provider               ProviderControl
	Present                Presenter
	Logs                   Logger
	Activity               Activity
	OwnedMedia             OwnedMedia
	Features               Features
	NewID                  func() string
	Now                    func() time.Time
}
