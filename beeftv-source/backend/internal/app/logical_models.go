package app

import (
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

func (s *Service) PublicLogicalModels(intent *ModelRequestIntent) ([]PublicLogicalModel, error) {
	return s.ensureRouter().PublicLogicalModels(intent)
}

func (s *Service) AdminLogicalModels(actor *model.User) ([]AdminLogicalModel, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	items, err := s.repo.LogicalModels(true)
	if err != nil {
		return nil, err
	}
	graphs, err := s.repo.LogicalModelGraphs(items, true)
	if err != nil {
		return nil, err
	}
	systemChannelIDs := make([]string, 0)
	for _, graph := range graphs {
		if graph == nil {
			continue
		}
		for _, channelModel := range graph.ChannelModels {
			systemChannelIDs = append(systemChannelIDs, channelModel.ChannelID)
		}
	}
	systemChannels, err := s.repo.SystemChannelsByIDs(systemChannelIDs, true)
	if err != nil {
		return nil, err
	}
	systemChannelByID := make(map[string]model.ModelChannel, len(systemChannels))
	for _, channel := range systemChannels {
		systemChannelByID[channel.ID] = channel
	}
	result := make([]AdminLogicalModel, 0, len(items))
	for _, item := range items {
		graph := graphs[item.ID]
		if graph == nil || graph.Revision == nil {
			continue
		}
		admin, buildErr := modelcatalog.BuildAdminLogicalModel(item, catalogGraphFromRepo(graph), systemChannelByID)
		if buildErr != nil {
			return nil, buildErr
		}
		result = append(result, *admin)
	}
	return result, nil
}

func (s *Service) SaveAdminLogicalModel(actor *model.User, id string, req LogicalModelRequest) (*AdminLogicalModel, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	item, revision, routes, creating, err := s.logicalModelBundle(actor, id, req)
	if err != nil {
		return nil, err
	}
	if err := s.repo.SaveLogicalModelBundle(item, revision, routes, creating); err != nil {
		return nil, err
	}
	s.invalidateRouteCatalog()
	if err := s.appendAdminAudit(actor, map[bool]string{true: "logical_model.create", false: "logical_model.update"}[creating], "logical_model", item.ID, "保存前台模型及供应线路", map[string]any{"revisionId": revision.ID, "routeCount": len(routes)}); err != nil {
		return nil, err
	}
	graph, err := s.repo.LogicalModelGraph(item.ID, true)
	if err != nil {
		return nil, err
	}
	channelIDs := make([]string, 0, len(graph.ChannelModels))
	for _, channelModel := range graph.ChannelModels {
		channelIDs = append(channelIDs, channelModel.ChannelID)
	}
	systemChannels, err := s.repo.SystemChannelsByIDs(channelIDs, true)
	if err != nil {
		return nil, err
	}
	systemChannelByID := make(map[string]model.ModelChannel, len(systemChannels))
	for _, channel := range systemChannels {
		systemChannelByID[channel.ID] = channel
	}
	return modelcatalog.BuildAdminLogicalModel(*item, catalogGraphFromRepo(graph), systemChannelByID)
}

func (s *Service) DeleteAdminLogicalModel(actor *model.User, id string) error {
	if err := s.RequireAdmin(actor); err != nil {
		return err
	}
	item, err := s.repo.LogicalModel(strings.TrimSpace(id))
	if logicalModelNotFound(err) {
		return BadAuthRequest("前台模型不存在或已删除")
	}
	if err != nil {
		return err
	}
	if err := modelcatalog.ArchiveLogicalModelGuard(item); err != nil {
		return err
	}
	audit, err := newAdminAuditEvent(actor, "logical_model.archive", "logical_model", item.ID, "归档前台模型", map[string]any{"code": item.Code, "name": item.Name})
	if err != nil {
		return err
	}
	if err := s.repo.ArchiveLogicalModel(item.ID, audit, time.Now()); err != nil {
		if errors.Is(err, repository.ErrLogicalModelInUse) {
			return BadAuthRequest("前台模型仍被排队中或进行中任务使用，请等待任务结束后再归档")
		}
		if logicalModelNotFound(err) {
			return BadAuthRequest("前台模型不存在或已删除")
		}
		return err
	}
	s.invalidateRouteCatalog()
	return nil
}

func (s *Service) logicalModelBundle(actor *model.User, id string, req LogicalModelRequest) (*model.LogicalModel, *model.LogicalModelRevision, []model.LogicalModelRoute, bool, error) {
	actorID := ""
	if actor != nil {
		actorID = actor.ID
	}
	return modelcatalog.PrepareLogicalModelBundle(id, req, modelcatalog.LogicalBundleDeps{
		ChannelModel:       s.repo.ChannelModel,
		SystemChannel:      s.repo.SystemChannel,
		AdminSystemChannel: s.repo.AdminSystemChannel,
		LogicalModel:       s.repo.LogicalModel,
		NextID:             s.repo.NextPrefixedID,
		Now:                time.Now(),
		ActorID:            actorID,
	})
}

func (s *Service) SimulateLogicalModelRoute(actor *model.User, id string, intent ModelRequestIntent) (*RouteSimulationResult, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	return s.ensureRouter().SimulateLogicalModelRoute(id, intent)
}

func logicalModelNotFound(err error) bool { return errors.Is(err, gorm.ErrRecordNotFound) }
