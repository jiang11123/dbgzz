package project

import (
	"infinite-canvas/backend/internal/model"

	"golang.org/x/sync/errgroup"
)

func (s *Service) ProjectCore(userID string, projectID string) (Core, error) {
	item, err := s.Owned(userID, projectID)
	if err != nil {
		return Core{}, err
	}
	return Core{Project: *item}, nil
}

func (s *Service) ProjectUnitSummaries(userID string, projectID string) (UnitSummaries, error) {
	if _, err := s.Owned(userID, projectID); err != nil {
		return UnitSummaries{}, err
	}
	var units []model.ProjectUnit
	var canvasCounts map[string]int64
	var group errgroup.Group
	group.Go(func() error {
		var err error
		units, err = s.repo.ProjectUnitSummaries(projectID)
		return err
	})
	group.Go(func() error {
		var err error
		canvasCounts, err = s.repo.ProjectUnitCanvasCounts(projectID)
		return err
	})
	if err := group.Wait(); err != nil {
		return UnitSummaries{}, err
	}
	return UnitSummaries{Units: units, CanvasCounts: canvasCounts}, nil
}

func (s *Service) ProjectOverview(userID string, projectID string) (Overview, error) {
	if _, err := s.Owned(userID, projectID); err != nil {
		return Overview{}, err
	}
	var metrics OverviewMetrics
	var units []OverviewUnit
	var group errgroup.Group
	group.Go(func() error {
		row, err := s.repo.ProjectOverviewMetrics(projectID)
		if err != nil {
			return err
		}
		metrics = OverviewMetrics{
			UnitCount: row.UnitCount, CompletedUnitCount: row.CompletedUnitCount, TotalWordCount: row.TotalWordCount,
			UnitsWithoutText: row.UnitsWithoutText, UnitsWithoutShots: row.UnitsWithoutShots, CanvasCount: row.CanvasCount,
			AssetCount: row.AssetCount, ShotCount: row.ShotCount, PendingCandidateCount: row.PendingCandidateCount,
			ReadyStoryboardCount: row.ReadyStoryboardCount, ReadyPrevizCount: row.ReadyPrevizCount, ReadyVideoCount: row.ReadyVideoCount,
			RenderSucceededCount: row.TimelineRenderSucceededCount, StaleArtifactCount: row.StaleArtifactCount,
		}
		return nil
	})
	group.Go(func() error {
		rows, err := s.repo.ProjectOverviewUnits(projectID, 8)
		if err != nil {
			return err
		}
		units = make([]OverviewUnit, 0, len(rows))
		for _, row := range rows {
			units = append(units, OverviewUnit{Unit: row.ProjectUnit, ShotCount: row.ShotCount, CandidateCount: row.CandidateCount, CanvasCount: row.CanvasCount})
		}
		return nil
	})
	if err := group.Wait(); err != nil {
		return Overview{}, err
	}
	return Overview{Metrics: metrics, Units: units}, nil
}

func (s *Service) ProjectCanvasesPage(userID string, projectID string, page int, pageSize int) (CanvasPage, error) {
	if _, err := s.Owned(userID, projectID); err != nil {
		return CanvasPage{}, err
	}
	page, pageSize = NormalizePage(page, pageSize, 100)
	canvases, total, err := s.repo.ProjectCanvasSummariesPage(userID, projectID, page, pageSize)
	if err != nil {
		return CanvasPage{}, err
	}
	ids := make([]string, 0, len(canvases))
	for _, canvas := range canvases {
		ids = append(ids, canvas.ID)
	}
	links, err := s.repo.ProjectCanvasUnitLinksForCanvases(projectID, ids)
	if err != nil {
		return CanvasPage{}, err
	}
	return CanvasPage{Canvases: canvases, CanvasUnitLinks: links, Page: page, PageSize: pageSize, Total: total, HasMore: int64(page*pageSize) < total}, nil
}

func (s *Service) Inspect(userID string, projectID string) (Snapshot, error) {
	item, err := s.Owned(userID, projectID)
	if err != nil {
		return Snapshot{}, err
	}
	units, err := s.repo.ProjectUnitSummaries(item.ID)
	if err != nil {
		return Snapshot{}, err
	}
	canvases, err := s.repo.ProjectCanvasSummaries(userID, item.ID)
	if err != nil {
		return Snapshot{}, err
	}
	canvasUnitLinks, err := s.repo.ProjectCanvasUnitLinks(item.ID)
	if err != nil {
		return Snapshot{}, err
	}
	assetFolders, err := s.repo.ProjectAssetFolders(item.ID)
	if err != nil {
		return Snapshot{}, err
	}
	shots, err := s.repo.ProjectShots(item.ID)
	if err != nil {
		return Snapshot{}, err
	}
	shotRevisions, err := s.repo.ProjectShotRevisions(item.ID)
	if err != nil {
		return Snapshot{}, err
	}
	shotArtifacts, err := s.repo.ProjectShotArtifacts(item.ID)
	if err != nil {
		return Snapshot{}, err
	}
	shotReferences, err := s.repo.ProjectShotAssetReferences(item.ID)
	if err != nil {
		return Snapshot{}, err
	}
	candidates, err := s.repo.ProjectAssetCandidates(item.ID)
	if err != nil {
		return Snapshot{}, err
	}
	return Snapshot{
		Project: *item, Units: units, Canvases: canvases, CanvasUnitLinks: canvasUnitLinks,
		AssetFolders: assetFolders, Shots: shots, ShotRevisions: shotRevisions, ShotArtifacts: shotArtifacts,
		ShotReferences: shotReferences, AssetCandidates: candidates,
	}, nil
}
