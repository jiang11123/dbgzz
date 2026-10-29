package canvas

import (
	"encoding/json"
	"infinite-canvas/backend/internal/kernel"
	"strings"
	"time"
)

func (s *Service) UserAssetsByIDs(userID string, ids []string) ([]json.RawMessage, error) {
	return s.Library().UserAssetsByIDs(userID, ids)
}

type CanvasLibrarySummary struct {
	ID           string           `json:"id"`
	ProjectID    string           `json:"projectId,omitempty"`
	FolderID     string           `json:"folderId,omitempty"`
	Title        string           `json:"title"`
	Revision     int64            `json:"revision"`
	CreatedAt    time.Time        `json:"createdAt"`
	UpdatedAt    time.Time        `json:"updatedAt"`
	NodeCount    int              `json:"nodeCount"`
	PreviewNodes []map[string]any `json:"previewNodes"`
}

type CanvasLibraryPage struct {
	Projects []CanvasLibrarySummary `json:"projects"`
	Page     int                    `json:"page"`
	PageSize int                    `json:"pageSize"`
	Total    int64                  `json:"total"`
	HasMore  bool                   `json:"hasMore"`
}

func (s *Service) UserCanvasProjectsPage(userID string, page int, pageSize int, projectID string, search string, sort string) (CanvasLibraryPage, error) {
	if page < 1 {
		page = 1
	}
	if page > 1000000 {
		return CanvasLibraryPage{}, kernel.BadAuthRequest("页码超出范围")
	}
	if pageSize < 1 {
		pageSize = 40
	}
	if pageSize > 50 {
		pageSize = 50
	}
	projects, total, err := s.repo.UserCanvasProjectsPage(userID, page, pageSize, projectID, search, sort)
	if err != nil {
		return CanvasLibraryPage{}, err
	}
	result := CanvasLibraryPage{Projects: make([]CanvasLibrarySummary, 0, len(projects)), Page: page, PageSize: pageSize, Total: total, HasMore: int64(page)*int64(pageSize) < total}
	for _, project := range projects {
		var document struct {
			Nodes []map[string]any `json:"nodes"`
		}
		if err := json.Unmarshal([]byte(project.PayloadJSON), &document); err != nil {
			return CanvasLibraryPage{}, err
		}
		preview := canvasLibraryPreviewNodes(document.Nodes)
		result.Projects = append(result.Projects, CanvasLibrarySummary{ID: project.ID, ProjectID: project.ProjectID, FolderID: project.LibraryFolderID, Title: project.Title, Revision: project.Revision, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt, NodeCount: len(document.Nodes), PreviewNodes: preview})
	}
	return result, nil
}

func canvasLibraryPreviewNodes(nodes []map[string]any) []map[string]any {
	preview := make([]map[string]any, 0, 4)
	for _, node := range nodes {
		if node["type"] != "image" && node["type"] != "video" {
			continue
		}
		original, _ := node["metadata"].(map[string]any)
		metadata := map[string]any{}
		if key, ok := original["storageKey"].(string); ok && len(key) <= 512 {
			metadata["storageKey"] = key
		}
		for _, key := range []string{"previewContent", "content"} {
			if value, ok := original[key].(string); ok && safeCanvasPreviewURL(value) {
				metadata[key] = value
			}
		}
		if videoPreview, ok := original["videoPreview"].(map[string]any); ok {
			if value, ok := videoPreview["content"].(string); ok && safeCanvasPreviewURL(value) {
				metadata["videoPreview"] = map[string]any{"content": value}
			}
		}
		if len(metadata) == 0 {
			continue
		}
		item := map[string]any{"position": map[string]int{"x": 0, "y": 0}, "metadata": metadata}
		for _, key := range []string{"id", "type", "title"} {
			if value, ok := node[key].(string); ok {
				runes := []rune(value)
				item[key] = string(runes[:min(len(runes), 256)])
			}
		}
		for _, key := range []string{"width", "height"} {
			if value, ok := node[key].(float64); ok {
				item[key] = value
			}
		}
		preview = append(preview, item)
	}
	return preview
}

func safeCanvasPreviewURL(value string) bool {
	return len(value) <= 2048 && (strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "/api/") || strings.HasPrefix(value, "/resources/"))
}
