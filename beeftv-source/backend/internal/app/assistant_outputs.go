package app

import (
	"encoding/json"
	"errors"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

// AssistantOutput identifies an admitted local render. Ready/failed state and
// playable resources still come from the existing owned task API.
type AssistantOutput struct {
	TaskID         string `json:"taskId"`
	Kind           string `json:"kind"`
	SourceRevision *int64 `json:"sourceRevision,omitempty"`
	ResourceID     string `json:"resourceId,omitempty"`
	FileName       string `json:"fileName,omitempty"`
}

func (s *Service) AssistantTurnOutputs(userID, canvasID, turnID string) ([]AssistantOutput, error) {
	outputs := []AssistantOutput{}
	refs, err := s.assistantTurnsOrInit().RenderOutputRefs(userID, canvasID, turnID)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, ref := range refs {
		task, err := s.Task(userID, ref.TaskID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if task.Type != model.TaskTypeTimelineRender || task.Provider != "local" || task.UserID != userID || task.ProjectID != ref.CanvasID || task.ClientOperationID == nil || *task.ClientOperationID != "assistant-render:"+ref.OperationID || seen[task.ID] {
			continue
		}
		if _, err := s.UserCanvasProject(userID, ref.CanvasID); err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			return nil, err
		}
		seen[task.ID] = true
		outputs = append(outputs, AssistantOutput{TaskID: task.ID, Kind: "video", SourceRevision: ref.SourceRevision})
	}
	var turn model.AssistantTurn
	if err := s.repo.DB().First(&turn, "turn_id = ? AND user_id = ? AND canvas_id = ?", turnID, userID, canvasID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return outputs, nil
		}
		return nil, err
	}
	var receipts []model.AgentOpRecord
	if err := s.repo.DB().Where("user_id = ? AND turn_id = ? AND op = ? AND status = ?", userID, turnID, "canvas.project.export", "succeeded").Order("created_at ASC").Find(&receipts).Error; err != nil {
		return nil, err
	}
	for _, receipt := range receipts {
		var result struct {
			CanvasID       string `json:"canvasId"`
			ResourceID     string `json:"resourceId"`
			FileName       string `json:"fileName"`
			SourceRevision *int64 `json:"sourceRevision"`
		}
		if json.Unmarshal([]byte(receipt.ResultJSON), &result) != nil || result.CanvasID != canvasID || result.ResourceID == "" {
			continue
		}
		resource, err := s.repo.ResourceByUploadKey(userID, "project-export:"+receipt.OpID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if resource.ID != result.ResourceID || resource.Status != model.ResourceStatusReady || resource.MimeType != "application/zip" {
			continue
		}
		outputs = append(outputs, AssistantOutput{Kind: "project", ResourceID: resource.ID, FileName: result.FileName, SourceRevision: result.SourceRevision})
	}
	return outputs, nil
}
