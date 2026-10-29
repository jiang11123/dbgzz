package asset

import (
	"context"
	"log"
	"math"
	"strings"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
)

const resourceDeletionLease = 2 * time.Minute
const incompleteResourceRetention = time.Hour
const detachedReadyResourceRetention = 24 * time.Hour

func (s *Service) StartDeletionWorker(ctx context.Context, loop func(func(context.Context)) bool) {
	_ = ctx
	if loop == nil {
		return
	}
	loop(func(ctx context.Context) {
		s.DrainDeletionJobs(32)
		s.CleanupExpiredArchivedAssets()
		s.CleanupDetachedResources()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		lastPeriodicCleanup := time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.DrainDeletionJobs(32)
				if time.Since(lastPeriodicCleanup) >= time.Hour {
					s.CleanupExpiredArchivedAssets()
					s.CleanupDetachedResources()
					lastPeriodicCleanup = time.Now()
				}
			}
		}
	})
}

func (s *Service) CleanupDetachedResources() {
	if s == nil || s.repo == nil {
		return
	}
	now := time.Now()
	candidates, err := s.repo.ResourceCleanupCandidates(
		now.Add(-incompleteResourceRetention),
		now.Add(-detachedReadyResourceRetention),
		500,
	)
	if err != nil {
		log.Printf("detached resource cleanup query failed: %v", err)
		return
	}
	byUser := map[string][]model.Resource{}
	for _, resource := range candidates {
		byUser[resource.UserID] = append(byUser[resource.UserID], resource)
	}
	for userID, resources := range byUser {
		if err := s.CleanupDetachedUserResources(userID, resources); err != nil {
			log.Printf("detached resource cleanup failed for user %s: %v", userID, err)
		}
	}
}

func (s *Service) CleanupDetachedUserResources(userID string, candidates []model.Resource) error {
	run := func() error {
		return s.cleanupDetachedUserResourcesLocked(userID, candidates)
	}
	if s != nil && s.lifecycle != nil {
		return s.lifecycle.WithStorageLock(run)
	}
	return run()
}

func (s *Service) cleanupDetachedUserResourcesLocked(userID string, candidates []model.Resource) error {
	if s == nil || s.repo == nil {
		return ResourceMissing()
	}
	resourceIDs := make([]string, 0, len(candidates))
	candidateSet := make(map[string]struct{}, len(candidates))
	for _, resource := range candidates {
		resourceIDs = append(resourceIDs, resource.ID)
		candidateSet[resource.ID] = struct{}{}
	}
	snapshot, err := s.repo.ResourceReferenceSnapshot(userID, "", resourceIDs)
	if err != nil {
		return err
	}
	referenced := map[string]struct{}{}
	if s.lifecycle != nil {
		for resourceID := range s.lifecycle.AppearanceReferencedIDs(resourceIDs) {
			referenced[resourceID] = struct{}{}
		}
	}
	for _, reference := range snapshot.Direct {
		if _, exists := candidateSet[reference.ResourceID]; exists {
			referenced[reference.ResourceID] = struct{}{}
		}
	}
	for _, document := range snapshot.Documents {
		for resourceID := range assets.DocumentReferencedIDs(document.PrimaryJSON, candidateSet) {
			referenced[resourceID] = struct{}{}
		}
		for resourceID := range assets.DocumentReferencedIDs(document.SecondaryJSON, candidateSet) {
			referenced[resourceID] = struct{}{}
		}
	}
	detached := make([]model.Resource, 0, len(candidates))
	for _, resource := range candidates {
		if _, exists := referenced[resource.ID]; !exists {
			detached = append(detached, resource)
		}
	}
	if len(detached) == 0 {
		return nil
	}
	detachedIDs := make([]string, 0, len(detached))
	for _, resource := range detached {
		detachedIDs = append(detachedIDs, resource.ID)
	}
	physicalObjects := map[string]*model.Resource{}
	for index := range detached {
		resource := &detached[index]
		if strings.TrimSpace(resource.ObjectKey) == "" {
			continue
		}
		sharedCount, countErr := s.repo.ResourceStorageReferenceCount(resource, detachedIDs)
		if countErr != nil {
			return countErr
		}
		if sharedCount == 0 {
			physicalObjects[StorageIdentity(resource)] = resource
		}
	}
	deletionJobs := DeletionJobs(userID, physicalObjects)
	if err := s.repo.DeleteDetachedResources(detached, deletionJobs); err != nil {
		return err
	}
	log.Printf("detached resource cleanup: removed %d resource rows for user %s", len(detached), userID)
	if len(deletionJobs) > 0 {
		s.runBackground(func() { s.DrainDeletionJobs(len(deletionJobs)) })
	}
	return nil
}

func (s *Service) CleanupExpiredArchivedAssets() {
	if s == nil || s.lifecycle == nil {
		return
	}
	retentionDays, err := s.lifecycle.RecycleRetentionDays()
	if err != nil || retentionDays <= 0 {
		return
	}
	cutoff := time.Now().Add(-time.Duration(retentionDays) * 24 * time.Hour)
	expired, err := s.repo.FindExpiredArchivedAssets(cutoff, 100)
	if err != nil {
		log.Printf("expired archived assets query failed: %v", err)
		return
	}
	deleted := 0
	for _, asset := range expired {
		if err := s.lifecycle.DeleteUserAsset(asset.UserID, asset.ID); err != nil {
			log.Printf("expired archived asset delete failed for %s: %v", asset.ID, err)
			continue
		}
		deleted++
	}
	if deleted > 0 {
		log.Printf("recycle bin cleanup: deleted %d expired assets (retention: %d days)", deleted, retentionDays)
	}
}

func (s *Service) DrainDeletionJobs(limit int) {
	if s == nil || s.repo == nil {
		return
	}
	owner := s.workerID()
	for index := 0; index < limit; index++ {
		job, err := s.repo.ClaimNextResourceDeletionJob(owner, resourceDeletionLease)
		if err != nil {
			log.Printf("resource deletion worker claim failed: %v", err)
			return
		}
		if job == nil {
			return
		}
		if err := s.deleteOutboxObject(job); err != nil {
			delay := deletionRetryDelay(job.Attempts)
			if retryErr := s.repo.RetryResourceDeletionJob(job.ID, owner, err.Error(), time.Now().Add(delay)); retryErr != nil {
				log.Printf("resource deletion worker retry update failed for %s: %v", job.ID, retryErr)
			}
			continue
		}
		if err := s.repo.CompleteResourceDeletionJob(job.ID, owner); err != nil {
			log.Printf("resource deletion worker completion failed for %s: %v", job.ID, err)
		}
	}
}

func deletionRetryDelay(attempts int) time.Duration {
	exponent := math.Min(float64(max(attempts-1, 0)), 8)
	return time.Duration(math.Pow(2, exponent)) * 15 * time.Second
}
