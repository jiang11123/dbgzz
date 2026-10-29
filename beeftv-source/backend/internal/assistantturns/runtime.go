package assistantturns

import (
	"encoding/json"
	"errors"
	"gorm.io/gorm"
)

// RuntimeState rechecks current ownership before a persisted host resumes.
// Reading a historical transcript never grants permission to resume writes.
type RuntimeState struct {
	PermissionMode      string `json:"permissionMode"`
	TurnID              string `json:"turnId"`
	CanvasID            string `json:"canvasId"`
	Open                bool   `json:"open"`
	Revision            int64  `json:"revision"`
	ContinuationRevoked bool   `json:"continuationRevoked,omitempty"`
}

func (s *Service) RuntimeState(userID, turnID string) (*RuntimeState, error) {
	rec, err := s.load(nil, turnID)
	if err != nil {
		return nil, err
	}
	if rec.UserID != userID || userID == "" {
		return nil, errNotFound()
	}
	revoked := false
	if err := s.continuationTurnAllowed(s.store.DB(), turnID); err != nil {
		var typed *Error
		if errors.As(err, &typed) && (typed.Reason == "continuation_cancelled" || typed.Reason == "continuation_scope_changed") {
			revoked = true
		} else {
			return nil, err
		}
	}
	raw, err := s.canvas.BoundTo(nil).UserCanvasProject(userID, rec.CanvasID)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	return &RuntimeState{TurnID: rec.TurnID, CanvasID: rec.CanvasID, PermissionMode: Mode(rec.PermissionMode),
		Open:                !revoked && !rec.Undone && rec.effectiveState() == StateOpen,
		ContinuationRevoked: revoked,
		Revision:            DocumentRevision(doc)}, nil
}

// Extend authorizes only references already verified by the HTTP boundary.
// A stop/undo racing a supplement wins through the same transaction lock as ops.
func (s *Service) Extend(userID, canvasID, turnID string, input Input) error {
	return s.store.DB().Transaction(func(tx *gorm.DB) error {
		rec, err := s.lockOpenTurn(tx, userID, turnID, canvasID)
		if err != nil {
			return err
		}
		if rec.CanvasID != canvasID {
			return errNotFound()
		}
		if input.PermissionMode != "" && Mode(input.PermissionMode) != Mode(rec.PermissionMode) {
			return &Error{Reason: "permission_mode_frozen", Message: "执行中不能修改助手权限"}
		}
		rec.ReferencedAssetIDs = uniqueSorted(append(rec.ReferencedAssetIDs, input.AssetIDs...))
		rec.ReferencedCanvasIDs = uniqueSorted(append(rec.ReferencedCanvasIDs, input.CanvasIDs...))
		for _, pin := range input.SkillPins {
			found := false
			for _, existing := range rec.SkillPins {
				if existing.SkillID == pin.SkillID {
					if existing.Identity() != pin.Identity() {
						return &Error{Reason: "skill_version_conflict", Message: "执行中不能替换同一技能的版本，请在新对话中选择"}
					}
					found = true
				}
			}
			if !found {
				rec.SkillPins = append(rec.SkillPins, pin)
			}
		}
		if len(rec.SkillPins) > 4 {
			return &Error{Reason: "skill_selection_limit", Message: "一轮最多使用 4 个技能"}
		}
		rec.SkillPins = SortedSkillPins(rec.SkillPins)
		return s.persist(tx, rec)
	})
}
