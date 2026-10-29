package generation

import (
	"context"
	"io"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

// ResourceInfo is the executor view of an owned workspace asset.
// Authorization stays in the app adapter that implements ResourcePort.
type ResourceInfo struct {
	UserID     string
	ID         string
	Status     string
	Kind       string
	MimeType   string
	Provider   string
	Size       int64
	Width      int
	Height     int
	DurationMs int64
}

func (r ResourceInfo) UsesObjectStorage() bool {
	provider := strings.ToLower(strings.TrimSpace(r.Provider))
	return provider != "" && provider != "local"
}

func (r ResourceInfo) LooksLikeImage(media *Media) bool {
	if strings.EqualFold(r.Kind, "image") || strings.HasPrefix(strings.ToLower(r.MimeType), "image/") {
		return true
	}
	if media == nil {
		return false
	}
	return strings.HasPrefix(strings.ToLower(firstNonEmpty(media.MimeType, media.Type)), "image/")
}

type ResourcePort interface {
	Lookup(userID, resourceID string) (ResourceInfo, error)
	Open(userID, resourceID string) (ResourceInfo, io.ReadCloser, error)
	PublicURL(info ResourceInfo, expiresAt time.Time) (string, error)
	HTTPSPublicURL(info ResourceInfo, expiresAt time.Time) (string, error)
	LocalMode() bool
}

type ReferenceStoragePort interface {
	Enabled() (bool, error)
	Upload(ctx context.Context, userID, resourceID string) (string, error)
}

// ResourceMetadataPort repairs missing facts from authorized local bytes.
// It is separate from reads because it can persist a completed probe.
type ResourceMetadataPort interface {
	EnsureMetadata(ctx context.Context, userID, resourceID string) (ResourceInfo, error)
}

type LimitsPort interface {
	GeneratedFileBytes(ctx context.Context) (int64, error)
	ResourceUploadBytes(ctx context.Context) (int64, error)
	CircuitOpen(ctx context.Context, channelID string) (bool, error)
	AcquireChannelSlot(ctx context.Context, channelID, slotID string, timeout time.Duration) (release func(), limit int, err error)
	RecordChannelResult(ctx context.Context, channelID string, failure bool) error
}

type TransportObservation struct {
	Request               *http.Request
	StartedAt             time.Time
	StatusCode            int
	Body                  []byte
	Err                   error
	ResponseLimitBytes    int64
	Dispatched            bool
	TransportPhase        string
	TransportRoute        string
	HTTPStatus            int
	DeclaredResponseBytes int64
	ReceivedBytes         int64
	RequestID             string
	Outcome               string
}

type ReceiptPort interface {
	Observe(observation TransportObservation)
	NotifyPoll(ctx context.Context, event string, err error)
	SyncProgress(taskID string, body []byte)
}

// StagePort reports execution stages without inventing provider progress.
// The adapter owns task identity and lease fencing.
type StagePort interface {
	SetStage(ctx context.Context, stage string) error
}

type ImageSubmissionPort interface {
	Intercept(req *http.Request) (handled bool, data []byte, mimeType string, err error)
}

// WorkflowPort is the typed seam for RunningHub / cloud workflow execution.
// The workflow slice owns the implementation; this package only dispatches.
type WorkflowPort interface {
	Execute(ctx context.Context, input Input) (map[string]interface{}, error)
}

// PromptPort compiles user prompt templates and checks their structured result.
// Video tasks never call Compile: the node prompt is the final prompt.
type PromptPort interface {
	Compile(userID, operation string, values map[string]string) (string, error)
	ValidateResult(operation string, result map[string]any) error
}

// ConfigPort resolves channel secrets, loads image/video capability, and
// performs provider-specific private-asset sync. It is not an app.Service bag.
type ConfigPort interface {
	Resolve(config Config) (Config, error)
	ApplyCapabilities(ctx context.Context, input *Input) error
	RequireWorkflow(interfaceType string) error
	SyncArkPrivateAssets(ctx context.Context, userID string, input *Input) error
}

// StylePort applies the project's style profile to an image generation prompt.
type StylePort interface {
	Apply(userID, projectID string, input *Input) error
}

// MediaProbePort inspects local/inline Seedance 2 reference videos for the
// current execution. A missing port fails closed when a referenced video
// must be probed; it is not a package-level callback.
type MediaProbePort interface {
	ProbeSeedance2Video(config Config, index int, media *Media, data []byte) error
}

// Endpoints holds per-execution test/control-plane URL overrides.
// Production leaves this empty and derives hosts from config/region.
type Endpoints struct {
	BeefAPIVideoBaseURL       string
	ArkPrivateAssetAPIBaseURL string
}

type CallMeta struct {
	UserID            string
	TaskID            string
	ProjectID         string
	TaskType          string
	TraceID           string
	RequestID         string
	Capability        string
	Operation         string
	ChannelID         string
	Model             string
	VideoSeconds      int
	RequestKind       string
	ProviderRequestID string
	ConcurrencyLimit  int
}

// DeliveryProgressPort carries in-generation result download progress (for
// example a video fetched from a gateway before the task succeeds). The adapter
// is bound to the executing BeefTV task and owns identity; provider task ids
// must never be used as the key. nil means nothing is reported.
type DeliveryProgressPort interface {
	ReportDelivery(progress outbound.ResumableProgress)
	ClearDelivery()
}

// VideoDownloadCachePort is bound to the owning local task, not a provider URL.
type VideoDownloadCachePort interface {
	PartialPath() string
}

type Runtime struct {
	ReferenceStorage  ReferenceStoragePort
	Resources         ResourcePort
	Limits            LimitsPort
	Receipts          ReceiptPort
	Stages            StagePort
	Delivery          DeliveryProgressPort
	DownloadCache     VideoDownloadCachePort
	ReferenceProgress ReferenceProgressPort
	Images            ImageSubmissionPort
	Workflow          WorkflowPort
	Prompt            PromptPort
	Config            ConfigPort
	Style             StylePort
	Probe             MediaProbePort
	Call              CallMeta
	Endpoints         Endpoints
}
