package task

import (
	"encoding/json"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/providerpreset"
	"strconv"
	"strings"
)

// A variable Seedream response is one paid task. Extra destinations derive from
// that task identity, rather than all overwriting its single requested node.
func SeedreamOutputRoot(task model.Task) string {
	if task.Type != "canvas_image" {
		return ""
	}
	name := task.Model
	if i := strings.LastIndex(name, "::"); i >= 0 {
		name = name[i+2:]
	}
	if providerpreset.SeedreamFamily(name) == "" {
		return ""
	}
	var input struct {
		Metadata struct {
			NodeID        string   `json:"nodeId"`
			OutputNodeIDs []string `json:"outputNodeIds"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || len(input.Metadata.OutputNodeIDs) > 1 {
		return ""
	}
	if len(input.Metadata.OutputNodeIDs) == 1 {
		return strings.TrimSpace(input.Metadata.OutputNodeIDs[0])
	}
	return strings.TrimSpace(input.Metadata.NodeID)
}

func SeedreamOutputNodeID(task model.Task, index int) string {
	root := SeedreamOutputRoot(task)
	if root == "" || index < 0 || index > 16 {
		return ""
	}
	if index == 0 {
		return root
	}
	return "image-output-" + task.ID + "-" + strconv.Itoa(index)
}

func OutputBinding(task model.Task, index int) TargetBinding {
	binding := TargetBindingFromInput(task.InputJSON)
	if SeedreamOutputRoot(task) != "" {
		binding.NodeID = SeedreamOutputNodeID(task, index)
	}
	return binding
}
