package task

import (
	"time"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
)

// CreateRequest is the transport-neutral command accepted by the local task
// application boundary. Provider-specific input remains opaque so protocol
// adapters can evolve without coupling HTTP or desktop composition to them.
type CreateRequest struct {
	ProjectID      string         `json:"projectId"`
	Type           string         `json:"type"`
	Operation      string         `json:"operation"`
	Prompt         string         `json:"prompt"`
	Provider       string         `json:"provider"`
	Model          string         `json:"model"`
	LogicalModelID string         `json:"logicalModelId"`
	Input          map[string]any `json:"input"`
	TraceID        string         `json:"-"`
	RequestID      string         `json:"-"`
	// AdmissionID is a trusted internal identity. Transports cannot set it
	// through public JSON; only in-process callers may populate it.
	AdmissionID string `json:"-"`
	// PrepareOnly builds the admitted row without persisting it. Creation
	// quoting uses this so a quote cannot become an accepted generation.
	PrepareOnly bool `json:"-"`
}

// TimelineTranscriptionCreateRequest is the HTTP/local-port command for a
// whisper.cpp transcription task. ClientOperationID is optional.
type TimelineTranscriptionCreateRequest struct {
	Model             string `json:"model,omitempty"`
	ResourceID        string `json:"resourceId"`
	Language          string `json:"language"`
	ProjectID         string `json:"projectId"`
	ClientOperationID string `json:"clientOperationId"`
	TraceID           string `json:"-"`
	RequestID         string `json:"-"`
}

// TimelineRenderCreateRequest is the HTTP/local-port command for a native
// ffmpeg render task. ClientOperationID is optional.
type TimelineRenderCreateRequest struct {
	ProjectID         string          `json:"projectId"`
	Timeline          editing.Project `json:"timeline"`
	Options           editing.Options `json:"options"`
	ClientOperationID string          `json:"clientOperationId"`
	TraceID           string          `json:"-"`
	RequestID         string          `json:"-"`
}

// DepthCaptureCreateRequest is the HTTP/local-port command for local depth
// capture. ClientOperationID is optional.
type DepthCaptureCreateRequest struct {
	ProjectID         string `json:"projectId"`
	NodeID            string `json:"nodeId,omitempty"`
	ResourceID        string `json:"resourceId"`
	ClientOperationID string `json:"clientOperationId"`
	TraceID           string `json:"-"`
	RequestID         string `json:"-"`
}

// TimelineRenderInput is the durable local-executor payload for render tasks.
type TimelineRenderInput struct {
	ProjectID string          `json:"projectId"`
	Timeline  editing.Project `json:"timeline"`
	Options   editing.Options `json:"options"`
}

// TimelineTranscriptionInput is the durable local-executor payload for
// transcription tasks.
type TimelineTranscriptionInput struct {
	Model          string `json:"model,omitempty"`
	ManagedTokenID string `json:"managedTokenId,omitempty"`
	ResourceID     string `json:"resourceId"`
	Language       string `json:"language"`
}

const (
	LocalExecutorRenderPrompt              = "时间线渲染"
	LocalExecutorRenderProvider            = "local"
	LocalExecutorRenderModel               = "ffmpeg"
	LocalExecutorTranscriptionPrompt       = "字幕转写"
	LocalExecutorTranscriptionProvider     = "local"
	LocalExecutorTranscriptionModel        = "whisper.cpp"
	LocalExecutorQueuedStage               = "等待队列调度"
	TimelineTranscriptionFeature           = "timelineTranscription"
	NeedTranscribableMediaMessage          = "必须指定待转写媒体"
	MissingTranscribableMediaMessage       = "无法读取待转写媒体，可能已被删除"
	OnlyAudioVideoTranscriptionMessage     = "仅支持音视频文件转写"
	NoRenderableMediaMessage               = "时间线没有可渲染的媒体片段"
	UnsupportedLocalExecutorTypeMessageFmt = "不支持的本地执行任务类型：%s"
)

type ListOptions struct {
	Limit      int
	ProjectID  string
	ActiveOnly bool
}

// Summary is the stable local read model. It deliberately excludes protected
// provider input and credentials while retaining recovery and preview fields.
type Summary struct {
	ID                        string                        `json:"id"`
	ProjectID                 string                        `json:"projectId,omitempty"`
	Type                      string                        `json:"type"`
	Status                    model.TaskStatus              `json:"status"`
	Stage                     string                        `json:"stage"`
	Progress                  int                           `json:"progress"`
	Prompt                    string                        `json:"prompt"`
	Operation                 string                        `json:"operation,omitempty"`
	Provider                  string                        `json:"provider,omitempty"`
	Model                     string                        `json:"model,omitempty"`
	ProviderRequestID         string                        `json:"providerRequestId,omitempty"`
	ProviderCancelStatus      model.ProviderCancelStatus    `json:"providerCancelStatus,omitempty"`
	ProviderCancelError       string                        `json:"providerCancelError,omitempty"`
	ProviderCancelAttempts    int                           `json:"providerCancelAttempts,omitempty"`
	ProviderCancelRequestedAt *time.Time                    `json:"providerCancelRequestedAt,omitempty"`
	ProviderCancelledAt       *time.Time                    `json:"providerCancelledAt,omitempty"`
	Error                     string                        `json:"error,omitempty"`
	ErrorCode                 string                        `json:"errorCode,omitempty"`
	FailureDiagnostics        *model.TaskFailureDiagnostics `json:"failureDiagnostics,omitempty"`
	PreviewURL                string                        `json:"previewUrl,omitempty"`
	PreviewKind               string                        `json:"previewKind,omitempty"`
	PreviewPosterURL          string                        `json:"previewPosterUrl,omitempty"`
	Attempts                  int                           `json:"attempts"`
	StartedAt                 *time.Time                    `json:"startedAt"`
	CompletedAt               *time.Time                    `json:"completedAt"`
	CreatedAt                 time.Time                     `json:"createdAt"`
	UpdatedAt                 time.Time                     `json:"updatedAt"`
	ClientContext             *ClientContext                `json:"clientContext,omitempty"`
	ResultState               string                        `json:"resultState,omitempty"`
	Outputs                   []CanonicalOutput             `json:"outputs,omitempty"`
	Delivery                  *model.TaskDeliveryProgress   `json:"delivery,omitempty"`
	ReferenceProgress         *model.TaskReferenceProgress  `json:"referenceProgress,omitempty"`
}

type ClientContext struct {
	NodeID           string `json:"nodeId,omitempty"`
	Source           string `json:"source,omitempty"`
	SceneID          string `json:"sceneId,omitempty"`
	ConversationID   string `json:"conversationId,omitempty"`
	MessageID        string `json:"messageId,omitempty"`
	BatchIndex       int    `json:"batchIndex,omitempty"`
	BatchCount       int    `json:"batchCount,omitempty"`
	DomainProjectID  string `json:"domainProjectId,omitempty"`
	ChapterID        string `json:"chapterId,omitempty"`
	ChapterOperation string `json:"chapterOperation,omitempty"`
	ShotID           string `json:"shotId,omitempty"`
	WorkflowStepID   string `json:"workflowStepId,omitempty"`
	ArtifactType     string `json:"artifactType,omitempty"`
}
