package app

import (
	"context"

	"infinite-canvas/backend/internal/model"
)

func (s *Service) startResourceDeletionWorker(ctx context.Context) {
	s.resourceDomain().StartDeletionWorker(ctx, s.runWorkerLoop)
}

func (s *Service) cleanupDetachedResources() {
	s.resourceDomain().CleanupDetachedResources()
}

func (s *Service) cleanupDetachedUserResources(userID string, candidates []model.Resource) error {
	return s.resourceDomain().CleanupDetachedUserResources(userID, candidates)
}

func (s *Service) cleanupExpiredArchivedAssets() {
	s.resourceDomain().CleanupExpiredArchivedAssets()
}

func (s *Service) drainResourceDeletionJobs(limit int) {
	s.resourceDomain().DrainDeletionJobs(limit)
}
