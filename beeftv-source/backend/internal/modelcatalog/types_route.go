package modelcatalog

import (
	"encoding/json"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
)

// LogicalModelGraph is the current revision, routes, and channel models for one
// front-end model. Persistence still lives in the repository.
type LogicalModelGraph struct {
	Model         model.LogicalModel
	Revision      *model.LogicalModelRevision
	Routes        []model.LogicalModelRoute
	ChannelModels []model.ChannelModel
}

type CachedLogicalModel struct {
	Model       model.LogicalModel
	Revision    model.LogicalModelRevision
	ProductSpec CapabilitySpec
	Defaults    map[string]any
	Routes      []CachedLogicalRoute
}

type CachedLogicalRoute struct {
	Route          model.LogicalModelRoute
	CapabilitySpec CapabilitySpec
	ChannelModel   model.ChannelModel
}

type RouteCatalog struct {
	LoadedAt       time.Time
	CatalogVersion int64
	Models         map[string]CachedLogicalModel
	Ordered        []string
}

type RoutedModel struct {
	LogicalModel model.LogicalModel
	Revision     model.LogicalModelRevision
	Route        model.LogicalModelRoute
	ChannelModel model.ChannelModel
	Variant      *model.ChannelModelVariant
	Defaults     map[string]any
}

type LogicalModelRequest struct {
	Code        string `json:"code"`
	Name        string `json:"name"`
	Icon        string `json:"icon"`
	Description string `json:"description"`
	Capability  string `json:"capability"`
	Enabled     bool   `json:"enabled"`
	SortOrder   int    `json:"sortOrder"`
	// LegacyModelIDs 只用于将用户本地保存的旧目录选择迁移到当前模型家族，
	// 不能用它重写任务或路由尝试中的不可变快照。
	LegacyModelIDs []string              `json:"legacyModelIds"`
	CapabilitySpec CapabilitySpec        `json:"capabilitySpec"`
	DefaultOptions map[string]any        `json:"defaultOptions"`
	Routes         []LogicalRouteRequest `json:"routes"`
	// SourceChannelModelID 仅供系统渠道同步流程使用。
	SourceChannelModelID string `json:"-"`
}

type LogicalRouteRequest struct {
	ChannelModelID string `json:"channelModelId"`
	Enabled        bool   `json:"enabled"`
	Priority       int    `json:"priority"`
	Weight         int    `json:"weight"`
}

type PublicLogicalModel struct {
	ID             string         `json:"id"`
	Code           string         `json:"code"`
	Name           string         `json:"name"`
	Icon           string         `json:"icon"`
	Description    string         `json:"description"`
	Capability     string         `json:"capability"`
	SortOrder      int            `json:"sortOrder"`
	LegacyModelIDs []string       `json:"legacyModelIds"`
	CapabilitySpec CapabilitySpec `json:"capabilitySpec"`
	// CapabilityProfiles 是创作端可见的匿名能力组合，不暴露其背后的供应线路关系。
	CapabilityProfiles []CapabilitySpec `json:"capabilityProfiles"`
	DefaultOptions     map[string]any   `json:"defaultOptions"`
	Available          bool             `json:"available"`
}

type AdminLogicalRoute struct {
	ID                    string         `json:"id"`
	ChannelModelID        string         `json:"channelModelId"`
	ChannelID             string         `json:"channelId"`
	ChannelModelKey       string         `json:"channelModelKey"`
	ChannelModelName      string         `json:"channelModelName"`
	Enabled               bool           `json:"enabled"`
	Priority              int            `json:"priority"`
	Weight                int            `json:"weight"`
	Available             bool           `json:"available"`
	StructurallyAvailable bool           `json:"-"`
	CapabilitySpec        CapabilitySpec `json:"capabilitySpec"`
}

type AdminLogicalModel struct {
	PublicLogicalModel
	Enabled            bool                `json:"enabled"`
	ActiveRevisionID   string              `json:"activeRevisionId"`
	RevisionVersion    int                 `json:"revisionVersion"`
	ConfigurationError string              `json:"configurationError,omitempty"`
	AvailabilityError  string              `json:"availabilityError,omitempty"`
	Routes             []AdminLogicalRoute `json:"routes"`
}

type RouteSimulationCandidate struct {
	RouteID          string   `json:"routeId"`
	ChannelModelID   string   `json:"channelModelId"`
	ChannelModelKey  string   `json:"channelModelKey"`
	ChannelModelName string   `json:"channelModelName"`
	Priority         int      `json:"priority"`
	Weight           int      `json:"weight"`
	Enabled          bool     `json:"enabled"`
	Matched          bool     `json:"matched"`
	Blocked          bool     `json:"blocked"`
	InPool           bool     `json:"inPool"`
	Reasons          []string `json:"reasons,omitempty"`
}

type RouteSimulationResult struct {
	ProductMatch CapabilityMatch            `json:"productMatch"`
	Candidates   []RouteSimulationCandidate `json:"candidates"`
}

type ChannelHeader = outbound.OutboundHeader

type ChannelRequest struct {
	Name                 string          `json:"name"`
	PublicAlias          *string         `json:"publicAlias"`
	SortOrder            *int            `json:"sortOrder"`
	BaseURL              string          `json:"baseUrl"`
	APIKey               string          `json:"apiKey"`
	SecretKey            string          `json:"secretKey"`
	ConcurrencyLimit     *int            `json:"concurrencyLimit"`
	UseGlobalConcurrency *bool           `json:"useGlobalConcurrency"`
	Models               []string        `json:"models"`
	Headers              []ChannelHeader `json:"headers"`
	Enabled              *bool           `json:"enabled"`
}

type PublicChannelModelProfile struct {
	Model            string                     `json:"model"`
	DisplayName      string                     `json:"displayName"`
	Icon             string                     `json:"icon"`
	Capability       string                     `json:"capability"`
	Protocol         model.ChannelInterfaceType `json:"protocol"`
	CapabilityConfig *ModelCapabilityConfig     `json:"capabilityConfig,omitempty"`
}

type PublicModelChannel struct {
	ID               string                      `json:"id"`
	UserID           string                      `json:"userId"`
	Scope            model.ChannelScope          `json:"scope"`
	Enabled          bool                        `json:"enabled"`
	Name             string                      `json:"name"`
	PublicAlias      string                      `json:"publicAlias,omitempty"`
	SortOrder        int                         `json:"sortOrder"`
	BaseURL          string                      `json:"baseUrl"`
	APIKey           string                      `json:"apiKey"`
	APIFormat        string                      `json:"apiFormat"`
	ConcurrencyLimit int                         `json:"concurrencyLimit"`
	Models           []string                    `json:"models"`
	ModelProfiles    []PublicChannelModelProfile `json:"modelProfiles"`
	Headers          []ChannelHeader             `json:"headers,omitempty"`
	HasAPIKey        bool                        `json:"hasApiKey"`
	HasSecretKey     bool                        `json:"hasSecretKey"`
	CreatedAt        time.Time                   `json:"createdAt"`
	UpdatedAt        time.Time                   `json:"updatedAt"`
}

type AdminChannelPage struct {
	Channels []PublicModelChannel `json:"channels"`
	Total    int64                `json:"total"`
	Page     int                  `json:"page"`
	Limit    int                  `json:"pageSize"`
}

type ChannelModelCatalogItem struct {
	ID                       string                               `json:"id"`
	DisplayName              string                               `json:"displayName,omitempty"`
	ModelType                string                               `json:"modelType,omitempty"`
	SupportedEndpointTypes   []string                             `json:"supportedEndpointTypes,omitempty"`
	DefaultParameters        ChannelModelCatalogDefaultParameters `json:"defaultParameters,omitempty"`
	Options                  ChannelModelCatalogOptions           `json:"options,omitempty"`
	SupportsImages           *bool                                `json:"supportsImages,omitempty"`
	MinImages                *int                                 `json:"minImages,omitempty"`
	MaxImages                *int                                 `json:"maxImages,omitempty"`
	VideoCapabilities        json.RawMessage                      `json:"videoCapabilities,omitempty"`
	VideoCapabilitiesVersion *string                              `json:"videoCapabilitiesVersion,omitempty"`
	VideoPricing             json.RawMessage                      `json:"videoPricing,omitempty"`
}

type ChannelModelCatalogDefaultParameters struct {
	AspectRatio     string `json:"aspectRatio,omitempty"`
	DurationSeconds string `json:"durationSeconds,omitempty"`
	Resolution      string `json:"resolution,omitempty"`
}

type ChannelModelCatalogOptions struct {
	AspectRatio     []ChannelModelCatalogOption `json:"aspectRatio,omitempty"`
	DurationSeconds []ChannelModelCatalogOption `json:"durationSeconds,omitempty"`
	Resolution      []ChannelModelCatalogOption `json:"resolution,omitempty"`
}

type AdminChannelModelFetchResult struct {
	Models []string `json:"models"`
	Added  int64    `json:"added"`
}

type FailureInfo struct {
	StatusCode              int
	RetryAfter              time.Duration
	SlotCode                string
	ImageThrottle           bool
	ImageRecovery           bool
	PreparationFailed       bool
	ExplicitRejection       bool
	TerminalProviderFailure bool
	Canceled                bool
}

type DispatchUncertainError struct{ Message string }

func (e DispatchUncertainError) Error() string { return e.Message }

type CatalogFetchError struct {
	StatusCode int
	Cause      error
}

func (e CatalogFetchError) Error() string {
	if e.Cause != nil {
		return e.Cause.Error()
	}
	return "catalog fetch failed"
}

func (e CatalogFetchError) Unwrap() error { return e.Cause }

type ImageSubmissionView struct {
	Found    bool
	Accepted bool
	Err      error
}
