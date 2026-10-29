package taskbinding

import (
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

type fakePorts struct {
	task      *model.Task
	taskErr   error
	outputs   []localtask.CanonicalOutput
	outputErr error
	resource  *model.Resource
	resErr    error
	asset     *model.Asset
	assetErr  error
	bind      func(NodePatch) (NodeBindResult, error)
	binds     int
	lastPatch NodePatch
}

func (f *fakePorts) Task(string, string) (*model.Task, error) { return f.task, f.taskErr }
func (f *fakePorts) GenerationOutputs(string) ([]localtask.CanonicalOutput, error) {
	return f.outputs, f.outputErr
}
func (f *fakePorts) OwnedReadyResource(string, string) (*model.Resource, error) {
	return f.resource, f.resErr
}
func (f *fakePorts) OwnedAsset(string, string) (*model.Asset, error) { return f.asset, f.assetErr }
func (f *fakePorts) BindExistingNode(_ string, patch NodePatch) (NodeBindResult, error) {
	f.binds++
	f.lastPatch = patch
	if f.bind != nil {
		return f.bind(patch)
	}
	return NodeBindResult{Revision: 4, Node: map[string]any{"id": patch.NodeID, "title": "手工标题"}}, nil
}

func testImageTask() *model.Task {
	return &model.Task{
		ID: "task-1", UserID: "user-1", ProjectID: "canvas-1", Type: "canvas_image",
		Status:    model.TaskStatusSucceeded,
		InputJSON: `{"metadata":{"source":"canvas","nodeId":"node-1"}}`,
	}
}

func testAsset(id, userID, resourceID string) *model.Asset {
	return &model.Asset{
		ID: id, UserID: userID,
		PayloadJSON: `{"id":"` + id + `","data":{"storageKey":"resource:` + resourceID + `"}}`,
	}
}

func TestBindMediaUsesDurableOutputNotClientURL(t *testing.T) {
	ports := &fakePorts{
		task: testImageTask(),
		outputs: []localtask.CanonicalOutput{{
			OutputIndex: 0, MediaType: "image", MaterializedAssetID: "generation_abc", ResourceID: "res-1",
		}},
		resource: &model.Resource{ID: "res-1", UserID: "user-1", Status: model.ResourceStatusReady, Kind: "image", MimeType: "image/png", Size: 12, Width: 8, Height: 8},
		asset:    testAsset("generation_abc", "user-1", "res-1"),
	}
	receipt, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"})
	if err != nil {
		t.Fatal(err)
	}
	if !receipt.Applied || receipt.AssetID != "generation_abc" || receipt.ResourceID != "res-1" || receipt.StorageKey != "resource:res-1" {
		t.Fatalf("receipt = %#v", receipt)
	}
	if ports.lastPatch.Content != "/api/resources/res-1/file" {
		t.Fatalf("content = %q", ports.lastPatch.Content)
	}
	if ports.lastPatch.EffectKey != localtask.AttachNodeEffectKey("task-1", "node-1", 0) {
		t.Fatalf("effect = %q", ports.lastPatch.EffectKey)
	}
}

func TestBindTextUsesDurableResultJSON(t *testing.T) {
	ports := &fakePorts{
		task: &model.Task{
			ID: "task-text", UserID: "user-1", ProjectID: "canvas-1", Type: "canvas_text",
			Status:     model.TaskStatusSucceeded,
			InputJSON:  `{"metadata":{"nodeId":"node-text"}}`,
			ResultJSON: `{"text":"成片旁白","rows":[{"shotNumber":1,"action":"开门"}]}`,
		},
	}
	receipt, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-text", NodeID: "node-text"})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Content != "成片旁白" || ports.lastPatch.Storyboard == nil {
		t.Fatalf("text receipt = %#v patch=%#v", receipt, ports.lastPatch)
	}
	if ports.binds != 1 {
		t.Fatalf("text bind must go through the same receipt write, got %d", ports.binds)
	}
}

func TestBindRejectsUnreadableAndNotReadyOutputs(t *testing.T) {
	unreadable := &fakePorts{
		task:      testImageTask(),
		outputErr: precondition("delivery_unreadable", "任务产物无法读取"),
	}
	if _, err := Bind(unreadable, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "delivery_unreadable") {
		t.Fatalf("unreadable = %v", err)
	}
	missing := &fakePorts{task: testImageTask()}
	if _, err := Bind(missing, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "output_not_ready") {
		t.Fatalf("missing output = %v", err)
	}
	pending := &fakePorts{
		task:     testImageTask(),
		outputs:  []localtask.CanonicalOutput{{OutputIndex: 0, MaterializedAssetID: "generation_abc", ResourceID: "res-1"}},
		resource: &model.Resource{ID: "res-1", Status: model.ResourceStatusPending},
	}
	if _, err := Bind(pending, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "resource_not_ready") {
		t.Fatalf("pending resource = %v", err)
	}
}

func TestBindRejectsForeignAssetAndWrongNode(t *testing.T) {
	foreign := &fakePorts{
		task:     testImageTask(),
		outputs:  []localtask.CanonicalOutput{{OutputIndex: 0, MaterializedAssetID: "generation_abc", ResourceID: "res-1"}},
		resource: &model.Resource{ID: "res-1", UserID: "user-1", Status: model.ResourceStatusReady},
		asset:    testAsset("generation_abc", "other", "res-1"),
	}
	if _, err := Bind(foreign, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "asset_foreign") {
		t.Fatalf("foreign asset = %v", err)
	}
	mismatch := &fakePorts{task: testImageTask()}
	if _, err := Bind(mismatch, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "other-node"}); !isBindReason(err, "node_mismatch") {
		t.Fatalf("wrong node = %v", err)
	}
}

func TestBindRetriesRevisionConflictThenStops(t *testing.T) {
	ports := &fakePorts{
		task: testImageTask(),
		outputs: []localtask.CanonicalOutput{{
			OutputIndex: 0, MaterializedAssetID: "generation_abc", ResourceID: "res-1",
		}},
		resource: &model.Resource{ID: "res-1", UserID: "user-1", Status: model.ResourceStatusReady},
		asset:    testAsset("generation_abc", "user-1", "res-1"),
	}
	ports.bind = func(NodePatch) (NodeBindResult, error) {
		return NodeBindResult{}, conflict("stale_revision", "云端画布已有更新")
	}
	if _, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "stale_revision") {
		t.Fatalf("stale = %v", err)
	}
	if ports.binds != maxBindRevisionAttempts {
		t.Fatalf("retries = %d", ports.binds)
	}
}

func TestBindTextRejectsNonZeroOutputIndex(t *testing.T) {
	ports := &fakePorts{
		task: &model.Task{
			ID: "task-text", UserID: "user-1", ProjectID: "canvas-1", Type: "canvas_text",
			Status:     model.TaskStatusSucceeded,
			InputJSON:  `{"metadata":{"nodeId":"node-text"}}`,
			ResultJSON: `{"text":"成片旁白"}`,
		},
	}
	if _, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-text", NodeID: "node-text", OutputIndex: 1}); !isBindReason(err, "invalid_params") {
		t.Fatalf("text index 1 = %v", err)
	}
	if ports.binds != 0 {
		t.Fatalf("text index 1 still bound, binds=%d", ports.binds)
	}
}

func TestBindRejectsPortReturnedForeignResourceAndMismatchedAsset(t *testing.T) {
	foreignResource := &fakePorts{
		task:     testImageTask(),
		outputs:  []localtask.CanonicalOutput{{OutputIndex: 0, MaterializedAssetID: "generation_abc", ResourceID: "res-1"}},
		resource: &model.Resource{ID: "res-1", UserID: "other", Status: model.ResourceStatusReady},
		asset:    testAsset("generation_abc", "user-1", "res-1"),
	}
	if _, err := Bind(foreignResource, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "resource_foreign") {
		t.Fatalf("foreign resource = %v", err)
	}
	mismatched := &fakePorts{
		task:     testImageTask(),
		outputs:  []localtask.CanonicalOutput{{OutputIndex: 0, MaterializedAssetID: "generation_abc", ResourceID: "res-1"}},
		resource: &model.Resource{ID: "res-1", UserID: "user-1", Status: model.ResourceStatusReady},
		asset:    testAsset("generation_abc", "user-1", "res-other"),
	}
	if _, err := Bind(mismatched, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "resource_mismatch") {
		t.Fatalf("mismatched asset resource = %v", err)
	}
}

func isBindReason(err error, reason string) bool {
	var bindErr *Error
	return errors.As(err, &bindErr) && bindErr.Reason == reason && strings.TrimSpace(bindErr.Message) != ""
}

func TestBindImageOutputsRequireFrozenDestinationAtEachIndex(t *testing.T) {
	nodes := []string{"first", "second", "third", "fourth"}
	for index, nodeID := range nodes {
		task := testImageTask()
		task.InputJSON = `{"metadata":{"source":"canvas","nodeId":"first","outputNodeIds":["first","second","third","fourth"]}}`
		ports := &fakePorts{
			task:     task,
			outputs:  []localtask.CanonicalOutput{{OutputIndex: index, MediaType: "image", MaterializedAssetID: "asset", ResourceID: "resource"}},
			resource: &model.Resource{ID: "resource", UserID: "user-1", Status: model.ResourceStatusReady, Kind: "image"},
			asset:    testAsset("asset", "user-1", "resource"),
		}
		if _, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: nodes[(index+1)%4], OutputIndex: index}); !isBindReason(err, "node_mismatch") {
			t.Fatalf("wrong destination for output %d accepted: %v", index, err)
		}
		receipt, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: nodeID, OutputIndex: index})
		if err != nil || receipt.NodeID != nodeID || receipt.OutputIndex != index || ports.binds != 1 {
			t.Fatalf("output %d destination %q: receipt=%#v err=%v", index, nodeID, receipt, err)
		}
		if _, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: nodeID, OutputIndex: 4}); !isBindReason(err, "node_mismatch") {
			t.Fatalf("undeclared output destination accepted: %v", err)
		}
	}
}
