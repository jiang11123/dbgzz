package creation

import (
	"encoding/json"

	"infinite-canvas/backend/internal/canvas/capability"
	"infinite-canvas/backend/internal/kernel"
)

func ValidateOps(ops []CanvasOp) error {
	if len(ops) == 0 || len(ops) > 100 {
		return kernel.BadAuthRequest("方案必须包含 1 到 100 项明确画布操作")
	}
	if err := ValidateJSON(ops); err != nil {
		return err
	}
	ids := map[string]bool{}
	registry := capability.BuiltinRegistry()
	for _, op := range ops {
		switch op.Type {
		case "add_node":
			if op.ID == "" || ids[op.ID] {
				return kernel.BadAuthRequest("新增节点必须使用不重复的稳定 ID")
			}
			ids[op.ID] = true
			if _, ok := registry.Resolve(op.NodeType); !ok {
				return kernel.BadAuthRequest("该节点类型不在本期创作范围")
			}
		case "update_node":
			if op.ID == "" {
				return kernel.BadAuthRequest("更新节点缺少 ID")
			}
			for key := range op.Patch {
				switch key {
				case "title", "position", "width", "height", "metadata":
				default:
					return kernel.BadAuthRequest("方案包含不支持的节点更新字段")
				}
			}
		case "connect_nodes":
			if op.ID == "" || op.FromNodeID == "" || op.ToNodeID == "" {
				return kernel.BadAuthRequest("连线必须有稳定 ID 和两个端点")
			}
		case "select_nodes":
		default:
			return kernel.BadAuthRequest("创作方案仅允许新增、连线、更新和选择节点")
		}
	}
	return nil
}

func ApprovalBaseline(raw string, ops []CanvasOp) (string, error) {
	doc, err := parseDocument(raw)
	if err != nil {
		return "", err
	}
	nodes, err := documentObjects(doc["nodes"])
	if err != nil {
		return "", err
	}
	selected := []any{}
	for _, op := range ops {
		if op.Type != "update_node" {
			continue
		}
		node := nodes[op.ID]
		if node == nil {
			return "", Conflict("待修改节点不存在")
		}
		baseline := map[string]any{"id": op.ID}
		for key := range op.Patch {
			if key != "metadata" {
				baseline[key] = node[key]
			}
		}
		metadata, _ := node["metadata"].(map[string]any)
		patch, _ := op.Patch["metadata"].(map[string]any)
		saved := map[string]any{}
		for key := range MergeMaps(patch, op.Metadata) {
			saved[key] = metadata[key]
		}
		baseline["metadata"] = saved
		selected = append(selected, baseline)
	}
	value := map[string]any{"nodes": selected}
	if err = ValidateJSON(value); err != nil {
		return "", err
	}
	b, err := json.Marshal(value)
	return string(b), err
}
