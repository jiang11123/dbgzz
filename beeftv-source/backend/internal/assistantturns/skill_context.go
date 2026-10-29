package assistantturns

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/skills"
)

type SkillContext struct {
	CanvasID   string       `json:"canvasId"`
	SessionID  string       `json:"sessionId"`
	ScopeID    string       `json:"scopeId"`
	Revision   int64        `json:"revision"`
	ActivePins []skills.Pin `json:"activePins"`
	Lifecycle  string       `json:"lifecycle"`
}

type SkillContextChange struct {
	// Set only by the host-authenticated route after validating the turn binding.
	BoundTurnID      string       `json:"-"`
	SessionID        string       `json:"sessionId"`
	Action           string       `json:"action"`
	ExpectedRevision int64        `json:"expectedRevision"`
	RequestID        string       `json:"requestId"`
	Pins             []skills.Pin `json:"pins,omitempty"`
}

var durableContextSession = regexp.MustCompile(`^durable:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func contextError(reason, message string) error { return &Error{Reason: reason, Message: message} }
func contextKey(userID, canvasID, sessionID string) model.AssistantSkillContext {
	return model.AssistantSkillContext{UserID: userID, CanvasID: canvasID, DurableSessionID: sessionID}
}
func newScopeID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func (s *Service) contextActor(userID, canvasID, sessionID string) error {
	if !s.storeReady() {
		return storeUnavailable()
	}
	if s.canvas == nil {
		return storeUnavailable()
	}
	if !durableContextSession.MatchString(sessionID) {
		return contextError("invalid_skill_session", "请选择有效的助手会话")
	}
	if err := requireActor(userID, canvasID); err != nil {
		return err
	}
	_, err := s.canvas.BoundTo(nil).UserCanvasProject(userID, canvasID)
	return err
}
func contextProjection(row model.AssistantSkillContext) (*SkillContext, error) {
	pins := []skills.Pin{}
	if json.Unmarshal([]byte(row.ActivePinsJSON), &pins) != nil {
		return nil, errCorruptStored()
	}
	return &SkillContext{CanvasID: row.CanvasID, SessionID: row.DurableSessionID, ScopeID: row.ScopeID, Revision: row.Revision, ActivePins: SortedSkillPins(pins), Lifecycle: row.Lifecycle}, nil
}
func (s *Service) getContext(tx *gorm.DB, userID, canvasID, sessionID string) (*model.AssistantSkillContext, error) {
	key := contextKey(userID, canvasID, sessionID)
	var row model.AssistantSkillContext
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where(&key).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		scope, scopeErr := newScopeID()
		if scopeErr != nil {
			return nil, scopeErr
		}
		row = key
		row.ScopeID = scope
		row.ActivePinsJSON = "[]"
		row.Lifecycle = "active"
		row.UpdatedAt = s.now()
		if err = tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
			return nil, err
		}
		err = tx.Where(&key).First(&row).Error
	}
	return &row, err
}
func (s *Service) SkillContext(userID, canvasID, sessionID string) (*SkillContext, error) {
	if err := s.contextActor(userID, canvasID, sessionID); err != nil {
		return nil, err
	}
	var result *SkillContext
	err := s.store.DB().Transaction(func(tx *gorm.DB) error {
		row, err := s.getContext(tx, userID, canvasID, sessionID)
		if err != nil {
			return err
		}
		result, err = contextProjection(*row)
		return err
	})
	return result, err
}

// ChangeSkillContext uses CAS and a durable receipt, shared by UI and host.
// Callers that validate package access use ChangeSkillContextValidated so an
// already committed receipt remains replayable after a package is removed.
func (s *Service) ChangeSkillContext(userID, canvasID string, change SkillContextChange) (*SkillContext, error) {
	return s.changeSkillContext(userID, canvasID, change, nil, "")
}

// SkillPinValidator must read through tx: the production SQLite pool has one
// connection, and validation belongs to the same transaction as the mutation.
type SkillPinValidator func(tx *gorm.DB, pins []skills.Pin) ([]skills.Pin, error)

func (s *Service) ChangeSkillContextValidated(userID, canvasID string, change SkillContextChange, validate SkillPinValidator) (*SkillContext, error) {
	if validate == nil {
		return nil, storeUnavailable()
	}
	return s.changeSkillContext(userID, canvasID, change, validate, "")
}

// Only the trusted host's skill_load path may carry valid continuation receipts
// across a skill revision. User selections and resets use the normal path.
func (s *Service) LoadTurnSkillContextValidated(userID, canvasID, turnID string, change SkillContextChange, validate SkillPinValidator) (*SkillContext, error) {
	if validate == nil || turnID == "" || change.Action != "activate" {
		return nil, contextError("invalid_skill_context_request", "技能加载参数无效")
	}
	return s.changeSkillContext(userID, canvasID, change, validate, turnID)
}

func (s *Service) changeSkillContext(userID, canvasID string, change SkillContextChange, validate SkillPinValidator, skillLoadTurnID string) (*SkillContext, error) {
	if err := s.contextActor(userID, canvasID, change.SessionID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(change.RequestID) == "" || len(change.RequestID) > 160 || change.ExpectedRevision < 0 {
		return nil, contextError("invalid_skill_context_request", "技能请求参数无效")
	}
	switch change.Action {
	case "activate", "refresh", "clear", "new_scope":
	default:
		return nil, contextError("invalid_skill_context_action", "技能操作无效")
	}
	if len(change.Pins) > 4 {
		return nil, contextError("skill_selection_limit", "最多使用 4 个技能")
	}
	seen := map[string]bool{}
	for _, pin := range change.Pins {
		if err := skills.ValidatePin(pin); err != nil {
			return nil, err
		}
		if seen[pin.SkillID] {
			return nil, contextError("invalid_skill_selection", "技能重复")
		}
		seen[pin.SkillID] = true
	}
	if (change.Action == "clear" || change.Action == "refresh") && len(change.Pins) > 0 {
		return nil, contextError("invalid_skill_context_request", "此操作不接受新的技能")
	}
	digestBody, _ := json.Marshal(struct {
		Action          string
		Pins            []skills.Pin
		SkillLoadTurnID string `json:",omitempty"`
	}{change.Action, skillPinIdentities(change.Pins), skillLoadTurnID})
	sum := sha256.Sum256(digestBody)
	digest := hex.EncodeToString(sum[:])
	var result *SkillContext
	err := s.store.DB().Transaction(func(tx *gorm.DB) error {
		boundTurnID := change.BoundTurnID
		if skillLoadTurnID != "" {
			boundTurnID = skillLoadTurnID
		}
		exemptSource := ""
		if boundTurnID != "" {
			rec, err := s.lockOpenTurn(tx, userID, boundTurnID, canvasID)
			if err != nil {
				return err
			}
			if rec.UserID != userID || rec.CanvasID != canvasID || rec.DurableSessionID != change.SessionID {
				return errNotFound()
			}
			var automatic int64
			if err := tx.Model(&model.AssistantContinuation{}).Where("turn_id = ?", boundTurnID).Count(&automatic).Error; err != nil {
				return err
			}
			// Loading the user's explicit selection initializes this new user turn.
			// It must still be able to issue fresh proposals. An automatic turn's
			// explicit user selection does revoke that older automatic intent.
			if automatic == 0 && change.Action == "activate" {
				exemptSource = boundTurnID
			}
		}
		key := model.AssistantSkillContextMutation{UserID: userID, CanvasID: canvasID, DurableSessionID: change.SessionID, RequestID: change.RequestID}
		var receipt model.AssistantSkillContextMutation
		if err := tx.Where(&key).First(&receipt).Error; err == nil {
			if receipt.Digest != digest {
				return contextError("skill_context_request_conflict", "相同请求标识已用于不同技能操作")
			}
			if json.Unmarshal([]byte(receipt.ResultJSON), &result) != nil {
				return errCorruptStored()
			}
			return nil
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		row, err := s.getContext(tx, userID, canvasID, change.SessionID)
		if err != nil {
			return err
		}
		if row.Lifecycle != "active" {
			return contextError("skill_scope_reset_pending", "独立任务正在准备，请重试原请求")
		}
		if row.Revision != change.ExpectedRevision {
			return contextError("skill_context_revision_conflict", "技能状态已变化，请刷新后重试")
		}
		current, err := contextProjection(*row)
		if err != nil {
			return err
		}
		pins := current.ActivePins
		switch change.Action {
		case "activate":
			pins = SortedSkillPins(change.Pins)
		case "clear":
			pins = []skills.Pin{}
		case "new_scope":
			pins = SortedSkillPins(change.Pins)
			row.ScopeID, err = newScopeID()
			if err != nil {
				return err
			}
			row.Lifecycle = "reset_pending"
		}
		if validate != nil && change.Action != "clear" {
			pins, err = validate(tx, pins)
			if err != nil {
				return err
			}
			pins = SortedSkillPins(pins)
		}
		encoded, _ := json.Marshal(pins)
		row.ActivePinsJSON = string(encoded)
		previous := row.Revision
		row.Revision++
		row.UpdatedAt = s.now()
		update := tx.Model(&model.AssistantSkillContext{}).Where(&model.AssistantSkillContext{UserID: userID, CanvasID: canvasID, DurableSessionID: change.SessionID}).Where("revision = ?", previous).Updates(map[string]any{"scope_id": row.ScopeID, "revision": row.Revision, "active_pins_json": row.ActivePinsJSON, "lifecycle": row.Lifecycle, "updated_at": row.UpdatedAt})
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected != 1 {
			return contextError("skill_context_revision_conflict", "技能状态已变化，请刷新后重试")
		}
		if skillLoadTurnID != "" {
			// A runtime tool load does not replace user intent. Carry every still
			// valid receipt in this exact scope/version, including pending peers.
			// Cancelled, completed and already stale scopes can never be revived.
			if err := tx.Model(&model.AssistantContinuation{}).Where("user_id = ? AND canvas_id = ? AND session_id = ? AND scope_id = ? AND scope_revision = ? AND state IN ?", userID, canvasID, change.SessionID, row.ScopeID, previous, []string{"waiting", "claimed", "running"}).Update("scope_revision", row.Revision).Error; err != nil {
				return err
			}
		} else {
			if err := s.cancelContinuations(tx, userID, canvasID, change.SessionID, "", false, exemptSource); err != nil {
				return err
			}
		}
		result, err = contextProjection(*row)
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(result)
		key.Digest = digest
		key.ResultJSON = string(raw)
		key.CreatedAt = s.now()
		return tx.Create(&key).Error
	})
	return result, err
}

func (s *Service) AcknowledgeSkillScope(userID, canvasID, sessionID, scopeID string, revision int64) (*SkillContext, error) {
	if err := s.contextActor(userID, canvasID, sessionID); err != nil {
		return nil, err
	}
	var result *SkillContext
	err := s.store.DB().Transaction(func(tx *gorm.DB) error {
		row, err := s.getContext(tx, userID, canvasID, sessionID)
		if err != nil {
			return err
		}
		if row.ScopeID != scopeID || row.Revision != revision {
			return contextError("skill_context_revision_conflict", "独立任务状态已变化")
		}
		if row.Lifecycle == "reset_pending" {
			if err := tx.Model(row).Update("lifecycle", "active").Error; err != nil {
				return err
			}
			row.Lifecycle = "active"
		}
		result, err = contextProjection(*row)
		return err
	})
	return result, err
}

// BoundSkillContext never grants a different owner's or conversation's pins.
func (s *Service) BoundSkillContext(userID, turnID, sessionID string) (*SkillContext, error) {
	rec, err := s.load(nil, turnID)
	if err != nil {
		return nil, err
	}
	if rec.UserID != userID || rec.DurableSessionID != sessionID || rec.Undone || rec.effectiveState() != StateOpen {
		return nil, errNotFound()
	}
	return s.SkillContext(userID, rec.CanvasID, sessionID)
}
