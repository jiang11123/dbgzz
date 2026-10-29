package app

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func (s *Service) agentCurrentProject(userID, canvasID string) (*model.CanvasProject, error) {
	current, err := s.repo.CanvasProjectForUser(userID, canvasID)
	if err != nil {
		return nil, kernel.Forbidden("当前画布不存在或不属于当前工作区")
	}
	if current.ProjectID != "" {
		if _, err := s.activeProjectForUser(userID, current.ProjectID); err != nil {
			return nil, err
		}
	}
	return current, nil
}

// Every read resolves current DB membership, including after host recovery.
// A search result or model-provided ID is never itself an authorization receipt.
func (s *Service) ValidateAgentProjectReference(userID, canvasID, kind, id string) error {
	current, err := s.agentCurrentProject(userID, canvasID)
	if err != nil {
		return err
	}
	if current.ProjectID == "" {
		return kernel.Forbidden("当前画布未关联项目，只能使用已引用的资源")
	}
	switch kind {
	case "asset":
		if _, err := s.repo.AssetForUser(userID, id); err != nil {
			return kernel.Forbidden("素材不属于当前项目")
		}
		linked, err := s.repo.ProjectAssetLinked(current.ProjectID, id)
		if err != nil {
			return err
		}
		if linked {
			return nil
		}
	case "canvas":
		other, err := s.repo.CanvasProjectForUser(userID, id)
		if err == nil && other.ProjectID == current.ProjectID {
			return nil
		}
	}
	return kernel.Forbidden("资源不属于当前画布的项目")
}

func agentAssetSearchItem(raw json.RawMessage) (map[string]any, error) {
	var payload struct {
		ID    string `json:"id"`
		Title string `json:"title"`
		Kind  string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	return map[string]any{"assetId": payload.ID, "title": payload.Title, "kind": payload.Kind}, nil
}

func (s *operationSession) SearchAgentProject(userID, canvasID, target, query, kind string, page, size int) (any, error) {
	current, err := s.service.agentCurrentProject(userID, canvasID)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"canvasId": canvasID, "projectId": current.ProjectID, "page": page, "pageSize": size, "items": []any{}, "total": int64(0), "hasMore": false}
	items := []any{}
	if target == "canvas" {
		if current.ProjectID == "" {
			if strings.Contains(strings.ToLower(current.Title), strings.ToLower(query)) {
				result["total"] = int64(1)
				if page == 1 {
					items = append(items, map[string]any{"canvasId": current.ID, "title": current.Title, "revision": current.Revision})
				}
			}
		} else {
			found, err := s.canvas.UserCanvasProjectsPage(userID, page, size, current.ProjectID, query, "")
			if err != nil {
				return nil, err
			}
			for _, item := range found.Projects {
				items = append(items, map[string]any{"canvasId": item.ID, "title": item.Title, "revision": item.Revision, "nodeCount": item.NodeCount})
			}
			result["total"], result["hasMore"] = found.Total, found.HasMore
		}
	} else if current.ProjectID != "" {
		found, err := s.canvas.UserAssetsPage(userID, page, size, canvas.UserAssetPageFilter{ProjectID: current.ProjectID, Query: query, Kind: kind})
		if err != nil {
			return nil, err
		}
		for _, raw := range found.Assets {
			item, err := agentAssetSearchItem(raw)
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		result["total"], result["hasMore"] = found.Total, found.HasMore
	} else {
		ids, _ := assistantturns.AssociatedReferences(json.RawMessage(current.PayloadJSON))
		if len(ids) > 1000 {
			return nil, kernel.BadAuthRequest("当前画布关联素材过多，请缩小范围")
		}
		for _, id := range ids {
			asset, err := s.service.repo.AssetForUser(userID, id)
			if err != nil {
				return nil, err
			}
			if (kind == "" || asset.Kind == kind) && strings.Contains(strings.ToLower(asset.Title), strings.ToLower(query)) {
				items = append(items, map[string]any{"assetId": asset.ID, "title": asset.Title, "kind": asset.Kind})
			}
		}
		var document struct {
			Nodes []map[string]any `json:"nodes"`
		}
		if err := json.Unmarshal([]byte(current.PayloadJSON), &document); err != nil {
			return nil, err
		}
		if len(document.Nodes) > 1000 {
			return nil, kernel.BadAuthRequest("当前画布节点过多，请缩小范围")
		}
		for _, node := range document.Nodes {
			nodeKind, _ := node["type"].(string)
			title, _ := node["title"].(string)
			nodeID, _ := node["id"].(string)
			if (nodeKind != "image" && nodeKind != "video" && nodeKind != "audio") || (kind != "" && nodeKind != kind) || !strings.Contains(strings.ToLower(title), strings.ToLower(query)) {
				continue
			}
			raw, _ := json.Marshal(node)
			resources, err := operations.ReferencedMediaResourceIDs(raw)
			if err != nil {
				return nil, err
			}
			if len(resources) == 0 || nodeID == "" {
				continue
			}
			for _, id := range resources {
				if _, err := s.OwnedReadyResource(userID, id); err != nil {
					return nil, err
				}
			}
			items = append(items, map[string]any{"nodeId": nodeID, "title": title, "kind": nodeKind, "resourceIds": resources})
		}
		result["total"], result["hasMore"] = int64(len(items)), page*size < len(items)
		start := (page - 1) * size
		if start >= len(items) {
			items = []any{}
		} else {
			end := start + size
			if end > len(items) {
				end = len(items)
			}
			items = items[start:end]
		}
	}
	result["items"] = items
	return result, nil
}
