package generation

import (
	"fmt"
	"time"

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/provider/workflow"
)

// Capability JSON is owned by modelcatalog. generation aliases the same types
// so request contracts keep identical field names without a second schema.
type ModelCapabilityConfig = modelcatalog.ModelCapabilityConfig
type TextCapabilityConfig = modelcatalog.TextCapabilityConfig
type TextReferenceConfig = modelcatalog.TextReferenceConfig
type ImageCapabilityConfig = modelcatalog.ImageCapabilityConfig
type ImageReferenceConfig = modelcatalog.ImageReferenceConfig
type ImageSizeConfig = modelcatalog.ImageSizeConfig
type ImageSizePreset = modelcatalog.ImageSizePreset
type ImageQualityConfig = modelcatalog.ImageQualityConfig
type ParameterSupport = modelcatalog.ParameterSupport
type VideoCapabilityConfig = modelcatalog.VideoCapabilityConfig
type VideoReferenceConfig = modelcatalog.VideoReferenceConfig
type VideoDurationConfig = modelcatalog.VideoDurationConfig
type VideoBooleanConfig = modelcatalog.VideoBooleanConfig

// Input 是画布生成任务的统一输入合同。
type Input struct {
	Upscale          *UpscaleOptions        `json:"upscale,omitempty"`
	Mode             string                 `json:"mode"`
	Prompt           string                 `json:"prompt"`
	Config           Config                 `json:"config"`
	ReferenceImages  []Media                `json:"referenceImages"`
	ReferenceVideos  []Media                `json:"referenceVideos"`
	ReferenceAudios  []Media                `json:"referenceAudios"`
	TextHistory      []TextMessage          `json:"textHistory"`
	Mask             *Media                 `json:"mask"`
	Metadata         map[string]interface{} `json:"metadata"`
	AgentRequests    *AgentToolRequests     `json:"agentRequests"`
	TextOptions      TextOptions            `json:"textOptions"`
	ImageCapability  *ImageCapabilityConfig `json:"-"`
	StreamText       bool                   `json:"-"`
	MaxOutputTokens  int                    `json:"-"`
	OnTextDelta      func(string)           `json:"-"`
	OnReasoningDelta func(string)           `json:"-"`
	VideoCapability  *VideoCapabilityConfig `json:"-"`
}

type TextOptions struct {
	Stream   *bool `json:"stream"`
	Thinking bool  `json:"thinking"`
}

type AgentToolRequests struct {
	Canonical      *CanonicalAgentRequest `json:"canonical,omitempty"`
	Responses      map[string]interface{} `json:"responses"`
	ChatCompletion map[string]interface{} `json:"chatCompletion"`
	Claude         map[string]interface{} `json:"claude"`
	Gemini         map[string]interface{} `json:"gemini"`
}

// CanonicalAgentRequest 是协议无关的画布 Agent 会话合同（域类型；service 侧仍有同结构实现期间兼容）。
type CanonicalAgentRequest struct {
	Messages       []map[string]interface{} `json:"messages"`
	Tools          []map[string]interface{} `json:"tools"`
	ToolChoice     interface{}              `json:"toolChoice"`
	SystemPrompt   string                   `json:"systemPrompt"`
	PromptCacheKey string                   `json:"promptCacheKey,omitempty"`
}

type TextMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Config struct {
	ChannelID                string                    `json:"channelId"`
	ChannelModelKey          string                    `json:"channelModelKey,omitempty"`
	VariantID                string                    `json:"variantId,omitempty"`
	ProviderModelKey         string                    `json:"providerModelKey,omitempty"`
	APIFormat                string                    `json:"apiFormat"`
	InterfaceType            string                    `json:"interfaceType"`
	BaseURL                  string                    `json:"baseUrl"`
	ReferenceAssetOrigin     string                    `json:"referenceAssetOrigin,omitempty"`
	ReferenceMediaTransport  map[string]string         `json:"referenceMediaTransport,omitempty"`
	APIKey                   string                    `json:"apiKey"`
	SecretKey                string                    `json:"secretKey"`
	Headers                  []outbound.OutboundHeader `json:"headers"`
	Model                    string                    `json:"model"`
	Size                     string                    `json:"size"`
	Quality                  string                    `json:"quality"`
	TransparentBackground    string                    `json:"transparentBackground"`
	SeedreamMode             string                    `json:"seedreamMode,omitempty"`
	SeedreamMaxImages        string                    `json:"seedreamMaxImages,omitempty"`
	SeedreamOutputFormat     string                    `json:"seedreamOutputFormat,omitempty"`
	SeedreamOptimize         string                    `json:"seedreamOptimize,omitempty"`
	SeedreamWatermark        string                    `json:"seedreamWatermark,omitempty"`
	Count                    string                    `json:"count"`
	VideoSeconds             string                    `json:"videoSeconds"`
	VQuality                 string                    `json:"vquality"`
	VideoGenerateAudio       string                    `json:"videoGenerateAudio"`
	VideoWatermark           string                    `json:"videoWatermark"`
	ArkPrivateAssetUpload    string                    `json:"videoArkPrivateAssetUpload"`
	AudioVoice               string                    `json:"audioVoice"`
	AudioFormat              string                    `json:"audioFormat"`
	AudioSpeed               string                    `json:"audioSpeed"`
	AudioInstructions        string                    `json:"audioInstructions"`
	SystemPrompt             string                    `json:"systemPrompt"`
	CapabilityConfig         *ModelCapabilityConfig    `json:"capabilityConfig"`
	VideoCapabilitiesVersion *string                   `json:"videoCapabilitiesVersion,omitempty"`
	WorkflowID               string                    `json:"workflowId"`
	WebappID                 string                    `json:"webappId"`
	WorkflowJSON             map[string]interface{}    `json:"workflowJson"`
	WorkflowFields           []WorkflowField           `json:"workflowFields"`
	RunningHubUseWallet      bool                      `json:"runningHubUseWallet"`
	RunningHubWalletKey      string                    `json:"runningHubWalletApiKey"`
	RunningHubUploadKey      string                    `json:"runningHubUploadApiKey"`
}

type Media struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	DataURL    string `json:"dataUrl"`
	URL        string `json:"url"`
	StorageKey string `json:"storageKey"`
	MimeType   string `json:"mimeType"`
	Bytes      int64  `json:"bytes"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	DurationMs int64  `json:"durationMs"`
}

// WorkflowField 是云端工作流字段描述。实现位于 provider/workflow。
type WorkflowField = workflow.Field

type MediaHydrationPolicy struct {
	ManualURL   bool
	RequireURL  bool
	PreferURL   bool
	PreferHTTPS bool
	KeepLocal   bool
}

type ImageResponse struct {
	Data  []map[string]interface{} `json:"data"`
	Error *UpstreamError           `json:"error"`
	Code  *int                     `json:"code"`
	Msg   string                   `json:"msg"`
}

type UpstreamError struct {
	Message string `json:"message"`
	Code    any    `json:"code"`
	Type    string `json:"type"`
	Param   string `json:"param"`
}

// PayloadError 在进程内保留上游原始原因；对调用方只暴露归类后的稳定文案。
type PayloadError struct {
	raw     string
	message string
}

func NewPayloadError(raw string, message string) PayloadError {
	return PayloadError{raw: raw, message: message}
}

func NewRawPayloadError(raw string) PayloadError {
	return NewPayloadError(raw, ClassifyText(raw).UserMessage())
}

func (e PayloadError) Raw() string { return e.raw }

func (e PayloadError) Message() string { return e.message }

// HTTPError 是上游 HTTP 失败的结构化错误。Error() 走 ClassifyHTTP，保留正文供归类。
type HTTPError struct {
	RequestID           string
	StatusCode          int
	Status              string
	Body                string
	RetryAfter          time.Duration
	IdempotencyReplayed bool
}

type ResponseDecodeError struct {
	Err error
}

func (e ResponseDecodeError) Error() string { return e.Err.Error() }
func (e ResponseDecodeError) Unwrap() error { return e.Err }

type CircuitOpenError struct{}

func (CircuitOpenError) Error() string {
	return "当前渠道连续失败，已暂时熔断，请稍后重试"
}

// StatePendingError 表示上游任务状态尚未同步，应继续查询原任务。
type StatePendingError struct {
	TaskID string
	Cause  error
}

func (e StatePendingError) Error() string {
	return fmt.Sprintf("上游任务状态尚未同步，将继续查询原任务（任务 %s）", e.TaskID)
}

func (e StatePendingError) Unwrap() error { return e.Cause }
