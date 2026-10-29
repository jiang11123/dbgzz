package app

import "infinite-canvas/backend/internal/assistantturns"

func (s *Service) StopAssistantContinuationsForIntent(userID, canvasID, sessionID string) ([]assistantturns.ContinuationView, error) {
	return s.assistantTurnsOrInit().StopContinuationsForIntent(userID, canvasID, sessionID)
}

func (s *Service) AcknowledgeAssistantContinuationStop(userID, id string) error {
	return s.assistantTurnsOrInit().AcknowledgeContinuationStop(userID, id)
}
