package app

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/supporttrace"

	"gorm.io/gorm"
)

const (
	AssistantTurnReasonNotFound      = assistantturns.ReasonNotFound
	AssistantTurnReasonNoChange      = assistantturns.ReasonNoChange
	AssistantTurnReasonAlreadyUndone = assistantturns.ReasonAlreadyUndone
	AssistantTurnReasonCanvasChanged = assistantturns.ReasonCanvasChanged
	AssistantTurnReasonUndone        = assistantturns.ReasonUndone
)

type (
	AssistantTurnError  = assistantturns.Error
	AssistantTurnChange = assistantturns.Change
	AssistantTurnInput  = assistantturns.Input
	AssistantTurnScope  = assistantturns.Scope
	assistantTurnRecord = assistantturns.Record
)

const (
	assistantTurnStateOpen    = assistantturns.StateOpen
	assistantTurnStateSettled = assistantturns.StateSettled
)

func ValidAssistantTurnID(turnID string) bool {
	return assistantturns.ValidTurnID(turnID)
}

func (s *Service) assistantTurnDir() string {
	if s == nil {
		return ""
	}
	return filepath.Join(s.dataDir, "assistant-turns")
}

func (s *Service) assistantTurnsOrInit() *assistantturns.Service {
	if s == nil {
		return nil
	}
	if s.assistantTurns != nil {
		return s.assistantTurns
	}
	return assistantturns.New(assistantturns.NewStore(s.repo), assistantCanvasFactory{s}, s.assistantTurnDir())
}

func (s *Service) BeginAssistantTurn(userID, canvasID, turnID string, input AssistantTurnInput) (int64, error) {
	revision, err := s.assistantTurnsOrInit().Begin(userID, canvasID, turnID, input)
	if err == nil {
		s.SupportTrace().Event(context.Background(), "assistant.turn", supporttrace.Fields{UserID: userID, CanvasID: canvasID, TurnID: turnID, Reason: "turn_opened"})
	}
	return revision, err
}

func (s *Service) AssistantTurnScopeForHost(userID, turnID string) (AssistantTurnScope, bool, error) {
	return s.assistantTurnsOrInit().ScopeForHost(userID, turnID)
}

func (s *Service) FinalizeAssistantTurn(turnID string) error {
	err := s.assistantTurnsOrInit().Finalize(turnID)
	if err == nil && s.repo != nil {
		if row, readErr := s.repo.AssistantTurnByID(nil, turnID); readErr == nil {
			s.SupportTrace().Event(context.Background(), "assistant.turn", supporttrace.Fields{UserID: row.UserID, CanvasID: row.CanvasID, TurnID: turnID, SessionID: row.DurableSessionID, Reason: "turn_settled"})
		}
	}
	return err
}

func (s *Service) AssistantTurnRuntimeState(userID, turnID string) (*assistantturns.RuntimeState, error) {
	return s.assistantTurnsOrInit().RuntimeState(userID, turnID)
}

func (s *Service) ExtendAssistantTurn(userID, canvasID, turnID string, input AssistantTurnInput) error {
	return s.assistantTurnsOrInit().Extend(userID, canvasID, turnID, input)
}

func (s *Service) AssistantTurnUndone(userID, canvasID, turnID string) bool {
	return s.assistantTurnsOrInit().Undone(userID, canvasID, turnID)
}

func (s *Service) UndoAssistantTurn(userID, canvasID, turnID string) (int64, error) {
	return s.assistantTurnsOrInit().Undo(userID, canvasID, turnID)
}

// VerifyOpenAssistantTurnInTx is the operation-transaction contract for Lead
// and the common-ops worker. Call it inside the same *gorm.DB transaction that
// writes AgentOpRecord and the canvas mutation. ScopeForHost preflight does
// not close the settle/write race.
//
//	func (s *app.Service) VerifyOpenAssistantTurnInTx(tx *gorm.DB, userID, turnID, canvasID string) error
func (s *Service) VerifyOpenAssistantTurnInTx(tx *gorm.DB, userID, turnID, canvasID string) error {
	err := s.assistantTurnsOrInit().VerifyOpenTurnInTx(tx, userID, turnID, canvasID)
	var turnErr *assistantturns.Error
	if errors.As(err, &turnErr) {
		return operations.PreconditionFailed(turnErr.Reason, turnErr.Message, nil)
	}
	return err
}

func canvasAssociatedReferences(raw json.RawMessage) ([]string, []string) {
	return assistantturns.AssociatedReferences(raw)
}

func assistantDocRevision(doc map[string]any) int64 {
	return assistantturns.DocumentRevision(doc)
}

func assistantTurnMatchesChange(before, after map[string]any, change *AssistantTurnChange) bool {
	return assistantturns.MatchesChange(before, after, change)
}

func (s *Service) assistantTurnChangeFromReceipts(record assistantTurnRecord) (*AssistantTurnChange, error) {
	return s.assistantTurnsOrInit().ChangeFromReceipts(record)
}

func (s *Service) loadAssistantTurn(turnID string) (assistantTurnRecord, error) {
	return s.assistantTurnsOrInit().Load(turnID)
}

type assistantCanvasFactory struct{ service *Service }

func (f assistantCanvasFactory) BoundTo(tx *gorm.DB) assistantturns.CanvasSession {
	if f.service == nil {
		return nil
	}
	if tx == nil {
		return assistantCanvasSession{canvas: f.service.canvasDomain()}
	}
	return assistantCanvasSession{canvas: f.service.canvasDomainWithTx(tx)}
}

type assistantCanvasSession struct{ canvas *canvas.Service }

func (s assistantCanvasSession) UserCanvasProject(userID, canvasID string) (json.RawMessage, error) {
	return s.canvas.UserCanvasProject(userID, canvasID)
}

func (s assistantCanvasSession) UpsertUserCanvasProject(userID string, raw json.RawMessage) (int64, error) {
	summary, err := s.canvas.UpsertUserCanvasProject(userID, raw)
	if err != nil {
		return 0, err
	}
	return summary.Revision, nil
}
