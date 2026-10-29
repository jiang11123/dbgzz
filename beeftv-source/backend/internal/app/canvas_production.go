package app

import localproject "infinite-canvas/backend/internal/project"

type CanvasProductionContext = localproject.CanvasProductionContext
type CanvasProductionTaskRequest = localproject.CanvasProductionTaskRequest
type CanvasProductionTaskResult = localproject.CanvasProductionTaskResult

func (s *Service) CanvasProductionContext(userID, projectID, canvasID, unitID, shotID, stepKey string) (CanvasProductionContext, error) {
	return s.projectDomain().CanvasProductionContext(userID, projectID, canvasID, unitID, shotID, stepKey)
}
func (s *Service) RegisterCanvasProductionTask(userID, projectID, canvasID string, req CanvasProductionTaskRequest) (CanvasProductionTaskResult, error) {
	return s.projectDomain().RegisterCanvasProductionTask(userID, projectID, canvasID, req)
}
