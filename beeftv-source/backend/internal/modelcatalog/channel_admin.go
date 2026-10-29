package modelcatalog

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/platform"
)

func (req ChannelRequest) PresentationOnly() bool {
	return (req.PublicAlias != nil || req.SortOrder != nil) && req.Name == "" && req.BaseURL == "" && req.APIKey == "" && req.SecretKey == "" && req.ConcurrencyLimit == nil && req.UseGlobalConcurrency == nil && req.Models == nil && req.Headers == nil && req.Enabled == nil
}

func ValidateChannelSortOrder(value int) error {
	if value < 0 || value > 999999 {
		return kernel.BadAuthRequest("排序值必须是 0-999999 的整数，数值越小越靠前")
	}
	return nil
}

func NormalizeAdminPage(page int, limit int) (int, int) {
	if page <= 0 {
		page = 1
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	return page, limit
}

func ChannelModelNames(channel model.ModelChannel) []string {
	models := []string{}
	_ = json.Unmarshal([]byte(channel.ModelsJSON), &models)
	return kernel.UniqueNonEmpty(models)
}

func MergeChannelRequest(req ChannelRequest, channel model.ModelChannel) ChannelRequest {
	if strings.TrimSpace(req.Name) == "" {
		req.Name = channel.Name
	}
	if strings.TrimSpace(req.BaseURL) == "" {
		req.BaseURL = channel.BaseURL
	}
	if req.Models == nil {
		req.Models = ChannelModelNames(channel)
	}
	if req.Headers == nil {
		req.Headers, _ = ParseChannelHeadersJSON(channel.HeadersJSON)
	}
	return req
}

func ApplyChannelRequest(req ChannelRequest, channel model.ModelChannel) (model.ModelChannel, error) {
	name := strings.TrimSpace(req.Name)
	baseURL := strings.TrimSpace(req.BaseURL)
	if name == "" {
		return channel, kernel.BadAuthRequest("请填写渠道名称")
	}
	if baseURL == "" {
		return channel, kernel.BadAuthRequest("请填写 Base URL")
	}
	connectionChanged := strings.TrimRight(baseURL, "/") != strings.TrimRight(channel.BaseURL, "/")
	if connectionChanged {
		if _, err := outbound.ValidateOutboundURL(baseURL); err != nil {
			return channel, mapOutboundError(err)
		}
	}
	models := kernel.UniqueNonEmpty(req.Models)
	modelsJSON, _ := json.Marshal(models)
	headersJSON, err := EncodeChannelHeadersJSON(req.Headers)
	if err != nil {
		return channel, err
	}
	channel.Name = name
	if req.PublicAlias != nil {
		alias := strings.TrimSpace(*req.PublicAlias)
		if len([]rune(alias)) > 80 {
			return channel, kernel.BadAuthRequest("前台显示别名不能超过 80 个字符")
		}
		channel.PublicAlias = alias
	}
	if req.SortOrder != nil {
		if err := ValidateChannelSortOrder(*req.SortOrder); err != nil {
			return channel, err
		}
		channel.SortOrder = *req.SortOrder
	}
	channel.BaseURL = strings.TrimRight(baseURL, "/")
	if req.APIKey != "" {
		channel.APIKey = req.APIKey
	}
	if req.SecretKey != "" {
		channel.SecretKey = req.SecretKey
	}
	channel.APIFormat = "openai"
	if req.UseGlobalConcurrency != nil && *req.UseGlobalConcurrency {
		channel.ConcurrencyLimit = 0
	} else if req.ConcurrencyLimit != nil {
		if *req.ConcurrencyLimit < platform.MinChannelConcurrencyLimit || *req.ConcurrencyLimit > platform.MaxChannelConcurrencyLimit {
			return channel, kernel.BadAuthRequest("最大并发数必须是 1-999 的整数")
		}
		channel.ConcurrencyLimit = *req.ConcurrencyLimit
	} else if req.UseGlobalConcurrency != nil {
		return channel, kernel.BadAuthRequest("请填写渠道最大并发数")
	}
	channel.ModelsJSON = string(modelsJSON)
	channel.HeadersJSON = headersJSON
	if req.Enabled != nil {
		channel.Enabled = *req.Enabled
	}
	return channel, nil
}

func ApplyChannelPresentation(req ChannelRequest) error {
	if req.SortOrder != nil {
		if err := ValidateChannelSortOrder(*req.SortOrder); err != nil {
			return err
		}
	}
	if req.PublicAlias != nil {
		alias := strings.TrimSpace(*req.PublicAlias)
		if len([]rune(alias)) > 80 {
			return kernel.BadAuthRequest("前台别名不能超过 80 字")
		}
	}
	return nil
}

func DuplicateChannelName(name string) string {
	const suffix = " - 副本"
	base := []rune(strings.TrimSpace(name))
	if len(base) == 0 {
		base = []rune("系统渠道")
	}
	if len(base)+len([]rune(suffix)) > 80 {
		base = base[:80-len([]rune(suffix))]
	}
	return string(base) + suffix
}

func DuplicateSystemChannelModels(source model.ModelChannel, sourceModels []model.ChannelModel, actorID, channelID string, nextID IDGen) (model.ModelChannel, []model.ChannelModel, []model.ChannelModelVariant, error) {
	if len(sourceModels) == 0 {
		for _, name := range ChannelModelNames(source) {
			sourceModels = append(sourceModels, model.ChannelModel{ModelKey: name, ProviderModelKey: name, DisplayName: name, Enabled: false})
		}
	}
	channel := source
	channel.ID = channelID
	channel.UserID = actorID
	channel.Scope = model.ChannelScopeSystem
	channel.Name = DuplicateChannelName(source.Name)
	channel.CreatedAt = time.Time{}
	channel.UpdatedAt = time.Time{}
	channel.DeletedAt.Valid = false
	channelModels := make([]model.ChannelModel, 0, len(sourceModels))
	variants := make([]model.ChannelModelVariant, 0)
	for _, sourceModel := range sourceModels {
		modelID, idErr := nextID("MODEL")
		if idErr != nil {
			return channel, nil, nil, idErr
		}
		channelModel := sourceModel
		channelModel.ID = modelID
		channelModel.ChannelID = channel.ID
		channelModel.CreatedAt = time.Time{}
		channelModel.UpdatedAt = time.Time{}
		channelModel.DeletedAt.Valid = false
		channelModel.Variants = nil
		channelModels = append(channelModels, channelModel)
		for _, sourceTier := range sourceModel.Variants {
			tierID, tierErr := nextID("PTIER")
			if tierErr != nil {
				return channel, nil, nil, tierErr
			}
			variant := sourceTier
			variant.ID = tierID
			variant.ChannelModelID = channelModel.ID
			variant.Selector = nil
			variant.CreatedAt = time.Time{}
			variant.UpdatedAt = time.Time{}
			variant.DeletedAt.Valid = false
			variants = append(variants, variant)
		}
	}
	return channel, channelModels, variants, nil
}

func PublicChannel(channel model.ModelChannel, admin bool, channelModels []model.ChannelModel) PublicModelChannel {
	models := make([]string, 0, len(channelModels))
	modelProfiles := make([]PublicChannelModelProfile, 0, len(channelModels))
	for _, item := range channelModels {
		if !item.Enabled {
			continue
		}
		models = append(models, item.ModelKey)
		capabilityConfig, decodeErr := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
		if decodeErr == nil && capabilityConfig != nil {
			if normalized, normalizeErr := NormalizeModelCapabilityConfigForModel(item.Capability, string(item.Protocol), kernel.FirstNonEmpty(item.ProviderModelKey, item.ModelKey), capabilityConfig); normalizeErr == nil {
				capabilityConfig = normalized
			}
		}
		modelProfiles = append(modelProfiles, PublicChannelModelProfile{Model: item.ModelKey, DisplayName: item.DisplayName, Icon: item.Icon, Capability: item.Capability, Protocol: item.Protocol, CapabilityConfig: capabilityConfig})
	}
	if len(models) == 0 {
		_ = json.Unmarshal([]byte(channel.ModelsJSON), &models)
	}
	apiKey := ""
	baseURL := channel.BaseURL
	var headers []ChannelHeader
	if channel.Scope == model.ChannelScopeSystem {
		if !admin {
			apiKey = "system"
			baseURL = "/api/ai/system/" + channel.ID
		}
		if admin {
			headers, _ = ParseChannelHeadersJSON(channel.HeadersJSON)
		}
	} else if admin {
		apiKey = channel.APIKey
	}
	name, alias := channel.PublicName(), ""
	if admin {
		name, alias = channel.Name, channel.PublicAlias
	}
	return PublicModelChannel{
		ID:               channel.ID,
		UserID:           channel.UserID,
		Scope:            channel.Scope,
		Enabled:          channel.Enabled,
		Name:             name,
		PublicAlias:      alias,
		SortOrder:        channel.SortOrder,
		BaseURL:          baseURL,
		APIKey:           apiKey,
		APIFormat:        channel.APIFormat,
		ConcurrencyLimit: channel.ConcurrencyLimit,
		Models:           models,
		ModelProfiles:    modelProfiles,
		Headers:          headers,
		HasAPIKey:        strings.TrimSpace(channel.APIKey) != "",
		HasSecretKey:     strings.TrimSpace(channel.SecretKey) != "",
		CreatedAt:        channel.CreatedAt,
		UpdatedAt:        channel.UpdatedAt,
	}
}

func EncodeChannelHeadersJSON(headers []ChannelHeader) (string, error) {
	encoded, err := outbound.EncodeOutboundHeadersJSON(headers)
	return encoded, mapOutboundError(err)
}

func ParseChannelHeadersJSON(raw string) ([]ChannelHeader, error) {
	decoded, err := outbound.ParseOutboundHeadersJSON(raw)
	return decoded, mapOutboundError(err)
}

func mapOutboundError(err error) error {
	if err == nil {
		return nil
	}
	var req *outbound.BadRequestError
	if errors.As(err, &req) {
		return kernel.BadAuthRequest(req.Message)
	}
	return err
}
