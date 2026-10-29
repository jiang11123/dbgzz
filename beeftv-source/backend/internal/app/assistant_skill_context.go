package app

import (
	"errors"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/skills"
)

func (s *Service) AssistantSkillContext(userID, canvasID, sessionID string) (*assistantturns.SkillContext, error) {
	return s.assistantTurnsOrInit().SkillContext(userID, canvasID, sessionID)
}

func (s *Service) ChangeAssistantSkillContext(userID, canvasID string, change assistantturns.SkillContextChange) (*assistantturns.SkillContext, error) {
	return s.assistantTurnsOrInit().ChangeSkillContextValidated(userID, canvasID, change, func(tx *gorm.DB, pins []skills.Pin) ([]skills.Pin, error) {
		return s.validateAssistantSkillContextPins(skills.New(s.repo.WithTx(tx), s.dataDir, nil), userID, pins)
	})
}

func (s *Service) LoadAssistantTurnSkillContext(userID, canvasID, turnID string, change assistantturns.SkillContextChange) (*assistantturns.SkillContext, error) {
	return s.assistantTurnsOrInit().LoadTurnSkillContextValidated(userID, canvasID, turnID, change, func(tx *gorm.DB, pins []skills.Pin) ([]skills.Pin, error) {
		return s.validateAssistantSkillContextPins(skills.New(s.repo.WithTx(tx), s.dataDir, nil), userID, pins)
	})
}

func (s *Service) validateAssistantSkillContextPins(domain *skills.Service, userID string, pins []skills.Pin) ([]skills.Pin, error) {
	validated, err := validateAssistantSkillContextPins(domain, userID, pins)
	if err != nil {
		return nil, err
	}
	for _, pin := range validated {
		// Keep these reads on the context transaction. Capability failures never
		// authorize removing a pin or rewriting an already committed receipt.
		if err := s.checkAgentSkillRequirements(domain, userID, pin); err != nil {
			return nil, err
		}
	}
	return validated, nil
}

func skillContextResourceError(err error) (*kernel.AppError, bool) {
	var appErr *kernel.AppError
	ok := errors.As(err, &appErr) && appErr != nil && appErr.Status >= 400 && appErr.Status < 500 && appErr.Reason != "skill_instruction_too_large"
	if ok {
		switch appErr.Reason {
		case kernel.ReasonInvalidArgument, kernel.ReasonForbidden, kernel.ReasonConflict:
		default:
			ok = false
		}
	}
	// Missing database versions are definitive; an unavailable archive path can
	// also mean a disconnected disk. Never drop a pin for a recoverable read fault.
	if ok && appErr.Cause != nil && !errors.Is(appErr.Cause, gorm.ErrRecordNotFound) {
		ok = false
	}
	return appErr, ok
}

// Only a verified per-pin resource failure can let Stop omit a revoked pin.
// Transport/storage failures and selection limits must keep recovery pending.
func validateAssistantSkillContextPins(domain *skills.Service, userID string, pins []skills.Pin) ([]skills.Pin, error) {
	validated, err := domain.ValidateAgentSkills(userID, pins)
	if _, resourceFailure := skillContextResourceError(err); err == nil || !resourceFailure {
		return validated, err
	}
	// The context service checks shape first; retain that distinction even when
	// this validator is called directly instead of through the mutation entrypoint.
	if len(pins) > 4 {
		return nil, err
	}
	seen := make(map[string]bool, len(pins))
	for _, pin := range pins {
		if skills.ValidatePin(pin) != nil || seen[pin.SkillID] {
			return nil, err
		}
		seen[pin.SkillID] = true
	}
	for _, pin := range pins {
		if _, pinErr := domain.AgentVersion(userID, pin); pinErr != nil {
			resourceErr, ok := skillContextResourceError(pinErr)
			if !ok {
				return nil, pinErr
			}
			failure := *resourceErr
			failure.Reason = "skill_context_pin_unavailable"
			failure.Details = map[string]any{"skillId": pin.SkillID}
			failure.Cause = pinErr
			return nil, &failure
		}
	}
	return nil, err
}

func (s *Service) AcknowledgeAssistantSkillScope(userID, canvasID, sessionID, scopeID string, revision int64) (*assistantturns.SkillContext, error) {
	return s.assistantTurnsOrInit().AcknowledgeSkillScope(userID, canvasID, sessionID, scopeID, revision)
}

func (s *Service) BoundAssistantSkillContext(userID, turnID, sessionID string) (*assistantturns.SkillContext, error) {
	return s.assistantTurnsOrInit().BoundSkillContext(userID, turnID, sessionID)
}
