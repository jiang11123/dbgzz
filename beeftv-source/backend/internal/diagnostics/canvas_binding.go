package diagnostics

import (
	"encoding/json"
	"errors"
	"time"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

// Only identities and state flags are exported, never node text or media addresses.
type CanvasBindingEvidence struct {
	Source                string `json:"source"`
	NodeID                string `json:"nodeId,omitempty"`
	NodeTaskID            string `json:"nodeTaskId,omitempty"`
	ClientOperationID     string `json:"clientOperationId,omitempty"`
	NodeClientOperationID string `json:"nodeClientOperationId,omitempty"`
	NodeType              string `json:"nodeType,omitempty"`
	NodeStatus            string `json:"nodeStatus,omitempty"`
	Revision              int64  `json:"revision,omitempty"`
	OutputIndex           *int   `json:"outputIndex,omitempty"`
	NodePresent           *bool  `json:"nodePresent,omitempty"`
	NodeHasMedia          *bool  `json:"nodeHasMedia,omitempty"`
}

type canvasBindingRecord struct {
	TaskID       string    `json:"taskId"`
	CanvasID     string    `json:"canvasId"`
	SampledAt    time.Time `json:"sampledAt"`
	CanvasStatus string    `json:"canvasStatus"`
	CanvasBindingEvidence
}

func sanitizeCanvasBinding(input *CanvasBindingEvidence) *CanvasBindingEvidence {
	if input == nil || (input.Source != "client" && input.Source != "server") {
		return nil
	}
	var outputIndex *int
	if input.OutputIndex != nil {
		value := boundedInt(*input.OutputIndex, 0, 999)
		outputIndex = &value
	}
	return &CanvasBindingEvidence{
		Source: input.Source, NodeID: sanitizeIdentifier(input.NodeID), NodeTaskID: sanitizeIdentifier(input.NodeTaskID),
		ClientOperationID: sanitizeOperationID(input.ClientOperationID), NodeClientOperationID: sanitizeOperationID(input.NodeClientOperationID),
		NodeType: sanitizeIdentifier(input.NodeType), NodeStatus: sanitizeIdentifier(input.NodeStatus),
		Revision: boundedInt64(input.Revision, 0, 1<<53-1), OutputIndex: outputIndex,
		NodePresent: input.NodePresent, NodeHasMedia: input.NodeHasMedia,
	}
}

func sanitizeOperationID(value string) string {
	if len(value) > 128 {
		return ""
	}
	// Unlike object IDs, admission accepts operation IDs up to 128 bytes.
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == ':' || char == '_' || char == '-' {
			continue
		}
		return ""
	}
	return value
}

func taskNodeIDs(task model.Task) []string {
	var input struct {
		Metadata struct {
			NodeID        string   `json:"nodeId"`
			OutputNodeIDs []string `json:"outputNodeIds"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil {
		return nil
	}
	ids := input.Metadata.OutputNodeIDs
	if len(ids) == 0 {
		if input.Metadata.NodeID == "" {
			return nil
		}
		ids = []string{input.Metadata.NodeID}
	}
	if len(ids) > 32 {
		ids = ids[:32]
	}
	for index := range ids {
		ids[index] = sanitizeIdentifier(ids[index])
	}
	return ids
}

func (s *Service) collectCanvasBindings(userID string, tasks []model.Task, collected *collection) {
	type canvasRead struct {
		project *model.CanvasProject
		err     error
	}
	cache := map[string]canvasRead{}
	for _, task := range tasks {
		if task.ProjectID == "" {
			continue
		}
		for outputIndex, nodeID := range taskNodeIDs(task) {
			if nodeID == "" {
				continue
			}
			read, ok := cache[task.ProjectID]
			if !ok {
				read.project, read.err = s.store.CanvasProjectForUser(userID, task.ProjectID)
				cache[task.ProjectID] = read
			}
			collected.recordAuthError(read.err)
			record := canvasBindingRecord{TaskID: task.ID, CanvasID: sanitizeIdentifier(task.ProjectID), SampledAt: s.now().UTC(), CanvasStatus: "available",
				CanvasBindingEvidence: CanvasBindingEvidence{Source: "server", NodeID: nodeID, OutputIndex: &outputIndex}}
			if task.ClientOperationID != nil {
				record.ClientOperationID = sanitizeOperationID(*task.ClientOperationID)
			}
			switch {
			case errors.Is(read.err, gorm.ErrRecordNotFound):
				record.CanvasStatus = "missing"
			case read.err != nil || read.project == nil:
				record.CanvasStatus = "unavailable"
			default:
				record.Revision = read.project.Revision
				var doc struct {
					Nodes []map[string]any `json:"nodes"`
				}
				if json.Unmarshal([]byte(read.project.PayloadJSON), &doc) != nil {
					record.CanvasStatus = "invalid"
					break
				}
				present, media := false, false
				record.NodePresent = &present
				for _, node := range doc.Nodes {
					if node["id"] != nodeID {
						continue
					}
					present = true
					metadata, _ := node["metadata"].(map[string]any)
					text := func(fields map[string]any, key string) string { value, _ := fields[key].(string); return value }
					record.NodeType = sanitizeIdentifier(text(node, "type"))
					record.NodeTaskID = sanitizeIdentifier(text(metadata, "taskId"))
					record.NodeClientOperationID = sanitizeOperationID(text(metadata, "taskClientOperationId"))
					record.NodeStatus = sanitizeIdentifier(text(metadata, "status"))
					media = canvas.NodeHasMedia(node)
					record.NodeHasMedia = &media
					break
				}
			}
			collected.CanvasBindings = append(collected.CanvasBindings, record)
		}
	}
}
