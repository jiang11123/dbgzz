package operations

import (
	"encoding/json"
	"math"
	"strings"
)

func registerCanvasEditOps(r *Registry) {
	for _, action := range []struct{ id, summary, properties, required string }{
		{"canvas.node.move", "移动一个节点，保留节点内容、参数和素材", `"nodeId":{"type":"string"},"position":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"}},"required":["x","y"],"additionalProperties":false}`, `"nodeId","position"`},
		{"canvas.node.delete", "移除一个画布节点及连接；保留素材库原件和任务", `"nodeId":{"type":"string"}`, `"nodeId"`},
		{"canvas.edge.delete", "移除指定连接，保留两个节点及素材", `"edgeId":{"type":"string"}`, `"edgeId"`},
	} {
		id := action.id
		r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: id, Summary: action.summary, Scope: ScopeCanvas,
			Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"expectedRevision":{"type":"integer","minimum":0},` + action.properties + `},"required":["canvasId","expectedRevision",` + action.required + `],"additionalProperties":false}`),
			Handler: func(ctx *Context, params json.RawMessage) (any, error) { return editCanvas(ctx, params, id) },
		})
	}
}

func editCanvas(ctx *Context, params json.RawMessage, action string) (any, error) {
	var args struct {
		CanvasID         string `json:"canvasId"`
		NodeID           string `json:"nodeId"`
		EdgeID           string `json:"edgeId"`
		ExpectedRevision *int64 `json:"expectedRevision"`
		Position         *struct {
			X *float64 `json:"x"`
			Y *float64 `json:"y"`
		} `json:"position"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || args.ExpectedRevision == nil || *args.ExpectedRevision < 0 {
		return nil, InvalidArg("invalid_params", "canvasId 和有效 expectedRevision 必填")
	}
	if action == "canvas.edge.delete" {
		if strings.TrimSpace(args.EdgeID) == "" {
			return nil, InvalidArg("invalid_params", "edgeId 必填")
		}
	} else if strings.TrimSpace(args.NodeID) == "" {
		return nil, InvalidArg("invalid_params", "nodeId 必填")
	}
	if action == "canvas.node.move" {
		if args.Position == nil || args.Position.X == nil || args.Position.Y == nil || !finitePosition(*args.Position.X) || !finitePosition(*args.Position.Y) {
			return nil, InvalidArg("invalid_position", "position.x 和 position.y 必须是有效坐标")
		}
	}
	raw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, AsError(err)
	}
	result := map[string]any{"canvasId": args.CanvasID}
	if action == "canvas.edge.delete" {
		edges, found := removeCanvasEdges(doc, func(edge map[string]any) bool { return edge["id"] == args.EdgeID })
		if !found {
			return nil, NotFound("edge_not_found", "连接不属于这个画布")
		}
		result["deletedEdgeIds"] = edges
	} else {
		nodes := canvasNodes(doc)
		found := false
		kept := make([]any, 0, len(nodes))
		for _, item := range nodes {
			node, ok := item.(map[string]any)
			if !ok || node["id"] != args.NodeID {
				kept = append(kept, item)
				continue
			}
			found = true
			if action == "canvas.node.move" {
				node["position"] = map[string]any{"x": *args.Position.X, "y": *args.Position.Y}
				kept = append(kept, node)
			}
		}
		if !found {
			return nil, NotFound("node_not_in_canvas", "节点不属于这个画布")
		}
		doc["nodes"] = kept
		if action == "canvas.node.move" {
			result["nodeId"] = args.NodeID
		} else {
			result["deletedNodeIds"] = []string{args.NodeID}
			edges, _ := removeCanvasEdges(doc, func(edge map[string]any) bool {
				return edge["fromNodeId"] == args.NodeID || edge["toNodeId"] == args.NodeID
			})
			result["deletedEdgeIds"] = edges
		}
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		return nil, AsError(err)
	}
	summary, _, err := ctx.Domain.CommitUserCanvasDocument(ctx.UserID, args.CanvasID, *args.ExpectedRevision, encoded)
	if err != nil {
		return nil, mapDomainError(err)
	}
	result["revision"] = summary.Revision
	return result, nil
}

func finitePosition(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Abs(value) <= 1e7
}

func removeCanvasEdges(doc map[string]any, matches func(map[string]any) bool) ([]string, bool) {
	items, _ := doc["connections"].([]any)
	kept := make([]any, 0, len(items))
	removed := []string{}
	for _, item := range items {
		edge, ok := item.(map[string]any)
		if ok && matches(edge) {
			id, _ := edge["id"].(string)
			removed = append(removed, id)
		} else {
			kept = append(kept, item)
		}
	}
	doc["connections"] = kept
	return removed, len(removed) > 0
}
