package canvas

import (
	"fmt"
	"strings"
)

// PrepareSeedreamOutputs expands a variable response once, in the same owned
// canvas document as its original node. Persisted IDs also act as tombstones:
// deleting a generated sibling must not make the recovery worker recreate it.
func (s *Service) PrepareSeedreamOutputs(userID, canvasID, rootID, taskID string, outputs []TaskOutputBind, layers map[int]map[string]any) error {
	for attempt := 0; attempt < bindRevisionAttempts; attempt++ {
		doc, err := s.loadCanvasDoc(userID, canvasID)
		if err != nil {
			return err
		}
		if !prepareSeedreamOutputs(doc, rootID, taskID, outputs, layers) {
			return nil
		}
		s.reconcileBoundCanvasDocMediaAssets(userID, doc)
		expected := canvasRevisionValue(doc)
		if expected <= 0 {
			expected = 1
		}
		_, err = s.saveCanvasDocWithRevision(userID, canvasID, doc, expected)
		if err == nil {
			return nil
		}
		if !isCanvasRevisionConflict(err) {
			return err
		}
	}
	return canvasRevisionConflict()
}

func prepareSeedreamOutputs(doc map[string]any, rootID, taskID string, outputs []TaskOutputBind, layers map[int]map[string]any) bool {
	root := findCanvasNode(doc, rootID)
	if root == nil || nodeString(nodeMetadata(root), "taskId") != taskID {
		return false
	}
	meta := nodeMetadata(root)
	declared := map[string]bool{}
	if ids, ok := meta["generationOutputNodeIds"].([]any); ok {
		for _, id := range ids {
			if text, ok := id.(string); ok {
				declared[text] = true
			}
		}
	}
	nodes := canvasDocNodes(doc)
	changed := false
	// Preserve an immutable source for sibling settings while restoring output 0.
	template := cloneNode(root)
	x, y := seedreamNodePosition(root)
	width := seedreamNumber(root, "width", 340)
	height := seedreamNumber(root, "height", 240)
	for _, output := range outputs {
		if output.NodeID == "" || output.TaskID != taskID || output.OutputIndex < 0 || output.OutputIndex > 16 || declared[output.NodeID] {
			continue
		}
		node := findCanvasNode(doc, output.NodeID)
		if output.OutputIndex == 0 {
			node = root
		} else if node != nil {
			continue
		} else {
			node = cloneNode(template)
			node["id"] = output.NodeID
			px, py := x+width+80, y+float64(output.OutputIndex-1)*(height+80)
			// A separate column keeps earlier user nodes and their positions intact.
			for tries := 0; tries < 1000 && seedreamPositionOccupied(nodes, px, py, width, height); tries++ {
				py += height + 80
			}
			node["position"] = map[string]any{"x": px, "y": py}
			node["title"] = fmt.Sprintf("%s · %d", nodeString(template, "title"), output.OutputIndex+1)
			childMeta := nodeMetadata(node)
			for _, key := range []string{"generationEffectKeys", "generationOutputNodeIds", "batchRootId", "batchChildIds", "primaryImageId", "assetId", "content", "storageKey"} {
				delete(childMeta, key)
			}
			childMeta["isBatchRoot"] = false
			node["metadata"] = childMeta
			nodes = append(nodes, node)
			doc["nodes"] = nodes
		}
		nm := nodeMetadata(node)
		applyGenerationBindMetadata(nm, output)
		nm["taskOutputIndex"] = output.OutputIndex
		if layer, ok := layers[output.OutputIndex]; ok {
			nm["imageLayer"] = layer
			if name, _ := layer["name"].(string); strings.TrimSpace(name) != "" && output.OutputIndex > 0 {
				node["title"] = name
			}
		}
		node["metadata"] = nm
		declared[output.NodeID] = true
		changed = true
	}
	if !changed {
		return false
	}
	ids := make([]any, 0, len(declared))
	// Output indices, not map iteration, define stable document order.
	for _, output := range outputs {
		if declared[output.NodeID] {
			ids = append(ids, output.NodeID)
		}
	}
	for _, id := range metaIDs(meta["generationOutputNodeIds"]) {
		found := false
		for _, v := range ids {
			if v == id {
				found = true
				break
			}
		}
		if !found {
			ids = append(ids, id)
		}
	}
	rm := nodeMetadata(root)
	rm["generationOutputNodeIds"] = ids
	root["metadata"] = rm
	return true
}
func metaIDs(value any) []string {
	var out []string
	if a, ok := value.([]any); ok {
		for _, v := range a {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
func seedreamNumber(n map[string]any, key string, fallback float64) float64 {
	if v, ok := n[key].(float64); ok {
		return v
	}
	return fallback
}
func seedreamNodePosition(n map[string]any) (float64, float64) {
	p, _ := n["position"].(map[string]any)
	return seedreamNumber(p, "x", 0), seedreamNumber(p, "y", 0)
}
func seedreamPositionOccupied(nodes []any, x, y, w, h float64) bool {
	for _, raw := range nodes {
		n, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		nx, ny := seedreamNodePosition(n)
		nw := seedreamNumber(n, "width", 340)
		nh := seedreamNumber(n, "height", 240)
		if x < nx+nw+20 && x+w+20 > nx && y < ny+nh+20 && y+h+20 > ny {
			return true
		}
	}
	return false
}
