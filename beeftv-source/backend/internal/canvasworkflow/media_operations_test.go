package canvasworkflow

import (
	"reflect"
	"testing"
)

func TestWorkflowMediaOperationsCompileClosedArguments(t *testing.T) {
	cases := []struct {
		id, kind string
		config   map[string]any
		want     []string
	}{
		{"image.crop", "image", map[string]any{"x": 0.25, "y": 0.0, "width": 0.5, "height": 1.0}, []string{"-vf", "crop=640:720:320:0", "-frames:v", "1", "-an"}},
		{"image.resize", "image", map[string]any{"longEdge": 2048.0}, []string{"-vf", "scale=2048:1152:flags=bicubic", "-frames:v", "1", "-an"}},
		{"video.frame", "image", map[string]any{"seconds": 1.5}, []string{"-ss", "1.500", "-frames:v", "1", "-an"}},
		{"video.audio", "audio", nil, []string{"-vn", "-c:a", "aac"}},
	}
	for _, tc := range cases {
		n := Node{ID: "step", Role: "operation", OperationID: tc.id, OperationVersion: 1, MediaType: tc.kind, Config: tc.config}
		args, _, _, err := MediaCommand(n, 1280, 720)
		if err != nil || !reflect.DeepEqual(args, tc.want) {
			t.Fatalf("%s: %v %v", tc.id, args, err)
		}
	}
}

func TestWorkflowMediaOperationsRejectInvalidConfig(t *testing.T) {
	for _, config := range []map[string]any{{"x": 0.8, "width": 0.5, "height": 1.0}, {"width": 0.0, "height": 1.0}, {"width": 1.0, "height": 1.0, "filter": "arbitrary"}} {
		if err := ValidateOperation(Node{ID: "crop", Role: "operation", OperationID: "image.crop", OperationVersion: 1, MediaType: "image", Config: config}); err == nil {
			t.Fatal("invalid crop accepted")
		}
	}
	n := Node{ID: "crop", Role: "operation", OperationID: "video.crop", OperationVersion: 1, MediaType: "video", Config: map[string]any{"width": 1.0, "height": 1.0}}
	args, ext, mime, err := MediaCommand(n, 1279, 719)
	if err != nil || args[1] != "crop=1278:718:0:0" || ext != ".mp4" || mime != "video/mp4" {
		t.Fatalf("video crop: %v %s %s %v", args, ext, mime, err)
	}
}
