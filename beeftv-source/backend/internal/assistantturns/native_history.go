package assistantturns

import (
	"encoding/json"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
	"regexp"
)

// BindDurableSession receives only official persisted identities from the trusted host.
// Historical bootstrap is never available to model tools. Binding is immutable.
func (s *Service) BindDurableSession(userID, turnID, sessionID string, historical bool) error {
	if !regexp.MustCompile(`^durable:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).MatchString(sessionID) {
		return errNotFound()
	}
	return s.store.DB().Transaction(func(tx *gorm.DB) error {
		var row model.AssistantTurn
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("turn_id = ? AND user_id = ?", turnID, userID).First(&row).Error; err != nil {
			return errNotFound()
		}
		if row.DurableSessionID == sessionID {
			return nil
		}
		if row.DurableSessionID != "" && row.DurableSessionID != sessionID {
			return &Error{Reason: "session_binding_conflict", Message: "对话不能转移到其他会话"}
		}
		if row.Undone || (row.State != StateOpen && !(historical && row.State == StateSettled)) {
			return errNotFound()
		}
		return tx.Model(&row).Update("durable_session_id", sessionID).Error
	})
}

// NativeHistoryScope is not merged into current model tool permissions.
func (s *Service) NativeHistoryScope(userID, currentTurnID, originTurnID, sessionID string) (Scope, error) {
	current, err := s.load(nil, currentTurnID)
	if err != nil {
		return Scope{}, err
	}
	origin, err := s.load(nil, originTurnID)
	if err != nil {
		return Scope{}, err
	}
	if current.UserID != userID || origin.UserID != userID || userID == "" || sessionID == "" || current.DurableSessionID != sessionID || origin.DurableSessionID != sessionID || current.Undone || origin.Undone || current.effectiveState() != StateOpen {
		return Scope{}, errNotFound()
	}
	if origin.TurnID != current.TurnID && origin.effectiveState() != StateSettled {
		return Scope{}, errNotFound()
	}
	return Scope{PermissionMode: Mode(origin.PermissionMode), CanvasID: origin.CanvasID, AssetIDs: uniqueSorted(append(append([]string{}, origin.ReferencedAssetIDs...), origin.AssociatedAssetIDs...)), CanvasIDs: origin.ReferencedCanvasIDs}, nil
}

// RegisterNativeSource is called only after source linkage/version validation by
// the host registration boundary. Exact pins survive restarts and scope changes.
func (s *Service) RegisterNativeSource(userID, originTurnID, sessionID, pin string) error {
	return s.store.DB().Transaction(func(tx *gorm.DB) error {
		var row model.AssistantTurn
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("turn_id = ? AND user_id = ?", originTurnID, userID).First(&row).Error; err != nil {
			return errNotFound()
		}
		if row.DurableSessionID != sessionID || row.Undone {
			return errNotFound()
		}
		var pins []string
		if row.DurableNativeSources != "" {
			if json.Unmarshal([]byte(row.DurableNativeSources), &pins) != nil {
				return errCorruptStored()
			}
		}
		for _, value := range pins {
			if value == pin {
				return nil
			}
		}
		if len(pins) >= 128 {
			return errNotFound()
		}
		pins = append(pins, pin)
		raw, _ := json.Marshal(pins)
		return tx.Model(&row).Update("durable_native_sources", string(raw)).Error
	})
}
func (s *Service) HasNativeSource(userID, turnID, sessionID, pin string) bool {
	rec, err := s.load(nil, turnID)
	if err != nil || rec.UserID != userID || rec.DurableSessionID != sessionID || rec.Undone {
		return false
	}
	var pins []string
	if json.Unmarshal([]byte(rec.DurableNativeSources), &pins) != nil {
		return false
	}
	for _, value := range pins {
		if value == pin {
			return true
		}
	}
	return false
}
