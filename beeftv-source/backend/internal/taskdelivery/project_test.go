package taskdelivery

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func TestProjectNeverReadyOnUnreadableRecords(t *testing.T) {
	task := model.Task{
		ID:         "task-1",
		Status:     model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"nodeId":"node-1"}}`,
		ResultJSON: `{"images":[{"resourceId":"r1"}]}`,
	}
	stored := []localtask.CanonicalOutput{{
		OutputIndex:         0,
		MediaType:           "image",
		ResourceID:          "r1",
		MaterializedAssetID: "generation_should_not_leak",
	}}
	proj := Project(task, stored, errors.New("decode failed"), false)
	if proj.Err == nil || proj.ResultState == localtask.ResultStateReady {
		t.Fatalf("unreadable projection = %#v", proj)
	}
	if proj.ResultState != localtask.ResultStateFailedRetryable {
		t.Fatalf("unreadable state = %q", proj.ResultState)
	}
	if len(proj.Outputs) != 1 || proj.Outputs[0].MaterializedAssetID != "" || proj.Outputs[0].MaterializationErrorCode != localtask.MaterializeErrorDeliveryUnreadable {
		t.Fatalf("unreadable outputs = %#v", proj.Outputs)
	}
	if proj.Outputs[0].TargetBinding == nil || proj.Outputs[0].TargetBinding.NodeID != "node-1" {
		t.Fatalf("binding dropped on unreadable projection: %#v", proj.Outputs[0])
	}
}

func TestProjectKeepsDeliveryStageUntilEveryOutputIsReady(t *testing.T) {
	for _, unreadable := range []bool{false, true} {
		task := model.Task{Status: model.TaskStatusSucceeded, Stage: "delivery_timed_out", Type: "canvas_image", ResultJSON: `{"images":[{"resourceId":"r1"},{"resourceId":"r2"}]}`}
		stored := []localtask.CanonicalOutput{{OutputIndex: 0, MediaType: "image", ResourceID: "r1", MaterializedAssetID: "asset-1"}}
		var loadErr error
		if unreadable {
			loadErr = errors.New("unreadable")
		}
		proj := Project(task, stored, loadErr, false)
		if proj.Stage != task.Stage || proj.ResultState == localtask.ResultStateReady {
			t.Fatalf("incomplete delivery reported complete: %+v", proj)
		}
	}
}

func TestDecodeStoredOutputsFailsOnCorruptPayload(t *testing.T) {
	_, err := DecodeStoredOutputs([]model.Result{{ID: "result-1", TaskID: "task-1", Kind: localtask.ResultKindGenerationOutput, Payload: "{"}})
	if err == nil {
		t.Fatal("corrupt payload decoded")
	}
	byTask, errs := DecodeStoredOutputsByTask([]model.Result{
		{ID: "result-1", TaskID: "task-bad", Kind: localtask.ResultKindGenerationOutput, Payload: "{"},
		{ID: "result-2", TaskID: "task-ok", Kind: localtask.ResultKindGenerationOutput, Payload: `{"outputIndex":0,"resourceId":"r1"}`},
	})
	if errs["task-bad"] == nil {
		t.Fatal("per-task decode error missing")
	}
	if len(byTask["task-ok"]) != 1 || byTask["task-ok"][0].ResourceID != "r1" {
		t.Fatalf("healthy task lost: %#v", byTask)
	}
}
