package task

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestMaterializedAssetIDMatchesFrontendGenerationIdentity(t *testing.T) {
	taskID := "task-consumer-effect-keys"
	sum := sha256.Sum256([]byte("materialize:task-consumer-effect-keys:0"))
	want := "generation_" + hex.EncodeToString(sum[:])
	if got := MaterializedAssetID(taskID, 0); got != want {
		t.Fatalf("MaterializedAssetID = %q, want %q", got, want)
	}
	if len(want) > 80 {
		t.Fatalf("asset id length %d exceeds varchar(80)", len(want))
	}
	if key := MaterializeEffectKey(taskID, 0); key != "materialize:task-consumer-effect-keys:0" {
		t.Fatalf("effect key = %q", key)
	}
	if key := AttachNodeEffectKey(taskID, "node-safe-id", 0); key != "attach-node:task-consumer-effect-keys:node-safe-id:0" {
		t.Fatalf("node effect key = %q", key)
	}
}

func TestOutputVersionIDMatchesWorkflowSlotZero(t *testing.T) {
	taskID := "ac745990450a86d3365eb92ec26f378e"
	if got, want := OutputVersionID(taskID, 0), StableEntityID("version", taskID); got != want {
		t.Fatalf("slot 0 version = %q, want %q", got, want)
	}
	if OutputVersionID(taskID, 1) == OutputVersionID(taskID, 0) {
		t.Fatal("multiple outputs must not share a version identity")
	}
	if role := OutputRole(0); role != "output" {
		t.Fatalf("slot 0 role = %q", role)
	}
}

func TestDepthCanonicalOutputRequiresDepthTaskType(t *testing.T) {
	raw := `{"resourceId":"depth-result","width":1920,"height":1080}`
	outputs := CanonicalOutputs(raw, model.TaskTypeDepthCapture)
	if len(outputs) != 1 || outputs[0].MediaType != "video" || outputs[0].ResourceID != "depth-result" {
		t.Fatalf("depth outputs: %#v", outputs)
	}
	if len(CanonicalOutputs(raw, "canvas_image")) != 0 || DeliveryComplete(raw, nil, model.TaskTypeDepthCapture) {
		t.Fatal("untyped resource accepted or undelivered depth considered complete")
	}
}

func TestCanonicalOutputsPreferImagesThenVideoThenAudio(t *testing.T) {
	images := CanonicalOutputs(`{"images":[{"resourceId":"img-1","storageKey":"resource:img-1"},{"url":"/api/resources/img-2/file"}],"video":{"resourceId":"vid-1"}}`, "")
	if len(images) != 2 || images[0].ResourceID != "img-1" || images[1].ResourceID != "img-2" || images[1].OutputIndex != 1 {
		t.Fatalf("images = %#v", images)
	}
	video := CanonicalOutputs(`{"mode":"video","video":{"storageKey":"resource:video-1","url":"/api/resources/video-1/file"}}`, "")
	if len(video) != 1 || video[0].MediaType != "video" || video[0].ResourceID != "video-1" {
		t.Fatalf("video = %#v", video)
	}
	audio := CanonicalOutputs(`{"audio":{"dataUrl":"/api/resources/audio-1/file"}}`, "")
	if len(audio) != 1 || audio[0].MediaType != "audio" || audio[0].ResourceID != "audio-1" {
		t.Fatalf("audio = %#v", audio)
	}
	if outs := CanonicalOutputs(`{"text":"hello"}`, ""); len(outs) != 0 {
		t.Fatalf("text outputs = %#v", outs)
	}
}

func TestTargetBindingFromInputPreservesCanvasAndMessageSlots(t *testing.T) {
	binding := TargetBindingFromInput(`{"metadata":{"source":"canvas","nodeId":"node-1","conversationId":"c1","messageId":"m1","clientOperationId":"proposal:gp-1:node-1"}}`)
	if binding.NodeID != "node-1" || binding.MessageID != "m1" || binding.ConversationID != "c1" || binding.Source != "canvas" {
		t.Fatalf("binding = %#v", binding)
	}
	if !TargetBindingFromInput(`{"metadata":{"clientOperationId":"only-confirmation"}}`).Empty() {
		t.Fatal("confirmation identity is not a target binding")
	}
	if !HasWorkflowOutputIntent(`{"metadata":{"workflowStepId":"step-1"}}`) {
		t.Fatal("metadata workflow step is an output intent")
	}
	if HasWorkflowOutputIntent(`{"metadata":{"nodeId":"node-1","clientOperationId":"proposal:gp-1:node-1"}}`) {
		t.Fatal("canvas confirmation is not a workflow output intent")
	}
}

func TestResultStateAndDeliveryComplete(t *testing.T) {
	pending := []CanonicalOutput{{OutputIndex: 0, MediaType: "image", ResourceID: "r1"}}
	if state := ResultState(model.TaskStatusSucceeded, pending, false); state != ResultStatePendingMaterialization {
		t.Fatalf("pending state = %q", state)
	}
	ready := []CanonicalOutput{{OutputIndex: 0, MediaType: "image", ResourceID: "r1", MaterializedAssetID: "asset-1"}}
	if state := ResultState(model.TaskStatusSucceeded, ready, false); state != ResultStateReady {
		t.Fatalf("ready state = %q", state)
	}
	if state := ResultState(model.TaskStatusSucceeded, nil, false); state != ResultStateReady {
		t.Fatalf("text success state = %q", state)
	}
	if state := ResultState(model.TaskStatusFailed, nil, true); state != ResultStateFailedPermanent {
		t.Fatalf("blocked failure state = %q", state)
	}
	if DeliveryComplete(`{"images":[{"resourceId":"r1"}]}`, pending, "") {
		t.Fatal("pending delivery reported complete")
	}
	if !DeliveryComplete(`{"images":[{"resourceId":"r1"}]}`, ready, "") {
		t.Fatal("ready delivery reported incomplete")
	}
	if !DeliveryComplete(`{"text":"ok"}`, nil, "") {
		t.Fatal("text result should not require media delivery")
	}
	missing := []CanonicalOutput{{OutputIndex: 0, MediaType: "image", ResourceID: "r1", MaterializationErrorCode: MaterializeErrorResourceMissing}}
	if DeliveryComplete(`{"images":[{"resourceId":"r1"}]}`, missing, "") {
		t.Fatal("retryable resource gap reported complete")
	}
	foreign := []CanonicalOutput{{OutputIndex: 0, MediaType: "image", ResourceID: "r1", MaterializationErrorCode: MaterializeErrorResourceForeign}}
	if !DeliveryComplete(`{"images":[{"resourceId":"r1"}]}`, foreign, "") {
		t.Fatal("foreign resource should not keep rewriting")
	}
	failedPersist := []CanonicalOutput{{OutputIndex: 0, MediaType: "image", ResourceID: "r1", MaterializationErrorCode: MaterializeErrorPersistFailed}}
	if DeliveryComplete(`{"images":[{"resourceId":"r1"}]}`, failedPersist, "") {
		t.Fatal("transient persist_failed reported complete")
	}
	if DeliveryComplete(`{"images":[{"url":"https://upstream.example/a.png"}]}`, []CanonicalOutput{{OutputIndex: 0, MediaType: "image", ProviderArtifactRef: "https://upstream.example/a.png"}}, "") {
		t.Fatal("leftover remote URL still needs persistence")
	}
	unsupported := []CanonicalOutput{{OutputIndex: 0, MediaType: "image", ProviderArtifactRef: "blob:local", MaterializationErrorCode: MaterializeErrorUnsupportedShape}}
	if !DeliveryComplete(`{"images":[{"url":"blob:local"}]}`, unsupported, "") {
		t.Fatal("recorded unsupported shape should stop rewriting")
	}
	if OutputSettled(pending[0]) || !OutputSettled(ready[0]) || !OutputSettled(foreign[0]) || OutputSettled(failedPersist[0]) {
		t.Fatal("settled predicate drifted from delivery completion")
	}
}

func TestInspectResultJSONAndUnsupportedShapes(t *testing.T) {
	outputs, unusable := InspectResultJSON(`{"images":[{"resourceId":"r1"}]}`, "")
	if len(outputs) != 1 || unusable != "" || outputs[0].ResourceID != "r1" {
		t.Fatalf("usable images = %#v %q", outputs, unusable)
	}
	if _, unusable := InspectResultJSON(`{"images":[1]}`, ""); unusable != "unusable_images" {
		t.Fatalf("unusable images = %q", unusable)
	}
	if _, unusable := InspectResultJSON(`{`, ""); unusable != "invalid_result_json" {
		t.Fatalf("invalid json = %q", unusable)
	}
	if shape := UnsupportedResultShape(CanonicalOutput{ProviderArtifactRef: "blob:local"}); shape != "blob_url" {
		t.Fatalf("blob shape = %q", shape)
	}
	if shape := UnsupportedResultShape(CanonicalOutput{ProviderArtifactRef: "ftp://x"}); shape != "unrecognized_artifact" {
		t.Fatalf("unrecognized shape = %q", shape)
	}
	if !PersistableArtifactURL("https://upstream.example/a.png") || PersistableArtifactURL("blob:local") {
		t.Fatal("persistable URL classification drifted")
	}
}

func TestCanvasBindingIntentsStayIntentOnly(t *testing.T) {
	outputs := []CanonicalOutput{
		BindOutput(CanonicalOutput{OutputIndex: 0, MediaType: "image", ResourceID: "r1", MaterializedAssetID: "asset-1"}, "task-1", TargetBinding{NodeID: "node-1", MessageID: "m1"}),
		BindOutput(CanonicalOutput{OutputIndex: 1, MediaType: "image", ResourceID: "r2"}, "task-1", TargetBinding{}),
	}
	intents := CanvasBindingIntents("task-1", outputs)
	if len(intents) != 1 || intents[0].AssetID != "asset-1" || intents[0].AttachNodeEffectKey != AttachNodeEffectKey("task-1", "node-1", 0) {
		t.Fatalf("intents = %#v", intents)
	}
}
