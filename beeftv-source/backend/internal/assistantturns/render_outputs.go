package assistantturns

import (
	"encoding/json"
	"sort"
	"strings"
)

// RenderOutputRef comes only from a committed render admission receipt, not
// assistant text. Task ownership and the admission operation are checked by app.
type RenderOutputRef struct {
	TaskID         string
	CanvasID       string
	OperationID    string
	SourceRevision *int64
}

func (s *Service) RenderOutputRefs(userID, canvasID, turnID string) ([]RenderOutputRef, error) {
	refs := []RenderOutputRef{}
	if NormalizeTurnID(turnID) == "" || userID == "" || canvasID == "" {
		return refs, nil
	}
	rec, err := s.load(nil, turnID)
	if err != nil {
		if isMissing(err) {
			return refs, nil
		}
		return nil, err
	}
	if rec.UserID != userID || rec.CanvasID != canvasID || !s.storeReady() {
		return refs, nil
	}
	rows, err := s.store.SucceededByTurn(nil, userID, turnID)
	if err != nil {
		return nil, err
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].CreatedAt.Equal(rows[j].CreatedAt) {
			return rows[i].OpID < rows[j].OpID
		}
		return rows[i].CreatedAt.Before(rows[j].CreatedAt)
	})
	for _, row := range rows {
		if row.Op != "canvas.timeline.render" {
			continue
		}
		var result struct {
			TaskID         string `json:"taskId"`
			CanvasID       string `json:"canvasId"`
			SourceRevision *int64 `json:"sourceRevision"`
		}
		if json.Unmarshal([]byte(row.ResultJSON), &result) != nil || strings.TrimSpace(result.TaskID) == "" || strings.TrimSpace(result.CanvasID) == "" {
			continue
		}
		if result.CanvasID != rec.CanvasID && Mode(rec.PermissionMode) != PermissionFullAccess {
			continue
		}
		if result.SourceRevision != nil && *result.SourceRevision < 0 {
			result.SourceRevision = nil
		}
		refs = append(refs, RenderOutputRef{TaskID: result.TaskID, CanvasID: result.CanvasID, OperationID: row.OpID, SourceRevision: result.SourceRevision})
	}
	return refs, nil
}
