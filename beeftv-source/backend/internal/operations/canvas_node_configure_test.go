package operations

import (
	"encoding/json"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/canvas/capability"
)

type configureProbe struct {
	proposeProbe
	writes int
}

func (p *configureProbe) UpdateUserCanvasNodeFields(_ string, _ string, nodeID string, patch map[string]any, expected int64) (canvas.UserDataSummary, error) {
	var doc map[string]any
	json.Unmarshal(p.doc, &doc)
	node := findDocNode(doc, nodeID)
	descriptor, _ := capability.BuiltinRegistry().Resolve(node["type"].(string))
	if err := descriptor.ApplyPatch(node, patch); err != nil {
		return canvas.UserDataSummary{}, err
	}
	doc["revision"] = expected + 1
	p.doc, _ = json.Marshal(doc)
	p.writes++
	return canvas.UserDataSummary{Revision: expected + 1}, nil
}
func configureFixture(t *testing.T, kind string) *configureProbe {
	p := &configureProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{{"id": "n", "type": kind, "title": "keep",
		"metadata": map[string]any{"prompt": "submitted", "composerContent": "draft", "taskId": "existing", "status": "success", "custom": "keep"}}})}}
	return p
}
func TestConfigurePreservesExistingMediaAndValidatesModelSelection(t *testing.T) {
	for kind, patch := range map[string]map[string]any{
		"image": {"model": "chosen", "size": "16:9", "quality": "high", "count": 2, "transparentBackground": "false"},
		"video": {"model": "chosen", "size": "16:9", "seconds": "10", "vquality": "720p", "generateAudio": "true", "watermark": "false"},
		"audio": {"model": "chosen", "audioVoice": "narrator", "audioFormat": "wav", "audioSpeed": "1.25", "audioPitch": "-2", "audioVolume": "0", "audioInstructions": "warm"},
	} {
		t.Run(kind, func(t *testing.T) {
			p := configureFixture(t, kind)
			p.resolve = func(gotKind, selected string) (AssistantGenerationModel, error) {
				if gotKind != kind || selected != "chosen" {
					t.Fatal("wrong model lookup")
				}
				return AssistantGenerationModel{Display: "available", ModelKey: "channel::chosen"}, nil
			}
			raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": kind, "expectedRevision": 4, "patch": patch})
			result, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw)
			if err != nil {
				t.Fatal(err)
			}
			metadata := result.(map[string]any)["node"].(map[string]any)["metadata"].(map[string]any)
			for key, value := range map[string]any{"prompt": "submitted", "composerContent": "draft", "taskId": "existing", "status": "success", "custom": "keep"} {
				if metadata[key] != value {
					t.Fatalf("overwrote %s", key)
				}
			}
			if metadata["model"] != "channel::chosen" || p.writes != 1 {
				t.Fatal("model not canonical")
			}
		})
	}
}
func TestConfigureRejectsForeignKindUnknownFieldsAndMalformedValues(t *testing.T) {
	for _, target := range []struct{ nodeID, kind string }{{"n", "audio"}, {"missing", "video"}} {
		p := configureFixture(t, "video")
		raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": target.nodeID, "kind": target.kind, "expectedRevision": 4, "patch": map[string]any{"model": "chosen"}})
		if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw); err == nil || p.writes != 0 {
			t.Fatal("missing or mismatched target accepted")
		}
	}
	for _, patch := range []map[string]any{{"taskId": "new"}, {"content": "overwrite"}, {"audioSpeed": "1"}, {"seconds": "NaN"}, {"seconds": "0"}, {"generateAudio": true}, {"watermark": "yes"}, {"model": nil}, {"quality": "wrongkind"}, {"count": 9}} {
		p := configureFixture(t, "video")
		before := append(json.RawMessage{}, p.doc...)
		raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "video", "expectedRevision": 4, "patch": patch})
		if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw); err == nil {
			t.Fatalf("accepted %+v", patch)
		}
		if p.writes != 0 || !reflect.DeepEqual(before, p.doc) {
			t.Fatal("invalid patch changed canvas")
		}
	}
	for _, choice := range []AssistantGenerationModel{{KindMismatch: true}, {}} {
		p := configureFixture(t, "image")
		p.resolve = func(string, string) (AssistantGenerationModel, error) { return choice, nil }
		if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, json.RawMessage(`{"canvasId":"c1","nodeId":"n","kind":"image","expectedRevision":4,"patch":{"model":"unavailable"}}`)); err == nil || p.writes != 0 {
			t.Fatal("unavailable or wrong-kind model accepted")
		}
	}
}
