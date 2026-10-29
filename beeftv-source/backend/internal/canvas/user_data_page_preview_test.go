package canvas

import "testing"

func TestCanvasLibraryPreviewFindsMediaBeyondFourNodes(t *testing.T) {
	nodes := []map[string]any{
		{"id": "text-1", "type": "text"},
		{"id": "text-2", "type": "text"},
		{"id": "text-3", "type": "text"},
		{"id": "text-4", "type": "text"},
		{"id": "image", "type": "image", "metadata": map[string]any{"content": "https://example.com/image.png"}},
	}
	preview := canvasLibraryPreviewNodes(nodes)
	if len(preview) != 1 || preview[0]["id"] != "image" {
		t.Fatalf("unexpected preview: %#v", preview)
	}
	metadata := preview[0]["metadata"].(map[string]any)
	if metadata["content"] != "https://example.com/image.png" {
		t.Fatalf("preview lost media address: %#v", metadata)
	}
}
