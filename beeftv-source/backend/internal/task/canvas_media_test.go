package task

import (
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
	"testing"
)

func TestCanvasMediaAdmissionIsLocalOwnedAndIdempotent(t *testing.T) {
	svc, _, media, _ := newSpecializedMem(nil)
	source := readyVideo("source")
	source.Kind = "video"
	source.MimeType = "video/mp4"
	source.Width = 1280
	source.Height = 720
	media.put("owner", source)
	node := cw.Node{ID: "frame", Role: "operation", OperationID: "video.frame", OperationVersion: 1, MediaType: "image", Config: map[string]any{"seconds": 0.0}}
	first, err := svc.CreateCanvasMediaTask("owner", node, "source", "frame-once")
	if err != nil {
		t.Fatal(err)
	}
	if first.Provider != "local" || first.Type != model.TaskTypeCanvasMediaTransform || first.Model != "ffmpeg" {
		t.Fatalf("unexpected task: %+v", first)
	}
	second, err := svc.CreateCanvasMediaTask("owner", node, "source", "frame-once")
	if err != nil || second.ID != first.ID {
		t.Fatalf("idempotency: %v", err)
	}
	if _, err = svc.CreateCanvasMediaTask("foreign", node, "source", "foreign"); err == nil {
		t.Fatal("foreign resource accepted")
	}
	node.Config["seconds"] = 43200.0
	if _, err = svc.CreateCanvasMediaTask("owner", node, "source", "invalid"); err == nil {
		t.Fatal("out of range frame accepted")
	}
}

func TestCanvasMediaAdmissionNormalizesHistoricalMediaKind(t *testing.T) {
	svc, _, media, _ := newSpecializedMem(nil)
	source := readyVideo("historical")
	source.Kind, source.MimeType = "media", "video/mp4"
	source.Width, source.Height = 1280, 720
	media.put("owner", source)
	node := cw.Node{ID: "frame", Role: "operation", OperationID: "video.frame", OperationVersion: 1, MediaType: "image", Config: map[string]any{"seconds": 0.0}}
	if _, err := svc.CreateCanvasMediaTask("owner", node, source.ID, "historical-frame"); err != nil {
		t.Fatal(err)
	}
	source.MimeType = "audio/wav"
	media.put("owner", source)
	if _, err := svc.CreateCanvasMediaTask("owner", node, source.ID, "wrong-kind"); err == nil {
		t.Fatal("audio accepted as a video")
	}
}
