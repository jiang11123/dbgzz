package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/kernel"

	"gorm.io/gorm"
)

// CommitUserCanvasDocument 把调用方给出的顶层文档覆盖应用到已存在的画布。
// 这不是建画布，也不是任意数据库补丁：只覆盖 overlay 里出现的顶层字段，
// 当前文档里未触及的键保持原样；身份、revision 与视口仍由服务端裁决。
func (s *Service) CommitUserCanvasDocument(userID, canvasID string, expectedRevision int64, document json.RawMessage) (UserDataSummary, json.RawMessage, error) {
	canvasID = strings.TrimSpace(canvasID)
	if canvasID == "" {
		return UserDataSummary{}, nil, kernel.BadAuthRequest("画布 ID 必填")
	}
	if expectedRevision < 0 {
		return UserDataSummary{}, nil, kernel.BadAuthRequest("画布版本无效")
	}
	existing, err := s.repo.CanvasProjectForUser(userID, canvasID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return UserDataSummary{}, nil, kernel.NewAppError(http.StatusNotFound, "画布不存在或无权访问")
	}
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	current, err := canvasProjectPayload(*existing)
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	merged, err := mergeCanvasDocumentOverlay(current, document, canvasID, expectedRevision)
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	merged, err = reconcileStoryboardDocument(current, merged)
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	summary, err := s.UpsertUserCanvasProject(userID, merged)
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	after, err := s.UserCanvasProject(userID, canvasID)
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	return summary, after, nil
}

func mergeCanvasDocumentOverlay(current, overlay json.RawMessage, canvasID string, expectedRevision int64) (json.RawMessage, error) {
	base := map[string]json.RawMessage{}
	if len(current) > 0 {
		if err := json.Unmarshal(current, &base); err != nil {
			return nil, kernel.BadAuthRequest("画布数据格式错误")
		}
	}
	if len(overlay) == 0 || strings.TrimSpace(string(overlay)) == "null" {
		return nil, kernel.BadAuthRequest("画布文档必填")
	}
	var patch map[string]json.RawMessage
	if err := json.Unmarshal(overlay, &patch); err != nil {
		return nil, kernel.BadAuthRequest("画布文档格式错误")
	}
	if patch == nil {
		return nil, kernel.BadAuthRequest("画布文档格式错误")
	}
	for key, value := range patch {
		switch key {
		case "id", "revision", "remoteContentHash", "viewport":
			continue
		default:
			base[key] = value
		}
	}
	idJSON, err := json.Marshal(canvasID)
	if err != nil {
		return nil, err
	}
	revJSON, err := json.Marshal(expectedRevision)
	if err != nil {
		return nil, err
	}
	base["id"] = idJSON
	base["revision"] = revJSON
	delete(base, "remoteContentHash")
	return json.Marshal(base)
}
