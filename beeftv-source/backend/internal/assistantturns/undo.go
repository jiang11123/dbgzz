package assistantturns

import (
	"encoding/json"
	"errors"
	"sort"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (s *Service) lockOpenTurn(tx *gorm.DB, userID, turnID, canvasID string) (Record, error) {
	id := NormalizeTurnID(turnID)
	var rec Record
	var row model.AssistantTurn
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("turn_id = ?", id).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		imported, importErr := s.importLegacyIfMissing(tx, id)
		if importErr != nil {
			if isMissing(importErr) {
				return Record{}, &Error{Reason: ReasonNotOpen, Message: "这一轮不存在或已结束"}
			}
			return Record{}, importErr
		}
		rec = imported
	} else if err != nil {
		return Record{}, err
	} else {
		decoded, recErr := recordFromModel(&row)
		if recErr != nil {
			return Record{}, recErr
		}
		rec = decoded
	}
	if rec.UserID != userID || (rec.CanvasID != canvasID && Mode(rec.PermissionMode) != PermissionFullAccess) || rec.Undone || rec.effectiveState() != StateOpen {
		return Record{}, &Error{Reason: ReasonNotOpen, Message: "这一轮不存在或已结束"}
	}
	if err := s.continuationTurnAllowed(tx, id); err != nil {
		return Record{}, err
	}
	result := tx.Model(&model.AssistantTurn{}).
		Where("turn_id = ? AND user_id = ? AND state = ? AND undone = ?", id, userID, StateOpen, false).
		Update("updated_at", s.now())
	if result.Error != nil {
		return Record{}, result.Error
	}
	if result.RowsAffected != 1 {
		return Record{}, &Error{Reason: ReasonNotOpen, Message: "这一轮不存在或已结束"}
	}
	return rec, nil
}

// Undo restores the pre-turn document as a new canvas revision and marks the
// round undone in the same transaction. A marker-write failure rolls the
// canvas restore back.
func (s *Service) Undo(userID, canvasID, turnID string) (int64, error) {
	if err := requireActor(userID, canvasID); err != nil {
		return 0, err
	}
	id := NormalizeTurnID(turnID)
	if id == "" {
		return 0, errNotFound()
	}
	if !s.storeReady() {
		return 0, storeUnavailable()
	}
	if s.canvas == nil {
		return 0, errors.New("画布存储不可用")
	}
	var restoredRevision int64
	err := s.store.DB().Transaction(func(tx *gorm.DB) error {
		var locked model.AssistantTurn
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("turn_id = ?", id).First(&locked).Error; err != nil {
			return errNotFound()
		}
		rec, err := s.load(tx, id)
		if err != nil {
			if isMissing(err) {
				return errNotFound()
			}
			return err
		}
		if rec.UserID != userID || rec.CanvasID != canvasID {
			return errNotFound()
		}
		if rec.Undone {
			return &Error{Reason: ReasonAlreadyUndone, Message: "这一轮已经撤销过了"}
		}
		if rec.Change == nil {
			receipts, receiptErr := s.store.SucceededByTurn(tx, rec.UserID, rec.TurnID)
			if receiptErr != nil {
				return receiptErr
			}
			change, receiptErr := changeFromReceipts(rec, receipts)
			if receiptErr != nil {
				return receiptErr
			}
			if change != nil {
				if err := s.declareDocumentChanges(tx, rec, change); err != nil {
					return err
				}
				rec.Change = change
				if err := s.persist(tx, rec); err != nil {
					return err
				}
			}
		}
		if rec.Change == nil {
			return &Error{Reason: ReasonNoChange, Message: "这一轮没有改动画布"}
		}
		session := s.canvas.BoundTo(tx)
		changes := rec.Change.CanvasChanges
		if len(changes) == 0 {
			one := *rec.Change
			one.CanvasID = canvasID
			changes = []Change{one}
		}
		sort.Slice(changes, func(i, j int) bool { return changes[i].CanvasID < changes[j].CanvasID })
		type restore struct {
			id       string
			document json.RawMessage
		}
		restores := make([]restore, 0, len(changes))
		for _, change := range changes {
			targetID := change.CanvasID
			snapshot, exists := rec.CanvasSnapshots[targetID]
			if !exists {
				if targetID != rec.CanvasID {
					return errCorruptStored()
				}
				snapshot = CanvasSnapshot{rec.RevisionBefore, rec.Document}
			}
			current, err := session.UserCanvasProject(userID, targetID)
			if err != nil {
				return err
			}
			var currentDoc map[string]any
			if err := json.Unmarshal(current, &currentDoc); err != nil {
				return err
			}
			currentRevision := DocumentRevision(currentDoc)
			if currentRevision != change.RevisionAfter || change.RevisionBefore != snapshot.RevisionBefore {
				return &Error{Reason: ReasonCanvasChanged, Message: "画布在这一轮之后又被改过，已停止撤销"}
			}
			var restored map[string]any
			if err := json.Unmarshal(snapshot.Document, &restored); err != nil {
				return err
			}
			if !MatchesChange(restored, currentDoc, &change) {
				return &Error{Reason: ReasonCanvasChanged, Message: "无法安全撤销这一轮，画布内容已保留"}
			}
			if currentRevision != snapshot.RevisionBefore+1 || change.DocumentUpdated {
				ops, opErr := s.store.OpsByIDs(tx, rec.UserID, change.OperationIDs)
				if opErr != nil {
					return opErr
				}
				if !OperationsCoverSpan(ops, targetID, change.OperationIDs, snapshot.RevisionBefore, currentRevision) {
					return &Error{Reason: ReasonCanvasChanged, Message: "无法安全撤销这一轮，画布内容已保留"}
				}
			}
			restored["id"] = targetID
			restored["revision"] = currentRevision
			encoded, err := json.Marshal(restored)
			if err != nil {
				return err
			}
			restores = append(restores, restore{targetID, encoded})
		}
		// All targets pass before the first restore. Any later error rolls the group back.
		for _, item := range restores {
			revision, err := session.UpsertUserCanvasProject(userID, item.document)
			if err != nil {
				return err
			}
			if item.id == canvasID || restoredRevision == 0 {
				restoredRevision = revision
			}
		}
		if s.undoMarkerHook != nil {
			if hookErr := s.undoMarkerHook(); hookErr != nil {
				return hookErr
			}
		}
		rec.Undone = true
		if err := s.persist(tx, rec); err != nil {
			return err
		}
		return s.cancelContinuations(tx, userID, canvasID, "", turnID, false)
	})
	if err != nil {
		return 0, err
	}
	return restoredRevision, nil
}
