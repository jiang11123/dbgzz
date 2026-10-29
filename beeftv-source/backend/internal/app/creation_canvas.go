package app

import (
	"infinite-canvas/backend/internal/creation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func mergeCreationMaps(left, right map[string]any) map[string]any {
	return creation.MergeMaps(left, right)
}

func creationApprovalBaseline(raw string, ops []CreationCanvasOp) (string, error) {
	return creation.ApprovalBaseline(raw, ops)
}

func creationAddedNode(op CreationCanvasOp) map[string]any {
	return creation.AddedNode(op)
}

func validateCreationCanvasDiff(repo *repository.Repository, userID string, run *model.CreationRun, before, after map[string]any, ops []CreationCanvasOp) error {
	return creation.ValidateCanvasDiff(repo, userID, run, before, after, ops)
}

func validateCreationResultMetadata(repo *repository.Repository, userID, runID, nodeID string, before, after map[string]any) error {
	return creation.ValidateResultMetadata(repo, userID, runID, nodeID, before, after)
}

func (s *Service) CreationCanvasSnapshot(userID, id string) (map[string]any, error) {
	return s.creationDomain().CanvasSnapshot(userID, id)
}

func (s *Service) CreateRunCanvas(userID, id string, req CreationRequest) (map[string]any, error) {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	return s.creationDomain().CreateCanvas(userID, id, toCreationCommand(req))
}

func (s *Service) CommitCreationCanvas(userID, id string, req CreationRequest) (map[string]any, error) {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	return s.creationDomain().CommitCanvas(userID, id, toCreationCommand(req))
}
