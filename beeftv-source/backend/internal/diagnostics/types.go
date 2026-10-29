package diagnostics

import (
	"infinite-canvas/backend/internal/environment"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/supporttrace"
	"time"
)

const (
	SchemaVersion    = 3
	RedactionVersion = 1
	maxWindow        = 24 * time.Hour
	maxClientEvents  = 500
	maxBundleBytes   = 10 << 20
	maxDescription   = 1000
	maxEventText     = 4000
)

type ClientEvent struct {
	LaunchID           string                 `json:"launchId,omitempty"`
	SessionID          string                 `json:"sessionId,omitempty"`
	SpanID             string                 `json:"spanId,omitempty"`
	ClientOperationID  string                 `json:"clientOperationId,omitempty"`
	NodeID             string                 `json:"nodeId,omitempty"`
	AssistantSessionID string                 `json:"assistantSessionId,omitempty"`
	AssistantTurnID    string                 `json:"assistantTurnId,omitempty"`
	Media              *MediaEvidence         `json:"media,omitempty"`
	CanvasBinding      *CanvasBindingEvidence `json:"canvasBinding,omitempty"`
	Reason             string                 `json:"reason,omitempty"`
	ID                 string                 `json:"id"`
	Timestamp          string                 `json:"timestamp"`
	Level              string                 `json:"level"`
	Category           string                 `json:"category"`
	Code               string                 `json:"code,omitempty"`
	Message            string                 `json:"message"`
	Route              string                 `json:"route,omitempty"`
	DurationMs         int64                  `json:"durationMs,omitempty"`
	HTTPStatus         int                    `json:"httpStatus,omitempty"`
	RequestID          string                 `json:"requestId,omitempty"`
	TraceID            string                 `json:"traceId,omitempty"`
	TaskID             string                 `json:"taskId,omitempty"`
	ProjectID          string                 `json:"projectId,omitempty"`
	CanvasID           string                 `json:"canvasId,omitempty"`
	Stack              string                 `json:"stack,omitempty"`
}

type Runtime struct {
	Capabilities *ClientCapabilities `json:"capabilities,omitempty"`
	AppVersion   string              `json:"appVersion,omitempty"`
	BuildCommit  string              `json:"buildCommit,omitempty"`
	Browser      string              `json:"browser,omitempty"`
	OS           string              `json:"os,omitempty"`
	Timezone     string              `json:"timezone,omitempty"`
}

type ExportRequest struct {
	ClientCoverage *ClientCoverage `json:"clientCoverage,omitempty"`
	From           string          `json:"from"`
	To             string          `json:"to"`
	TaskID         string          `json:"taskId,omitempty"`
	ProjectID      string          `json:"projectId,omitempty"`
	Description    string          `json:"description,omitempty"`
	Runtime        Runtime         `json:"runtime"`
	ClientEvents   []ClientEvent   `json:"clientEvents"`
}

type Preview struct {
	AssistantTurnCount     int                          `json:"assistantTurnCount"`
	AssistantEvidenceCount int                          `json:"assistantEvidenceCount"`
	BackendEventCount      int                          `json:"backendEventCount"`
	ResourcesCount         int                          `json:"resourcesCount"`
	Collectors             map[string]CollectorCoverage `json:"collectors"`
	CanvasBindingCount     int                          `json:"canvasBindingCount"`
	UpdateLog              *updateLogSummary            `json:"updateLog,omitempty"`
	ClientEventLimit       int                          `json:"clientEventLimit"`
	TaskCount              int                          `json:"taskCount"`
	TaskLogCount           int                          `json:"taskLogCount"`
	APICallCount           int                          `json:"apiCallCount"`
	EstimatedBytes         int64                        `json:"estimatedBytes"`
	WillTruncate           bool                         `json:"willTruncate"`
}

type Bundle struct {
	BundleID string
	FileName string
	Data     []byte
}

type timeWindow struct {
	From time.Time
	To   time.Time
}

type collection struct {
	collectionErr     error
	ClientCoverage    *ClientCoverage
	TraceCoverage     *supporttrace.Coverage
	Collectors        map[string]CollectorCoverage
	BackendEvents     []supporttrace.Event
	AssistantTurns    []AssistantTurnEvidence
	AssistantEvidence []AssistantRuntimeEvidence
	Resources         []resourceEvidence
	Findings          []Finding
	Environment       environment.Report
	UpdateLog         *updateLogSummary
	Window            timeWindow
	Description       string
	TaskID            string
	ProjectID         string
	Runtime           runtimeRecord
	ClientEvents      []clientEventRecord
	Tasks             []taskRecord
	CanvasBindings    []canvasBindingRecord
	TaskLogs          []taskLogRecord
	APICalls          []apiCallRecord
	ModelConfig       *modelConfigSummary
	Truncated         bool
}

// modelConfigSummary is the redacted model-configuration view written to the
// bundle. It never carries apiKey, secretKey, header values, full URLs or
// query strings — only the base-URL host.
type modelConfigSummary struct {
	Channels []channelConfigSummary `json:"channels"`
	Defaults defaultModelSelection  `json:"defaults"`
}

type channelConfigSummary struct {
	ID            string             `json:"id"`
	Name          string             `json:"name,omitempty"`
	APIFormat     string             `json:"apiFormat,omitempty"`
	InterfaceType string             `json:"interfaceType,omitempty"`
	Scope         string             `json:"scope,omitempty"`
	Enabled       bool               `json:"enabled"`
	BaseURLHost   string             `json:"baseUrlHost,omitempty"`
	ModelCount    int                `json:"modelCount"`
	Models        []modelConfigEntry `json:"models"`
}

type modelConfigEntry struct {
	Model      string `json:"model"`
	Capability string `json:"capability,omitempty"`
	Protocol   string `json:"protocol,omitempty"`
}

type defaultModelSelection struct {
	ImageModel     string `json:"imageModel,omitempty"`
	VideoModel     string `json:"videoModel,omitempty"`
	TextModel      string `json:"textModel,omitempty"`
	AudioModel     string `json:"audioModel,omitempty"`
	AssistantModel string `json:"assistantModel,omitempty"`
}

type runtimeRecord struct {
	Capabilities *ClientCapabilities `json:"capabilities,omitempty"`
	AppVersion   string              `json:"appVersion,omitempty"`
	BuildCommit  string              `json:"buildCommit,omitempty"`
	Browser      string              `json:"browser,omitempty"`
	OS           string              `json:"os,omitempty"`
	Timezone     string              `json:"timezone,omitempty"`
}

// Fixed boolean fields prevent client-supplied environment reports from
// smuggling URLs, paths, credentials or arbitrary text into a bundle.
type ClientCapabilities struct {
	StorageWritable *bool `json:"storageWritable,omitempty"`
	StorageTimedOut *bool `json:"storageTimedOut,omitempty"`
	SecureRandom    *bool `json:"secureRandom,omitempty"`
	RandomUUID      *bool `json:"randomUUID,omitempty"`
	StructuredClone *bool `json:"structuredClone,omitempty"`
	IndexedDB       *bool `json:"indexedDB,omitempty"`
	WebGL           *bool `json:"webGL,omitempty"`
	H264            *bool `json:"h264,omitempty"`
	HEVC            *bool `json:"hevc,omitempty"`
}

type clientEventRecord struct {
	LaunchID           string                 `json:"launchId,omitempty"`
	SessionID          string                 `json:"sessionId,omitempty"`
	SpanID             string                 `json:"spanId,omitempty"`
	ClientOperationID  string                 `json:"clientOperationId,omitempty"`
	NodeID             string                 `json:"nodeId,omitempty"`
	AssistantSessionID string                 `json:"assistantSessionId,omitempty"`
	AssistantTurnID    string                 `json:"assistantTurnId,omitempty"`
	Media              *MediaEvidence         `json:"media,omitempty"`
	CanvasBinding      *CanvasBindingEvidence `json:"canvasBinding,omitempty"`
	Reason             string                 `json:"reason,omitempty"`
	ID                 string                 `json:"id,omitempty"`
	Timestamp          string                 `json:"timestamp,omitempty"`
	Level              string                 `json:"level,omitempty"`
	Category           string                 `json:"category,omitempty"`
	Code               string                 `json:"code,omitempty"`
	Message            string                 `json:"message,omitempty"`
	Route              string                 `json:"route,omitempty"`
	DurationMs         int64                  `json:"durationMs,omitempty"`
	HTTPStatus         int                    `json:"httpStatus,omitempty"`
	RequestID          string                 `json:"requestId,omitempty"`
	TraceID            string                 `json:"traceId,omitempty"`
	TaskID             string                 `json:"taskId,omitempty"`
	ProjectID          string                 `json:"projectId,omitempty"`
	CanvasID           string                 `json:"canvasId,omitempty"`
	Stack              string                 `json:"stack,omitempty"`
}

type taskRecord struct {
	ClientOperationID  string                        `json:"clientOperationId,omitempty"`
	NodeID             string                        `json:"nodeId,omitempty"`
	OutputNodeIDs      []string                      `json:"outputNodeIds,omitempty"`
	FailureDiagnostics *model.TaskFailureDiagnostics `json:"failureDiagnostics,omitempty"`
	ID                 string                        `json:"id"`
	TraceID            string                        `json:"traceId,omitempty"`
	RequestID          string                        `json:"requestId,omitempty"`
	ProjectID          string                        `json:"projectId,omitempty"`
	Type               string                        `json:"type,omitempty"`
	Status             string                        `json:"status,omitempty"`
	Stage              string                        `json:"stage,omitempty"`
	Progress           int                           `json:"progress,omitempty"`
	Operation          string                        `json:"operation,omitempty"`
	Provider           string                        `json:"provider,omitempty"`
	Model              string                        `json:"model,omitempty"`
	LogicalModelID     string                        `json:"logicalModelId,omitempty"`
	ProviderRequestID  string                        `json:"providerRequestId,omitempty"`
	Error              string                        `json:"error,omitempty"`
	Attempts           int                           `json:"attempts,omitempty"`
	StartedAt          *time.Time                    `json:"startedAt,omitempty"`
	CompletedAt        *time.Time                    `json:"completedAt,omitempty"`
	CreatedAt          time.Time                     `json:"createdAt"`
	UpdatedAt          time.Time                     `json:"updatedAt"`
}

type taskLogRecord struct {
	ID        string    `json:"id"`
	TaskID    string    `json:"taskId,omitempty"`
	TraceID   string    `json:"traceId,omitempty"`
	RequestID string    `json:"requestId,omitempty"`
	Level     string    `json:"level,omitempty"`
	Message   string    `json:"message,omitempty"`
	Payload   string    `json:"payload,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type apiCallRecord struct {
	ID                string    `json:"id"`
	TraceID           string    `json:"traceId,omitempty"`
	RequestID         string    `json:"requestId,omitempty"`
	ChannelID         string    `json:"channelId,omitempty"`
	TaskID            string    `json:"taskId,omitempty"`
	Source            string    `json:"source,omitempty"`
	Capability        string    `json:"capability,omitempty"`
	Operation         string    `json:"operation,omitempty"`
	RequestKind       string    `json:"requestKind,omitempty"`
	APIFormat         string    `json:"apiFormat,omitempty"`
	Method            string    `json:"method,omitempty"`
	Path              string    `json:"path,omitempty"`
	Model             string    `json:"model,omitempty"`
	Status            string    `json:"status,omitempty"`
	StatusCode        int       `json:"statusCode,omitempty"`
	DurationMs        int64     `json:"durationMs,omitempty"`
	PollCount         int       `json:"pollCount,omitempty"`
	ProviderStatus    string    `json:"providerStatus,omitempty"`
	ProviderRequestID string    `json:"providerRequestId,omitempty"`
	ErrorCode         string    `json:"errorCode,omitempty"`
	Error             string    `json:"error,omitempty"`
	StartedAt         time.Time `json:"startedAt"`
	CreatedAt         time.Time `json:"createdAt"`
}

type manifest struct {
	Collectors       map[string]CollectorCoverage `json:"collectors"`
	SchemaVersion    int                          `json:"schemaVersion"`
	BundleID         string                       `json:"bundleId"`
	GeneratedAt      time.Time                    `json:"generatedAt"`
	AppVersion       string                       `json:"appVersion,omitempty"`
	BuildCommit      string                       `json:"buildCommit,omitempty"`
	TimeRange        timeRange                    `json:"timeRange"`
	TaskID           string                       `json:"taskId,omitempty"`
	ProjectID        string                       `json:"projectId,omitempty"`
	Description      string                       `json:"description,omitempty"`
	RedactionVersion int                          `json:"redactionVersion"`
	Truncated        bool                         `json:"truncated,omitempty"`
	Counts           counts                       `json:"counts"`
}

type timeRange struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}

type counts struct {
	BackendEvents     int `json:"backendEvents"`
	AssistantTurns    int `json:"assistantTurns"`
	AssistantEvidence int `json:"assistantEvidence"`
	Resources         int `json:"resources"`
	CanvasBindings    int `json:"canvasBindings"`
	ClientEvents      int `json:"clientEvents"`
	Tasks             int `json:"tasks"`
	TaskLogs          int `json:"taskLogs"`
	APICalls          int `json:"upstreamCalls"`
}
