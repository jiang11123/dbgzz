package project

import (
	"encoding/json"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) LinkCanvasUnit(userID string, projectID string, req LinkCanvasUnitRequest) (model.CanvasUnitLink, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return model.CanvasUnitLink{}, err
	}
	canvasID := strings.TrimSpace(req.CanvasID)
	unitID := strings.TrimSpace(req.UnitID)
	if canvasID == "" || unitID == "" {
		return model.CanvasUnitLink{}, kernel.BadAuthRequest("画布和章节不能为空")
	}
	canvas, err := s.repo.CanvasProjectForUser(userID, canvasID)
	if err != nil {
		return model.CanvasUnitLink{}, err
	}
	if _, err := s.repo.ProjectUnit(projectID, unitID); err != nil {
		return model.CanvasUnitLink{}, err
	}
	role := strings.TrimSpace(req.Role)
	if role == "" {
		role = "storyboard"
	}
	now := time.Now()
	payloadJSON, err := canvasPayloadWithProject(canvas.PayloadJSON, projectID, now)
	if err != nil {
		return model.CanvasUnitLink{}, err
	}
	link := model.CanvasUnitLink{ID: kernel.NewID(), ProjectID: projectID, CanvasID: canvasID, UnitID: unitID, Role: role, CreatedAt: now}
	if err := s.repo.LinkCanvasUnitAtomic(userID, projectID, canvas.Revision, payloadJSON, now, &link); err != nil {
		return model.CanvasUnitLink{}, mapProjectWriteError(err)
	}
	return link, nil
}

func (s *Service) UnlinkCanvasUnit(userID string, projectID string, canvasID string, unitID string) error {
	if _, err := s.Active(userID, projectID); err != nil {
		return err
	}
	canvas, err := s.repo.CanvasProjectForUser(userID, strings.TrimSpace(canvasID))
	if err != nil {
		return err
	}
	if canvas.ProjectID != projectID {
		return kernel.BadAuthRequest("画布不属于当前项目")
	}
	if _, err := s.repo.CanvasUnitLink(projectID, canvas.ID, strings.TrimSpace(unitID)); err != nil {
		return err
	}
	return mapProjectWriteError(s.repo.DeleteCanvasUnitLinkActive(userID, projectID, canvas.ID, strings.TrimSpace(unitID)))
}

func (s *Service) UnlinkCanvasProject(userID string, projectID string, canvasID string) error {
	if _, err := s.Active(userID, projectID); err != nil {
		return err
	}
	canvas, err := s.repo.CanvasProjectForUser(userID, strings.TrimSpace(canvasID))
	if err != nil {
		return err
	}
	if canvas.ProjectID != projectID {
		return kernel.BadAuthRequest("画布不属于当前项目")
	}
	now := time.Now()
	payloadJSON, err := canvasPayloadWithoutProject(canvas.PayloadJSON, now)
	if err != nil {
		return err
	}
	// 关系列、同步快照和更新时间必须原子更新，否则浏览器会用旧 projectId 把关系重新写回。
	return mapProjectWriteError(s.repo.UnassignCanvasFromProjectActive(userID, projectID, canvas.ID, payloadJSON, now, canvas.Revision))
}

func canvasPayloadWithoutProject(payloadJSON string, updatedAt time.Time) (string, error) {
	return rewriteCanvasPayloadProjectID(payloadJSON, "", updatedAt, false)
}

func canvasPayloadWithProject(payloadJSON string, projectID string, updatedAt time.Time) (string, error) {
	return rewriteCanvasPayloadProjectID(payloadJSON, projectID, updatedAt, true)
}

func rewriteCanvasPayloadProjectID(payloadJSON string, projectID string, updatedAt time.Time, assign bool) (string, error) {
	var payload map[string]any
	if strings.TrimSpace(payloadJSON) == "" {
		payload = map[string]any{}
	} else if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return "", kernel.BadAuthRequest("画布数据格式错误，无法更新项目关系")
	}
	if assign {
		payload["projectId"] = projectID
	} else {
		delete(payload, "projectId")
	}
	payload["updatedAt"] = updatedAt.Format(time.RFC3339Nano)
	next, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(next), nil
}
