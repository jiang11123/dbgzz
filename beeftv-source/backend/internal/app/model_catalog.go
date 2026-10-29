package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

type ModelCatalogSource = modelcatalog.CatalogSource
type ModelCatalogResponse = modelcatalog.CatalogResponse

const (
	ModelCatalogSourceFrontend = modelcatalog.CatalogSourceFrontend
	ModelCatalogSourceSystem   = modelcatalog.CatalogSourceSystem
)

// ModelCatalog 按功能开关返回互斥的数据形状：frontend 使用 Models，system 使用 Channels。
// 系统渠道目录只负责安全发布可解释的读模型。
func (s *Service) ModelCatalog(intent *ModelRequestIntent) (*ModelCatalogResponse, error) {
	frontendEnabled, err := s.FeatureEnabled(FeatureFrontendModels)
	if err != nil {
		return nil, err
	}
	if frontendEnabled {
		models, err := s.PublicLogicalModels(intent)
		if err != nil {
			return nil, err
		}
		response := modelcatalog.NewCatalogResponse(modelcatalog.CatalogSourceFrontend, models, nil)
		return &response, nil
	}

	channels, err := s.publicSystemChannelCatalog(intent)
	if err != nil {
		return nil, err
	}
	response := modelcatalog.NewCatalogResponse(modelcatalog.CatalogSourceSystem, nil, channels)
	return &response, nil
}

// publicSystemChannelCatalog 组装普通用户可见的系统渠道读模型，不暴露密钥、Base URL 等执行凭证。
// 这是读展示路径：单个损坏模型被隔离并记录诊断；仓储查询失败仍整体返回错误，避免伪装成空目录。
func (s *Service) publicSystemChannelCatalog(intent *ModelRequestIntent) ([]PublicChannelCatalog, error) {
	channels, err := s.repo.SystemChannels(true)
	if err != nil {
		return nil, err
	}
	return modelcatalog.PublicSystemChannelCatalog(channels, func(channelID string) ([]model.ChannelModel, error) {
		return s.repo.ChannelModels(channelID, false)
	}, intent)
}

func (s *Service) sanitizeChannelModel(cm *model.ChannelModel) (PublicChannelModel, error) {
	return modelcatalog.SanitizeChannelModel(cm)
}

func (s *Service) channelModelMatchesIntent(cm *model.ChannelModel, intent *ModelRequestIntent) (bool, error) {
	return modelcatalog.ChannelModelMatchesIntent(cm, intent)
}
