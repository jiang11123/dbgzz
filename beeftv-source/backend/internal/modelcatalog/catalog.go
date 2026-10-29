package modelcatalog

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func SanitizeChannelModel(cm *model.ChannelModel) (PublicChannelModel, error) {
	if cm == nil {
		return PublicChannelModel{}, fmt.Errorf("渠道模型为空")
	}
	var capabilityConfig map[string]any
	normalized, err := normalizedChannelModelCapability(cm)
	if err != nil {
		return PublicChannelModel{}, err
	}
	if normalized != nil {
		capabilityConfig, err = ModelCapabilityConfigToMap(normalized)
		if err != nil {
			return PublicChannelModel{}, fmt.Errorf("投影渠道模型能力配置失败：%w", err)
		}
	}
	return PublicChannelModel{
		ID:               cm.ID,
		ModelKey:         cm.ModelKey,
		DisplayName:      cm.DisplayName,
		SortOrder:        cm.SortOrder,
		Icon:             cm.Icon,
		Capability:       cm.Capability,
		Protocol:         cm.Protocol,
		CapabilityConfig: capabilityConfig,
		AudioOptions:     audioGenerationOptions(cm),
		Available:        cm.Enabled,
	}, nil
}

func ChannelModelMatchesIntent(cm *model.ChannelModel, intent *ModelRequestIntent) (bool, error) {
	if cm == nil || intent == nil {
		return true, nil
	}
	if normalizeCapability(intent.Capability) != "" && normalizeCapability(cm.Capability) != normalizeCapability(intent.Capability) {
		return false, nil
	}
	if normalizeCapability(cm.Capability) == "audio" {
		return true, nil
	}
	config, err := normalizedChannelModelCapability(cm)
	if err != nil {
		return false, err
	}
	spec, err := CapabilitySpecFromModelCapabilityConfig(config, cm.Capability)
	if err != nil {
		return false, err
	}
	match := MatchCapability(spec, *intent)
	return match.Matched, nil
}

func ModelCapabilityConfigToMap(config *ModelCapabilityConfig) (map[string]any, error) {
	if config == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func PublicSystemChannelCatalog(channels []model.ModelChannel, modelsForChannel func(channelID string) ([]model.ChannelModel, error), intent *ModelRequestIntent) ([]PublicChannelCatalog, error) {
	result := make([]PublicChannelCatalog, 0, len(channels))
	for _, channel := range channels {
		if !channel.Enabled {
			continue
		}
		channelModels, err := modelsForChannel(channel.ID)
		if err != nil {
			return nil, err
		}
		publicModels := make([]PublicChannelModel, 0, len(channelModels))
		for _, cm := range channelModels {
			if !cm.Enabled {
				continue
			}
			if intent != nil {
				matched, matchErr := ChannelModelMatchesIntent(&cm, intent)
				if matchErr != nil {
					log.Printf("system channel model omitted from catalog id=%s: invalid capability: %v", cm.ID, matchErr)
					continue
				}
				if !matched {
					continue
				}
			}
			publicModel, sanitizeErr := SanitizeChannelModel(&cm)
			if sanitizeErr != nil {
				log.Printf("system channel model omitted from catalog id=%s: %v", cm.ID, sanitizeErr)
				continue
			}
			publicModels = append(publicModels, publicModel)
		}
		if len(publicModels) > 0 {
			result = append(result, PublicChannelCatalog{
				ID:          channel.ID,
				Name:        channel.PublicName(),
				DisplayName: channel.PublicName(),
				SortOrder:   channel.SortOrder,
				Models:      publicModels,
			})
		}
	}
	return result, nil
}

func SystemChannelIDFromBaseURL(baseURL string) string {
	value := strings.TrimSpace(baseURL)
	lowerValue := strings.ToLower(value)
	for _, marker := range []string{"/api/ai/system/", "/api/"} {
		index := strings.LastIndex(lowerValue, marker)
		if index < 0 {
			continue
		}
		id := strings.Trim(value[index+len(marker):], "/")
		if queryIndex := strings.IndexAny(id, "?#"); queryIndex >= 0 {
			id = id[:queryIndex]
		}
		if slash := strings.Index(id, "/"); slash >= 0 {
			continue
		}
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		switch strings.ToLower(id) {
		case "v1", "v1beta", "v2", "v3", "plan", "ai":
			continue
		default:
			return id
		}
	}
	return ""
}

func ProviderChannelModelKey(channelModelKey, modelName string) string {
	return strings.TrimPrefix(strings.TrimSpace(kernel.FirstNonEmpty(channelModelKey, modelName)), "models/")
}

// CatalogSource 决定 CatalogResponse 中哪一个集合具有语义。
// frontend 与 system 的数据形状互斥，调用方不能把缺失集合解释成空目录。
type CatalogSource string

const (
	CatalogSourceFrontend CatalogSource = "frontend"
	CatalogSourceSystem   CatalogSource = "system"
)

// CatalogResponse 是创作端模型选择的统一读模型。
// Source=frontend 时读取 Models；Source=system 时读取 Channels。
// 两个集合都始终序列化为数组：空目录必须发 []，缺字段会被前端判成畸形响应。
type CatalogResponse struct {
	Source   CatalogSource          `json:"source"`
	Models   []PublicLogicalModel   `json:"models"`
	Channels []PublicChannelCatalog `json:"channels"`
}

// NewCatalogResponse 固定互斥数据形状：空目录发 []，未选中的集合不会带上另一侧的数据。
func NewCatalogResponse(source CatalogSource, models []PublicLogicalModel, channels []PublicChannelCatalog) CatalogResponse {
	if models == nil {
		models = []PublicLogicalModel{}
	}
	if channels == nil {
		channels = []PublicChannelCatalog{}
	}
	response := CatalogResponse{
		Source:   source,
		Models:   []PublicLogicalModel{},
		Channels: []PublicChannelCatalog{},
	}
	switch source {
	case CatalogSourceFrontend:
		response.Models = models
	case CatalogSourceSystem:
		response.Channels = channels
	}
	return response
}
