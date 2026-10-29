package app

import "infinite-canvas/backend/internal/assistantturns"

func (s *Service) ArmAssistantContinuation(userID string, input assistantturns.ContinuationInput) (*assistantturns.ContinuationView, error) {
	return s.assistantTurnsOrInit().ArmContinuation(userID, input)
}
func (s *Service) RegisterAssistantContinuationManifest(userID, id string, manifest assistantturns.ContinuationManifest) error {
	return s.assistantTurnsOrInit().RegisterContinuationManifest(userID, id, manifest)
}
func (s *Service) ListAssistantContinuations(userID, canvasID, sessionID string) ([]assistantturns.ContinuationView, error) {
	return s.assistantTurnsOrInit().ListContinuations(userID, canvasID, sessionID)
}
func (s *Service) ClaimAssistantContinuation(userID, id string) (*assistantturns.ContinuationView, error) {
	return s.assistantTurnsOrInit().ClaimContinuation(userID, id, s.prepareAssistantProduction)
}
func (s *Service) VerifyAssistantContinuation(userID, id, turnID, sessionID string) error {
	return s.assistantTurnsOrInit().VerifyContinuation(userID, id, turnID, sessionID)
}
func (s *Service) CancelAssistantContinuations(userID, canvasID, sessionID string, pendingOnly bool) error {
	return s.assistantTurnsOrInit().CancelContinuations(userID, canvasID, sessionID, pendingOnly)
}
