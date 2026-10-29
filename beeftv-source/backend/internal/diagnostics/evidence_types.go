package diagnostics

import (
	"time"

	"infinite-canvas/backend/internal/model"
)

// CollectorCoverage describes what was actually read, not what was expected to
// exist. OmittedAtLeast is a lower bound; collectors never invent exact totals.
type CollectorCoverage struct {
	Status         string     `json:"status"`
	Records        int        `json:"records"`
	OmittedAtLeast int64      `json:"omittedAtLeast,omitempty"`
	Limit          int        `json:"limit,omitempty"`
	From           *time.Time `json:"from,omitempty"`
	To             *time.Time `json:"to,omitempty"`
	Scope          string     `json:"scope"`
	Reason         string     `json:"reason,omitempty"`
}

type ClientCoverage struct {
	Status          string     `json:"status"`
	LaunchID        string     `json:"launchId"`
	SessionCount    int        `json:"sessionCount"`
	RetainedCount   int        `json:"retainedCount"`
	ExportedCount   int        `json:"exportedCount"`
	DroppedCount    int64      `json:"droppedCount"`
	ExpiredCount    int64      `json:"expiredCount"`
	WriteErrorCount int64      `json:"writeErrorCount"`
	ReadErrorCount  int64      `json:"readErrorCount"`
	OldestAt        *time.Time `json:"oldestAt,omitempty"`
	NewestAt        *time.Time `json:"newestAt,omitempty"`
	MaxAgeHours     int        `json:"maxAgeHours"`
	MaxEvents       int        `json:"maxEvents"`
	MaxBytes        int64      `json:"maxBytes"`
	Persisted       bool       `json:"persisted"`
}

type MediaEvidence struct {
	Phase        string `json:"phase"`
	ReadyState   *int   `json:"readyState,omitempty"`
	NetworkState *int   `json:"networkState,omitempty"`
	ErrorCode    *int   `json:"errorCode,omitempty"`
	Width        *int   `json:"width,omitempty"`
	Height       *int   `json:"height,omitempty"`
}

// AssistantEvidenceProvider projects the official runtime's history. The
// supplied turns were selected by owner and scope; no transcript is accepted.
type AssistantEvidenceProvider interface {
	DiagnosticAssistantEvidence(userID string, from, to time.Time, turns []AssistantTurnEvidence) (AssistantEvidenceSnapshot, error)
}

type AssistantEvidenceSnapshot struct {
	Records  []AssistantRuntimeEvidence
	Coverage CollectorCoverage
}

type AssistantTurnEvidence struct {
	ID                      string    `json:"id"`
	SessionID               string    `json:"sessionId,omitempty"`
	CanvasID                string    `json:"canvasId"`
	State                   string    `json:"state"`
	RevisionBefore          int64     `json:"revisionBefore"`
	CreatedAt               time.Time `json:"createdAt"`
	UpdatedAt               time.Time `json:"updatedAt"`
	Undone                  bool      `json:"undone"`
	ContinuationInvalidated bool      `json:"continuationInvalidated"`
}

type AssistantRuntimeEvidence struct {
	ID            string    `json:"id"`
	SessionID     string    `json:"sessionId,omitempty"`
	TurnID        string    `json:"turnId"`
	CanvasID      string    `json:"canvasId"`
	Kind          string    `json:"kind"`
	Name          string    `json:"name,omitempty"`
	Status        string    `json:"status,omitempty"`
	Reason        string    `json:"reason,omitempty"`
	FailureReason string    `json:"failureReason,omitempty"`
	OperationID   string    `json:"operationId,omitempty"`
	RequestID     string    `json:"requestId,omitempty"`
	Model         string    `json:"model,omitempty"`
	Timestamp     time.Time `json:"timestamp"`
	DurationMs    int64     `json:"durationMs,omitempty"`
}

type assistantTurnStore interface {
	DiagnosticAssistantTurns(userID string, from, to time.Time, canvasID, taskID string) ([]model.AssistantTurn, error)
}

// Resource rows include private storage keys for local inspection. Those keys
// are consumed here and must never be marshalled into the bundle.
type diagnosticResourceStore interface {
	DiagnosticResources(userID string, taskIDs []string) ([]model.AssetRepresentation, []model.AssetVersion, []model.Resource, error)
}

type resourceEvidence struct {
	ID             string    `json:"id"`
	ResourceID     string    `json:"resourceId"`
	TaskID         string    `json:"taskId"`
	AssetID        string    `json:"assetId,omitempty"`
	AssetVersionID string    `json:"assetVersionId,omitempty"`
	Kind           string    `json:"kind,omitempty"`
	Status         string    `json:"status,omitempty"`
	PlaybackStatus string    `json:"playbackStatus,omitempty"`
	Storage        string    `json:"storage"`
	FileStatus     string    `json:"fileStatus"`
	FileSize       *int64    `json:"fileSize,omitempty"`
	RecordedSize   int64     `json:"recordedSize"`
	SampledAt      time.Time `json:"sampledAt"`
}

// Finding reports a stage observation. "confirmed" confirms that observation,
// never an unsupported claim that it explains the entire user-visible failure.
type Finding struct {
	ID              string   `json:"id"`
	Status          string   `json:"status"`
	Stage           string   `json:"stage"`
	Reason          string   `json:"reason"`
	Explanation     string   `json:"explanation"`
	EvidenceRefs    []string `json:"evidenceRefs"`
	MissingEvidence []string `json:"missingEvidence,omitempty"`
}
