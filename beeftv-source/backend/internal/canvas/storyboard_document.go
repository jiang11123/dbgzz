package canvas

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"

	"infinite-canvas/backend/internal/kernel"
)

// Whole-document UI commits obey the same row rules as external row commands.
// Reconcile only edited boards; unrelated saves preserve existing documents.
func reconcileStoryboardDocument(before, after json.RawMessage) (json.RawMessage, error) {
	var previous, next map[string]any
	if err := json.Unmarshal(before, &previous); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(after, &next); err != nil {
		return nil, err
	}
	original, err := json.Marshal(next)
	if err != nil {
		return nil, err
	}
	nodes, _ := next["nodes"].([]any)
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		if canvasNodeType(node) != storyboardNodeType {
			continue
		}
		id, _ := node["id"].(string)
		rows := storyboardDocumentRows(node)
		oldRows := storyboardDocumentRows(findCanvasNode(previous, id))
		oldJSON, _ := json.Marshal(oldRows)
		newJSON, _ := json.Marshal(rows)
		if string(oldJSON) == string(newJSON) {
			continue
		}
		remaining := map[string]bool{}
		for _, rawRow := range rows {
			row, ok := rawRow.(map[string]any)
			if !ok {
				return nil, kernel.NewAppError(http.StatusBadRequest, "分镜行格式错误")
			}
			rowID := rowIDOf(row)
			if rowID == "" || remaining[rowID] {
				return nil, kernel.NewAppError(http.StatusBadRequest, "分镜行 ID 为空或重复")
			}
			remaining[rowID] = true
			old := findStoryboardRow(oldRows, rowID)
			if reflect.DeepEqual(old, row) {
				continue
			}
			seconds, ok := row["durationSeconds"].(float64)
			if !ok {
				return nil, kernel.NewAppError(http.StatusBadRequest, "分镜时长必填")
			}
			if err := validateStoryboardDraft(StoryboardRowDraft{DurationSeconds: &seconds}); err != nil {
				return nil, err
			}
			if old != nil {
				invalidateStoryboardPromptTemplates(old, row)
			}
		}
		removed := map[string]bool{}
		for _, rawRow := range oldRows {
			if id := rowIDOf(rawRow); !remaining[id] {
				removed[id] = true
			}
		}
		if len(removed) > 0 {
			for index, rawRow := range rows {
				rawRow.(map[string]any)["shotNumber"] = float64(index + 1)
			}
			removeStoryboardConnections(next, id, removed)
		}
	}
	canonical, err := json.Marshal(next)
	if err != nil {
		return nil, err
	}
	// UI journal receipts confirm the submitted document, so never silently
	// persist a different graph. Manual UI already performs these transformations.
	if string(canonical) != string(original) {
		return nil, kernel.NewAppError(http.StatusBadRequest, "分镜修改须清除旧提示词模板、删除行的连线并重排镜号")
	}
	return after, nil
}

func storyboardDocumentRows(node map[string]any) []any {
	metadata, _ := node["metadata"].(map[string]any)
	board, _ := metadata["storyboard"].(map[string]any)
	rows, _ := board["rows"].([]any)
	return rows
}

func invalidateStoryboardPromptTemplates(before, after map[string]any) {
	for prompt, variables := range map[string]string{"imageGenerationPrompt": "imagePromptTemplateVariables", "videoMotionPrompt": "videoPromptTemplateVariables"} {
		if !reflect.DeepEqual(before[prompt], after[prompt]) {
			delete(after, variables)
		}
	}
}

func removeStoryboardConnections(doc map[string]any, nodeID string, remove map[string]bool) {
	connections, _ := doc["connections"].([]any)
	kept := make([]any, 0, len(connections))
	for _, raw := range connections {
		edge, ok := raw.(map[string]any)
		if ok {
			rowID, _ := edge["storyboardRowId"].(string)
			fromHandle, _ := edge["fromHandleId"].(string)
			toHandle, _ := edge["toHandleId"].(string)
			from, to := edge["fromNodeId"] == nodeID, edge["toNodeId"] == nodeID
			if (from || to) && remove[rowID] || from && strings.HasPrefix(fromHandle, "row:") && remove[strings.TrimPrefix(fromHandle, "row:")] || to && strings.HasPrefix(toHandle, "row:") && remove[strings.TrimPrefix(toHandle, "row:")] {
				continue
			}
		}
		kept = append(kept, raw)
	}
	doc["connections"] = kept
}
