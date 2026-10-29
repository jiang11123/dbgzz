package model

import "time"

type Task struct {
	CreationSubmissionID *string `json:"creationSubmissionId,omitempty" gorm:"size:36;uniqueIndex"`
	ID                   string  `json:"id" gorm:"primaryKey;size:36"`
	UserID               string  `json:"userId" gorm:"index;size:36;index:idx_tasks_user_created,priority:1;index:idx_tasks_user_project_created,priority:1;uniqueIndex:idx_tasks_user_client_op,priority:1"`
	TraceID              string  `json:"-" gorm:"index;size:96"`
	RequestID            string  `json:"-" gorm:"index;size:96"`
	ProjectID            string  `json:"projectId" gorm:"index;size:80;index:idx_tasks_user_project_created,priority:2"`
	// ClientOperationID 是一次用户确认的稳定身份。空值不参与去重；同一个用户重复提交同一确认时回读原任务。
	ClientOperationID      *string    `json:"clientOperationId,omitempty" gorm:"size:128;uniqueIndex:idx_tasks_user_client_op,priority:2"`
	ClientOperationHash    string     `json:"-" gorm:"size:64"`
	Type                   string     `json:"type" gorm:"index;size:64"`
	Status                 TaskStatus `json:"status" gorm:"index;size:24;index:idx_tasks_status_created,priority:1;index:idx_tasks_claim,priority:1;index:idx_tasks_provider_cancel,priority:1"`
	Stage                  string     `json:"stage" gorm:"size:80"`
	Progress               int        `json:"progress"`
	Prompt                 string     `json:"prompt"`
	Operation              string     `json:"operation" gorm:"size:64"`
	Provider               string     `json:"provider" gorm:"size:64"`
	Model                  string     `json:"model" gorm:"size:120"`
	LogicalModelID         string     `json:"logicalModelId,omitempty" gorm:"size:36;index"`
	LogicalModelRevisionID string     `json:"logicalModelRevisionId,omitempty" gorm:"size:36;index"`
	RouteID                string     `json:"routeId,omitempty" gorm:"size:36;index"`
	ChannelModelID         string     `json:"channelModelId,omitempty" gorm:"size:36;index"`
	// RouteRun 只在用户主动重试时递增；worker 租约恢复不应创建新的路由选择世代。
	RouteRun                  int                     `json:"-" gorm:"index"`
	ProviderRequestID         string                  `json:"providerRequestId,omitempty" gorm:"index;size:160"`
	ProviderCancelStatus      ProviderCancelStatus    `json:"providerCancelStatus,omitempty" gorm:"index;size:24;index:idx_tasks_provider_cancel,priority:2"`
	ProviderCancelError       string                  `json:"providerCancelError,omitempty" gorm:"type:text"`
	ProviderCancelAttempts    int                     `json:"providerCancelAttempts,omitempty"`
	ProviderCancelRequestedAt *time.Time              `json:"providerCancelRequestedAt,omitempty"`
	ProviderCancelledAt       *time.Time              `json:"providerCancelledAt,omitempty"`
	ProviderCancelNextCheckAt *time.Time              `json:"providerCancelNextCheckAt,omitempty" gorm:"index:idx_tasks_provider_cancel,priority:3"`
	PollStage                 string                  `json:"pollStage,omitempty" gorm:"size:32"`
	NextPollAt                *time.Time              `json:"nextPollAt,omitempty" gorm:"index"`
	LeaseOwner                string                  `json:"-" gorm:"index;size:120"`
	LeaseExpiresAt            *time.Time              `json:"-" gorm:"index;index:idx_tasks_claim,priority:2"`
	InputJSON                 string                  `json:"inputJson" gorm:"type:text"`
	ResultJSON                string                  `json:"resultJson" gorm:"type:text"`
	TextDraft                 string                  `json:"textDraft,omitempty" gorm:"type:text"`
	Error                     string                  `json:"error"`
	ErrorCode                 string                  `json:"errorCode,omitempty" gorm:"-"`
	ResultState               string                  `json:"resultState,omitempty" gorm:"-"`
	Outputs                   []TaskOutput            `json:"outputs,omitempty" gorm:"-"`
	Delivery                  *TaskDeliveryProgress   `json:"delivery,omitempty" gorm:"-"`
	ReferenceProgress         *TaskReferenceProgress  `json:"referenceProgress,omitempty" gorm:"-"`
	FailureDiagnostics        *TaskFailureDiagnostics `json:"failureDiagnostics,omitempty" gorm:"serializer:json;type:text"`
	Attempts                  int                     `json:"attempts"`
	StartedAt                 *time.Time              `json:"startedAt"`
	CompletedAt               *time.Time              `json:"completedAt"`
	CreatedAt                 time.Time               `json:"createdAt" gorm:"index:idx_tasks_user_created,priority:2;index:idx_tasks_status_created,priority:2;index:idx_tasks_claim,priority:3;index:idx_tasks_user_project_created,priority:3"`
	UpdatedAt                 time.Time               `json:"updatedAt"`

	// WorkflowSourceCipher retains the canonical successful command privately,
	// before public completion projections remove media and provider settings.
	WorkflowSourceCipher string `json:"-" gorm:"type:text"`
}

// TaskFailureDiagnostics contains bounded, redacted evidence, never request bodies.
type TaskFailureDiagnostics struct {
	Version         string                `json:"version,omitempty"`
	Platform        string                `json:"platform,omitempty"`
	ExecutionResult string                `json:"executionResult,omitempty"`
	Requests        []TaskRequestEvidence `json:"requests,omitempty"`
	OmittedRequests int                   `json:"omittedRequests,omitempty"`
	Input           *TaskDiagnosticInput  `json:"input,omitempty"`
	Source          string                `json:"source"`
	Summary         string                `json:"summary,omitempty"`
	ProviderCode    string                `json:"providerCode,omitempty"`
	HTTPStatus      int                   `json:"httpStatus,omitempty"`
	RequestID       string                `json:"requestId,omitempty"`
	ProviderTaskID  string                `json:"providerTaskId,omitempty"`
	Param           string                `json:"param,omitempty"`
	Stage           string                `json:"stage,omitempty"`
	FailedOperation string                `json:"failedOperation,omitempty"`
	TransportPhase  string                `json:"transportPhase,omitempty"`
	CapturedAt      string                `json:"capturedAt,omitempty"`
}

type TaskRequestEvidence struct {
	Operation             string `json:"operation"`
	Method                string `json:"method"`
	Dispatched            bool   `json:"dispatched"`
	TransportPhase        string `json:"transportPhase,omitempty"`
	TransportRoute        string `json:"transportRoute,omitempty"`
	Attempt               int    `json:"attempt,omitempty"`
	Outcome               string `json:"outcome"`
	HTTPStatus            int    `json:"httpStatus,omitempty"`
	RequestID             string `json:"requestId,omitempty"`
	ProviderCode          string `json:"providerCode,omitempty"`
	Summary               string `json:"summary,omitempty"`
	StartedAt             string `json:"startedAt"`
	DurationMS            int64  `json:"durationMs"`
	RequestBytes          int64  `json:"requestBytes,omitempty"`
	ReceivedBytes         int64  `json:"receivedBytes,omitempty"`
	DeclaredResponseBytes int64  `json:"declaredResponseBytes,omitempty"`
	ResponseLimitBytes    int64  `json:"responseLimitBytes,omitempty"`
}

type TaskDiagnosticInput struct {
	Protocol            string                `json:"protocol,omitempty"`
	Model               string                `json:"model,omitempty"`
	Size                string                `json:"size,omitempty"`
	Quality             string                `json:"quality,omitempty"`
	Count               string                `json:"count,omitempty"`
	PromptChars         int                   `json:"promptChars"`
	ImageCount          int                   `json:"imageCount"`
	VideoCount          int                   `json:"videoCount"`
	AudioCount          int                   `json:"audioCount"`
	Images              []TaskDiagnosticMedia `json:"images,omitempty"`
	ImageLimitsRecorded bool                  `json:"imageLimitsRecorded"`
	MaxImages           int                   `json:"maxImages"`
	MaxImageBytes       int64                 `json:"maxImageBytes"`
}

type TaskDiagnosticMedia struct {
	Bytes  int64 `json:"bytes,omitempty"`
	Width  int   `json:"width,omitempty"`
	Height int   `json:"height,omitempty"`
}

// TaskTextDelta 只保存可回放窗口内的文本增量；最终正文和失败草稿分别归并到 Task.ResultJSON 与 Task.TextDraft。
type TaskTextDelta struct {
	ID        string    `json:"id" gorm:"primaryKey;size:36"`
	UserID    string    `json:"userId" gorm:"index;size:36;index:idx_task_text_deltas_user_created,priority:1"`
	TaskID    string    `json:"taskId" gorm:"index;size:36;uniqueIndex:idx_task_text_deltas_sequence,priority:1"`
	Sequence  int64     `json:"sequence" gorm:"uniqueIndex:idx_task_text_deltas_sequence,priority:2"`
	Content   string    `json:"content" gorm:"type:text"`
	ByteCount int64     `json:"byteCount"`
	CreatedAt time.Time `json:"createdAt" gorm:"index:idx_task_text_deltas_user_created,priority:2"`
	ExpiresAt time.Time `json:"expiresAt" gorm:"index"`
}

type TaskLog struct {
	Summary   string    `json:"summary,omitempty" gorm:"-"`
	ID        string    `json:"id" gorm:"primaryKey;size:36"`
	UserID    string    `json:"userId" gorm:"index;size:36"`
	TaskID    string    `json:"taskId" gorm:"index;size:36"`
	TraceID   string    `json:"-" gorm:"index;size:96"`
	RequestID string    `json:"-" gorm:"index;size:96"`
	Level     string    `json:"level" gorm:"size:24"`
	Message   string    `json:"message"`
	Payload   string    `json:"payload" gorm:"type:text"`
	CreatedAt time.Time `json:"createdAt"`
}

type Result struct {
	ID        string    `json:"id" gorm:"primaryKey;size:36"`
	UserID    string    `json:"userId" gorm:"index;size:36"`
	TaskID    string    `json:"taskId" gorm:"index;size:36"`
	Kind      string    `json:"kind" gorm:"size:64"`
	URL       string    `json:"url"`
	Payload   string    `json:"payload" gorm:"type:text"`
	CreatedAt time.Time `json:"createdAt"`
}

// TaskOutput is the public generation product identity. It is projected from
// durable Result rows and is not a database column.
type TaskOutput struct {
	OutputIndex              int               `json:"outputIndex"`
	MediaType                string            `json:"mediaType"`
	ProviderArtifactRef      string            `json:"providerArtifactRef,omitempty"`
	MaterializedAssetID      string            `json:"materializedAssetId,omitempty"`
	MaterializationErrorCode string            `json:"materializationErrorCode,omitempty"`
	ResourceID               string            `json:"resourceId,omitempty"`
	EffectKey                string            `json:"effectKey,omitempty"`
	TargetBinding            *TaskOutputTarget `json:"targetBinding,omitempty"`
}

type TaskOutputTarget struct {
	NodeID         string `json:"nodeId,omitempty"`
	MessageID      string `json:"messageId,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
	Source         string `json:"source,omitempty"`
}

// TaskDeliveryProgress is a transient, process-local view of in-flight artifact
// downloads. It is never persisted and is absent once delivery finishes.
type TaskDeliveryProgress struct {
	Outputs []TaskDeliveryOutputProgress `json:"outputs"`
}

// Observations only; never contains an upstream URL, upload ticket or local path.
type TaskReferenceProgress struct {
	Label          string `json:"label"`
	Phase          string `json:"phase"`
	LoadedBytes    int64  `json:"loadedBytes"`
	TotalBytes     int64  `json:"totalBytes"`
	BytesPerSecond int64  `json:"bytesPerSecond"`
	StartedAt      int64  `json:"startedAt"`
	UpdatedAt      int64  `json:"updatedAt"`
}

type TaskDeliveryOutputProgress struct {
	OutputIndex     int    `json:"outputIndex"`
	DownloadedBytes int64  `json:"downloadedBytes"`
	TotalBytes      int64  `json:"totalBytes"`
	BytesPerSecond  int64  `json:"bytesPerSecond"`
	UpdatedAt       int64  `json:"updatedAt"`
	State           string `json:"state"`
}
