package app

import (
	"encoding/json"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/operations"
	"reflect"
	"testing"
)

func TestProductionFreezesAndForwardsVideoOperationMetadata(t *testing.T) {
	svc, _, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"videoModel":"custom::video","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["video"],"modelProfiles":[{"model":"video","capability":"video","protocol":"video-generations-json"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	metadata := map[string]any{"prompt": "keep ordered references", "videoEditOperation": "reference_to_video", "videoOperation": "reference_to_video", "videoMiddleFrameTime": 2.5, "videoReferenceOrder": []any{"voice", "subject"}, "videoH3Options": map[string]any{"seed": float64(0), "sync_mode": true}, "providerOptions": map[string]any{"seed": float64(0)}}
	node := map[string]any{"id": "video", "type": "video", "metadata": metadata}
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), map[string]any{"nodes": []any{node}}, []string{"video"})
	if err != nil {
		t.Fatal(err)
	}
	// Exercise the same JSON boundary used by UI confirmation and persisted grants.
	encoded, _ := json.Marshal(targets)
	var confirmed []operations.GenerationTarget
	if err = json.Unmarshal(encoded, &confirmed); err != nil {
		t.Fatal(err)
	}
	input, err := svc.BindDomain(nil).(*operationSession).productionTaskInput("local", confirmed[0], map[string]map[string]any{"video": node})
	if err != nil {
		t.Fatal(err)
	}
	actual := input["metadata"].(map[string]any)
	for _, key := range []string{"videoEditOperation", "videoOperation", "videoMiddleFrameTime", "videoReferenceOrder", "videoH3Options", "providerOptions"} {
		if !reflect.DeepEqual(actual[key], metadata[key]) {
			t.Fatalf("%s was lost or changed: %#v", key, actual[key])
		}
	}
	encoded, _ = json.Marshal(input)
	var parsed generation.Input
	if err = json.Unmarshal(encoded, &parsed); err != nil {
		t.Fatal(err)
	}
	if request := generation.ProtocolRequestFromInput(parsed); request.Operation != "reference_to_video" {
		t.Fatalf("provider operation changed: %q", request.Operation)
	}
	metadata["videoEditOperation"] = "image_to_video"
	changed, err := operations.GenerationTargets(svc.BindDomain(nil), map[string]any{"nodes": []any{node}}, []string{"video"})
	if err != nil || reflect.DeepEqual(changed, confirmed) {
		t.Fatal("changed paid operation still matches approved plan", err)
	}
}
