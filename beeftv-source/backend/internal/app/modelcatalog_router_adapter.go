package app

import (
	"context"
	"errors"
	"infinite-canvas/backend/internal/generation"
	"log"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

type catalogLoader struct {
	repo *repository.Repository
}

func (l catalogLoader) Load(ctx context.Context) ([]model.LogicalModel, map[string]modelcatalog.LogicalModelGraph, []model.ModelChannel, error) {
	if l.repo == nil {
		return nil, nil, nil, errors.New("repository unavailable")
	}
	repo := l.repo.WithContext(ctx)
	items, err := repo.LogicalModels(false)
	if err != nil {
		return nil, nil, nil, err
	}
	graphs, err := repo.LogicalModelGraphs(items, false)
	if err != nil {
		return nil, nil, nil, err
	}
	systemChannelIDs := make([]string, 0)
	converted := make(map[string]modelcatalog.LogicalModelGraph, len(graphs))
	for id, graph := range graphs {
		if graph == nil {
			continue
		}
		converted[id] = catalogGraphFromRepo(graph)
		for _, channelModel := range graph.ChannelModels {
			systemChannelIDs = append(systemChannelIDs, channelModel.ChannelID)
		}
	}
	systemChannels, err := repo.SystemChannelsByIDs(systemChannelIDs, false)
	if err != nil {
		return nil, nil, nil, err
	}
	return items, converted, systemChannels, nil
}

func catalogGraphFromRepo(graph *repository.LogicalModelGraph) modelcatalog.LogicalModelGraph {
	if graph == nil {
		return modelcatalog.LogicalModelGraph{}
	}
	return modelcatalog.LogicalModelGraph{Model: graph.Model, Revision: graph.Revision, Routes: graph.Routes, ChannelModels: graph.ChannelModels}
}

type routeStore struct {
	repo *repository.Repository
}

func (s routeStore) NextPrefixedID(prefix string) (string, error) {
	return s.repo.NextPrefixedID(prefix)
}
func (s routeStore) CreateRouteAttempt(item *model.RouteAttempt) error {
	return s.repo.CreateRouteAttempt(item)
}
func (s routeStore) SaveRouteAttempt(item *model.RouteAttempt) error {
	return s.repo.SaveRouteAttempt(item)
}
func (s routeStore) MarkRouteAttemptDispatching(id string) error {
	return s.repo.MarkRouteAttemptDispatching(id)
}
func (s routeStore) RouteAttempts(taskID string, routeRun int) ([]model.RouteAttempt, error) {
	return s.repo.RouteAttempts(taskID, routeRun)
}
func (s routeStore) ChannelModelByID(channelID, id string) (*model.ChannelModel, error) {
	return s.repo.ChannelModelByID(channelID, id)
}
func (s routeStore) ChannelModel(id string) (*model.ChannelModel, error) {
	return s.repo.ChannelModel(id)
}
func (s routeStore) LogicalModel(id string) (*model.LogicalModel, error) {
	return s.repo.LogicalModel(id)
}
func (s routeStore) LogicalModelRevision(id string) (*model.LogicalModelRevision, error) {
	return s.repo.LogicalModelRevision(id)
}
func (s routeStore) LogicalModelRoute(id string) (*model.LogicalModelRoute, error) {
	return s.repo.LogicalModelRoute(id)
}
func (s routeStore) LogicalModelRoutes(revisionID string, includeDisabled bool) ([]model.LogicalModelRoute, error) {
	return s.repo.LogicalModelRoutes(revisionID, includeDisabled)
}
func (s routeStore) ChannelModelsByIDs(ids []string) ([]model.ChannelModel, error) {
	return s.repo.ChannelModelsByIDs(ids)
}
func (s routeStore) SystemChannel(id string) (*model.ModelChannel, error) {
	return s.repo.SystemChannel(id)
}
func (s routeStore) SystemChannelsByIDs(ids []string, includeDisabled bool) ([]model.ModelChannel, error) {
	return s.repo.SystemChannelsByIDs(ids, includeDisabled)
}
func (s routeStore) SwitchTaskLogicalRoute(taskID, expectedRouteID, routeID, inputJSON, channelModelID string) error {
	return s.repo.SwitchTaskLogicalRoute(taskID, expectedRouteID, routeID, inputJSON, channelModelID)
}
func (s routeStore) UpdateTaskProviderState(taskID, providerRequestID, pollStage string, nextPollAt *time.Time) error {
	return s.repo.UpdateTaskProviderState(taskID, providerRequestID, pollStage, nextPollAt)
}

func (s *Service) ensureRouter() *modelcatalog.Router {
	if s == nil {
		return nil
	}
	s.routerMu.Lock()
	defer s.routerMu.Unlock()
	if s.router == nil {
		s.router = modelcatalog.NewRouter(catalogLoader{repo: s.repo}, time.Now, s.routeCatalogSideEffects, s.routeCatalogTTL, s.routeCatalogMaxStale)
	}
	return s.router
}

func (s *Service) routeStore() modelcatalog.RouteStore {
	return routeStore{repo: s.repo}
}

func (s *Service) taskInputCodec() modelcatalog.TaskInputCodec {
	return modelcatalog.TaskInputCodec{
		Decrypt:            s.decryptTaskInputJSON,
		ProtectSecrets:     s.protectTaskSecrets,
		ValidateCapability: s.ValidateTaskCapability,
	}
}

func (s *Service) routeCatalogSideEffects(context.Context) {
	if s.coordinator != nil {
		coordCtx, cancel := context.WithTimeout(context.Background(), runtimeCoordinationTimeout)
		defer cancel()
		if err := s.coordinator.BumpRouteCatalogVersion(coordCtx); err != nil {
			log.Printf("logical model route catalog distributed invalidation failed: %v", err)
		}
	}
	s.initReadCaches()
	if s.routeVersionReadCache != nil {
		s.routeVersionReadCache.Clear()
	}
}

func routeFailureInfo(err error) modelcatalog.FailureInfo {
	info := modelcatalog.FailureInfo{}
	if err == nil {
		return info
	}
	var unknown generation.SubmissionUnknownError
	if errors.As(err, &unknown) {
		// Earlier uncertainty invalidates any nested rejection evidence.
		return info
	}
	if isImageRecoveryError(err) {
		info.ImageRecovery = true
	}
	if code, _ := ChannelSlotFailureDetails(err); code != "" {
		info.SlotCode = code
	}
	var upstream providerHTTPError
	if errors.As(err, &upstream) {
		info.StatusCode = upstream.StatusCode
		info.RetryAfter = upstream.RetryAfter
	}
	info.ImageThrottle = definiteImageThrottle(err)
	var rejection generation.SubmissionRejectedError
	info.ExplicitRejection = definiteMidjourneyCountRejection(err) || errors.As(err, &rejection)
	if definiteVODImageParameterFailure(err) {
		// The gateway includes this marker only for an actual supplier task.
		info.TerminalProviderFailure = strings.Contains(upstream.Body, "upstream_task_id:")
		if !info.TerminalProviderFailure {
			info.ExplicitRejection = true
		}
	}
	var preparation generation.RequestPreparationError
	info.PreparationFailed = errors.As(err, &preparation)
	info.Canceled = errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
	return info
}

func routeFailureCode(err error) string {
	return modelcatalog.RouteFailureCode(routeFailureInfo(err))
}

func safeRouteRejection(err error) bool {
	return modelcatalog.SafeRouteRejection(routeFailureInfo(err))
}

func (s *Service) imageSubmissionView(attempt *model.RouteAttempt, task *model.Task) modelcatalog.ImageSubmissionView {
	if attempt == nil || task == nil {
		return modelcatalog.ImageSubmissionView{}
	}
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if err == nil {
		return modelcatalog.ImageSubmissionView{Found: true, Accepted: row.ResponseAccepted}
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return modelcatalog.ImageSubmissionView{}
	}
	return modelcatalog.ImageSubmissionView{Err: err}
}
