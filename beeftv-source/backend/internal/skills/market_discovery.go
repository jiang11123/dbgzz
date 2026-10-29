package skills

import (
	"context"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/skillhub"
)

func (s *Service) MarketSearch(ctx context.Context, query string, page, pageSize int) (*skillhub.SearchResult, error) {
	client, err := marketClient()
	if err != nil {
		return nil, err
	}
	return client.Search(ctx, query, "beeftv", []string{"beeftv.canvas"}, page, pageSize)
}

func (s *Service) MarketFile(ctx context.Context, id, release, name string, offset, limit int) (*skillhub.FileChunk, error) {
	client, err := marketClient()
	if err != nil {
		return nil, err
	}
	return client.File(ctx, id, release, name, offset, limit)
}

func checkMarketRequirements(requirements []string) error {
	for _, required := range requirements {
		if required != "beeftv.canvas" && required != "model.image" && required != "model.video" && required != "model.audio" {
			return kernel.BadAuthRequest("当前工作区尚未验证技能要求的能力：" + required)
		}
	}
	return nil
}
