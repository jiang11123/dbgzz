package canvas

import "testing"

func TestSeedreamOutputsDoNotOverwriteOrResurrect(t *testing.T) {
	doc := map[string]any{"nodes": []any{map[string]any{"id": "root", "title": "original", "type": "image", "position": map[string]any{"x": 0.0, "y": 0.0}, "width": 340.0, "height": 240.0, "metadata": map[string]any{"taskId": "task", "content": "old-last-image"}}}}
	outputs := []TaskOutputBind{{NodeID: "root", TaskID: "task", OutputIndex: 0, Content: "base", EffectKey: "base-effect"}, {NodeID: "derived-1", TaskID: "task", OutputIndex: 1, Content: "transparent-layer", EffectKey: "layer-effect"}}
	layers := map[int]map[string]any{1: {"name": "teapot", "z_index": 1.0, "bounding_box": map[string]any{"absolute": []any{1.0, 2.0, 3.0, 4.0}}}}
	if !prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("not expanded")
	}
	if len(canvasDocNodes(doc)) != 2 || nodeString(nodeMetadata(findCanvasNode(doc, "root")), "content") != "base" {
		t.Fatal("original overwritten")
	}
	child := findCanvasNode(doc, "derived-1")
	if nodeString(nodeMetadata(child), "content") != "transparent-layer" || nodeMetadata(child)["imageLayer"] == nil {
		t.Fatal("layer missing")
	}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("not idempotent")
	}
	doc["nodes"] = []any{findCanvasNode(doc, "root")}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) || len(canvasDocNodes(doc)) != 1 {
		t.Fatal("deleted output resurrected")
	}
	findCanvasNode(doc, "root")["metadata"] = map[string]any{"taskId": "new-task"}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("new request overwritten")
	}
	doc["nodes"] = []any{}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("deleted root recreated")
	}
}
