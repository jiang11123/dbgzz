package app

import "testing"

func TestCanvasCapabilityAliasesKeepMediaModes(t *testing.T) {
	for _, mode := range []string{"image", "video", "audio"} {
		if !generationModeSupported(mode) || !cloudAgentGenerationModeSupported(mode) {
			t.Fatalf("%s must remain a supported generation mode for the local catalog", mode)
		}
	}
	if generationModeSupported("table-render") || cloudAgentGenerationModeSupported("table-render") {
		t.Fatal("table-render is not an implemented generation adapter")
	}
	if _, ok := cloudAgentNodeCapabilityForType("text"); !ok {
		t.Fatal("canvas text node capability missing")
	}
	if _, ok := canvasNodeCapabilityForType("image"); !ok {
		t.Fatal("canvas image node capability missing")
	}
}
