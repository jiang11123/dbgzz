package app

import (
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

func (s *Service) updateChannelPresentation(id string, req ChannelRequest) (*PublicModelChannel, error) {
	if err := modelcatalog.ApplyChannelPresentation(req); err != nil {
		return nil, err
	}
	if req.PublicAlias != nil {
		alias := strings.TrimSpace(*req.PublicAlias)
		req.PublicAlias = &alias
	}
	if err := s.repo.UpdateSystemChannelPresentation(id, req.PublicAlias, req.SortOrder, time.Now()); err != nil {
		return nil, err
	}
	s.invalidateRouteCatalog()
	channel, err := s.repo.AdminSystemChannel(id)
	if err != nil {
		return nil, err
	}
	items, err := s.repo.ChannelModels(id, true)
	if err != nil {
		return nil, err
	}
	public := publicChannel(*channel, true, items)
	return &public, nil
}

type ChannelModelSortRequest struct {
	SortOrder *int `json:"sortOrder"`
}

func (s *Service) UpdateAdminChannelModelSort(actor *model.User, channelID, modelID string, req ChannelModelSortRequest) error {
	if err := s.RequireAdmin(actor); err != nil {
		return err
	}
	if req.SortOrder == nil {
		return BadAuthRequest("请填写排序值")
	}
	if err := validateChannelSortOrder(*req.SortOrder); err != nil {
		return err
	}
	if _, err := s.repo.AdminSystemChannel(channelID); err != nil {
		return err
	}
	if err := s.repo.UpdateChannelModelSort(channelID, modelID, *req.SortOrder, time.Now()); err != nil {
		return err
	}
	s.invalidateRouteCatalog()
	return nil
}
