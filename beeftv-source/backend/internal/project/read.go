package project

import (
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"golang.org/x/sync/errgroup"
)

func (s *Service) ProjectUnitWorkspace(userID string, projectID string, unitID string) (UnitWorkspace, error) {
	if _, err := s.Owned(userID, projectID); err != nil {
		return UnitWorkspace{}, err
	}
	unit, err := s.repo.ProjectUnit(projectID, unitID)
	if err != nil {
		return UnitWorkspace{}, err
	}
	result := UnitWorkspace{Unit: *unit}
	var shotReferences []model.ShotAssetReference
	var group errgroup.Group
	group.Go(func() error {
		var err error
		result.Shots, err = s.repo.ProjectUnitShots(projectID, unitID)
		return err
	})
	group.Go(func() error {
		var err error
		result.ShotRevisions, err = s.repo.ProjectUnitShotRevisions(projectID, unitID)
		return err
	})
	group.Go(func() error {
		var err error
		result.ShotArtifacts, err = s.repo.ProjectUnitShotArtifacts(projectID, unitID)
		return err
	})
	group.Go(func() error {
		var err error
		shotReferences, err = s.repo.ProjectUnitShotAssetReferences(projectID, unitID)
		return err
	})
	group.Go(func() error {
		var err error
		result.AssetCandidates, err = s.repo.ProjectUnitAssetCandidates(projectID, unitID)
		return err
	})
	group.Go(func() error {
		assets, err := s.repo.ProjectUnitAssets(userID, projectID, unitID)
		if err != nil {
			return err
		}
		result.Assets = make([]AssetSummary, len(assets))
		var summaries errgroup.Group
		summaries.SetLimit(8)
		for index := range assets {
			index := index
			summaries.Go(func() error {
				summary, summaryErr := s.assetSummary(userID, projectID, &assets[index])
				if summaryErr == nil {
					result.Assets[index] = summary
				}
				return summaryErr
			})
		}
		return summaries.Wait()
	})
	group.Go(func() error {
		instances, err := s.repo.ProjectWorkflowInstancesForUnit(projectID, unitID)
		if err != nil {
			return err
		}
		result.Workflows = make([]WorkflowDetail, 0, len(instances))
		for _, instance := range instances {
			steps, stepsErr := s.repo.WorkflowSteps(instance.ID)
			if stepsErr != nil {
				return stepsErr
			}
			result.Workflows = append(result.Workflows, WorkflowDetail{Instance: instance, Steps: steps})
		}
		return nil
	})
	if err := group.Wait(); err != nil {
		return UnitWorkspace{}, err
	}
	assetByID := make(map[string]AssetSummary, len(result.Assets))
	for _, asset := range result.Assets {
		assetByID[asset.ID] = asset
	}
	versionIDs := make([]string, 0, len(shotReferences))
	for _, reference := range shotReferences {
		versionIDs = append(versionIDs, reference.AssetVersionID)
	}
	versions, err := s.repo.ProjectAssetVersionsByIDs(projectID, versionIDs)
	if err != nil {
		return UnitWorkspace{}, err
	}
	storedRepresentations, err := s.repo.AssetRepresentationsByVersionIDs(versionIDs)
	if err != nil {
		return UnitWorkspace{}, err
	}
	versionByID := make(map[string]model.AssetVersion, len(versions))
	for _, version := range versions {
		versionByID[version.ID] = version
	}
	representationsByVersionID := make(map[string][]CharacterRepresentationSummary, len(versionIDs))
	for _, representation := range storedRepresentations {
		representationsByVersionID[representation.AssetVersionID] = append(representationsByVersionID[representation.AssetVersionID], CharacterRepresentationSummary{
			ID: representation.ID, ResourceID: representation.ResourceID, MediaType: representation.MediaType, Role: representation.Role,
		})
	}
	result.ShotReferences = make([]ShotAssetReference, 0, len(shotReferences))
	for _, reference := range shotReferences {
		version, exists := versionByID[reference.AssetVersionID]
		if !exists {
			return UnitWorkspace{}, kernel.BadAuthRequest("镜头引用的资产版本不可用")
		}
		asset, exists := assetByID[version.AssetID]
		if !exists {
			return UnitWorkspace{}, kernel.BadAuthRequest("镜头引用的项目资产不可用")
		}
		representations := representationsByVersionID[version.ID]
		if representations == nil {
			representations = []CharacterRepresentationSummary{}
		}
		result.ShotReferences = append(result.ShotReferences, ShotAssetReference{
			ShotAssetReference: reference,
			Asset:              asset,
			ReferencedVersion: ShotAssetReferenceVersion{
				ID: version.ID, AssetID: version.AssetID, Version: version.Version, Representations: representations,
			},
		})
	}
	return result, nil
}

func (s *Service) ProjectAssetCandidatesPage(userID string, projectID string, page int, pageSize int, unitID string, status string, category string, query string) (AssetCandidatePage, error) {
	if _, err := s.Owned(userID, projectID); err != nil {
		return AssetCandidatePage{}, err
	}
	page, pageSize = NormalizePage(page, pageSize, 200)
	candidates, total, err := s.repo.ProjectAssetCandidatesPage(projectID, page, pageSize, unitID, status, category, query)
	if err != nil {
		return AssetCandidatePage{}, err
	}
	return AssetCandidatePage{Candidates: candidates, Page: page, PageSize: pageSize, Total: total, HasMore: int64(page*pageSize) < total}, nil
}

func (s *Service) ProjectAssetsPage(userID string, projectID string, page int, pageSize int, category string, mediaType string, status string, folderID *string, query string) (AssetPage, error) {
	if _, err := s.Owned(userID, projectID); err != nil {
		return AssetPage{}, err
	}
	page, pageSize = NormalizePage(page, pageSize, 80)
	assets, total, err := s.repo.ProjectAssetsPage(userID, projectID, page, pageSize, category, mediaType, status, folderID, query)
	if err != nil {
		return AssetPage{}, err
	}
	summaries := make([]AssetSummary, len(assets))
	var group errgroup.Group
	group.SetLimit(8)
	for index := range assets {
		index := index
		group.Go(func() error {
			summary, summaryErr := s.assetSummary(userID, projectID, &assets[index])
			if summaryErr != nil {
				return summaryErr
			}
			summaries[index] = summary
			return nil
		})
	}
	if err := group.Wait(); err != nil {
		return AssetPage{}, err
	}
	categoryRows, folderRows, err := s.repo.ProjectAssetFacets(projectID)
	if err != nil {
		return AssetPage{}, err
	}
	categoryCounts := make(map[string]int64, len(categoryRows))
	for _, row := range categoryRows {
		categoryCounts[row.Key] = row.Count
	}
	folderCounts := make(map[string]int64, len(folderRows))
	for _, row := range folderRows {
		folderCounts[row.Key] = row.Count
	}
	return AssetPage{Assets: summaries, CategoryCounts: categoryCounts, FolderCounts: folderCounts, Page: page, PageSize: pageSize, Total: total, HasMore: int64(page*pageSize) < total}, nil
}
