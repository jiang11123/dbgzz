package app

import "infinite-canvas/backend/internal/skills"

// AssistantTurnHistoryState supplements pi's conversation history with authoritative business receipts.
// It is a read projection: reading history never settles or cancels an active turn.
type AssistantTurnHistoryState struct {
	ContinuationInvalidated bool
	PermissionMode          string `json:"permissionMode"`
	Change                  *AssistantTurnChange
	Undone                  bool
	SkillPins               []skills.Pin
}

func (s *Service) ReadAssistantTurnHistoryState(userID, canvasID, turnID string) (*AssistantTurnHistoryState, error) {
	state, err := s.assistantTurnsOrInit().History(userID, canvasID, turnID)
	if err != nil || state == nil {
		return nil, err
	}
	return &AssistantTurnHistoryState{Change: state.Change, Undone: state.Undone, ContinuationInvalidated: state.ContinuationInvalidated, PermissionMode: state.PermissionMode, SkillPins: state.SkillPins}, nil
}

// CheckAssistantProposalRunnable rejects undone rounds and invalidated intents.
func (s *Service) CheckAssistantProposalRunnable(userID, canvasID, turnID string) error {
	return s.assistantTurnsOrInit().CheckProposalRunnable(userID, canvasID, turnID)
}
