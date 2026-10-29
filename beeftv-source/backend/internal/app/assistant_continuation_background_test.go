package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

const backgroundContinuationSession = "durable:11111111-2222-3333-4444-555555555555"

func newBackgroundContinuation(t *testing.T, status model.TaskStatus) (*Service, *assistantturns.ContinuationView) {
	t.Helper()
	svc, canvasID, _ := newAssistantTurnService(t)
	t.Cleanup(func() { closeDB(t, svc.Database()) })
	// StartWorker runs concurrent maintenance writes; use the desktop pool
	// contract rather than the undo fixture's unbounded SQLite connections.
	if err := database.ConfigurePool(svc.Database()); err != nil {
		t.Fatal(err)
	}
	raw, err := svc.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	node := doc["nodes"].([]any)[0].(map[string]any)
	node["type"] = "image"
	node["metadata"] = map[string]any{"taskId": "background-task", "taskStatus": status, "status": "loading"}
	raw, _ = json.Marshal(doc)
	if _, err = svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	const source = "aabbccdd11223344"
	if _, err = svc.BeginAssistantTurn("local", canvasID, source, AssistantTurnInput{PermissionMode: assistantturns.PermissionCanvas}); err != nil {
		t.Fatal(err)
	}
	if err = svc.BindAssistantDurableSession("local", source, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err = svc.FinalizeAssistantTurn(source); err != nil {
		t.Fatal(err)
	}
	row, err := svc.ArmAssistantContinuation("local", assistantturns.ContinuationInput{
		CanvasID: canvasID, SessionID: backgroundContinuationSession, SourceTurnID: source,
		ProposalID: "gp-background", Kind: "image", NodeIDs: []string{"n1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	opID := "proposal:gp-background:n1"
	if err = svc.RegisterAssistantContinuationManifest("local", row.ID, assistantturns.ContinuationManifest{
		SourceNodeID: "n1", Submissions: []assistantturns.ContinuationSubmission{{OperationID: opID, OutputNodeIDs: []string{"n1"}}},
	}); err != nil {
		t.Fatal(err)
	}
	if err = svc.Database().Create(&model.Task{ID: "background-task", UserID: "local", ProjectID: canvasID,
		ClientOperationID: &opID, Type: "canvas_image", Status: status,
		InputJSON: `{"metadata":{"sourceNodeId":"n1","nodeId":"n1","outputNodeIds":["n1"]}}`,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return svc, row
}

func backgroundWorkersIdle(t *testing.T, svc *Service) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for svc.ActiveWorkerTasks() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("background continuation did not release its worker")
		}
		time.Sleep(time.Millisecond)
	}
}

func backgroundReceiptState(t *testing.T, svc *Service, id string) string {
	t.Helper()
	var row model.AssistantContinuation
	if err := svc.Database().First(&row, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	return row.State
}

func stopBackgroundWorkers(t *testing.T, svc *Service) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := svc.StopWorker(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestAssistantBackgroundContinuationWaitsForPersistedDeliveryAndReusesClaim(t *testing.T) {
	svc, row := newBackgroundContinuation(t, model.TaskStatusSucceeded)
	ctx, _ := svc.backgroundWorkers().Start()
	t.Cleanup(func() { stopBackgroundWorkers(t, svc) })
	calls := make(chan assistantturns.ContinuationView, 4)
	svc.SetAssistantContinuationSubmitter(func(_ context.Context, claimed assistantturns.ContinuationView) error {
		calls <- claimed
		return io.ErrUnexpectedEOF
	})
	svc.recoverAssistantContinuations(ctx)
	backgroundWorkersIdle(t, svc)
	if len(calls) != 0 || backgroundReceiptState(t, svc, row.ID) != "waiting" {
		t.Fatal("task success without saved canonical output started a model turn")
	}
	if err := svc.Database().Create(&model.Resource{ID: "background-resource", UserID: "local", Status: model.ResourceStatusReady}).Error; err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(localtask.CanonicalOutput{OutputIndex: 0, MediaType: "image", ResourceID: "background-resource", TargetBinding: &localtask.TargetBinding{NodeID: "n1"}})
	if err := svc.Database().Create(&model.Result{ID: "background-result", UserID: "local", TaskID: "background-task", Kind: localtask.ResultKindGenerationOutput, Payload: string(payload)}).Error; err != nil {
		t.Fatal(err)
	}
	asset := json.RawMessage(`{"id":"background-asset","kind":"image","title":"生成结果","coverUrl":"","source":"生成任务","tags":[],"status":"confirmed","data":{"dataUrl":"","url":"","storageKey":"resource:background-resource","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`)
	if _, err := svc.UpsertUserAsset("local", asset); err != nil {
		t.Fatal(err)
	}
	// Even a ready resource must be saved on the actual result node first.
	svc.recoverAssistantContinuations(ctx)
	backgroundWorkersIdle(t, svc)
	if len(calls) != 0 {
		t.Fatal("unbound saved resource started a continuation")
	}
	raw, err := svc.UserCanvasProject("local", row.CanvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	meta := doc["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)
	meta["status"], meta["storageKey"], meta["assetId"] = "success", "resource:background-resource", "background-asset"
	raw, _ = json.Marshal(doc)
	if _, err = svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		svc.recoverAssistantContinuations(ctx)
		backgroundWorkersIdle(t, svc)
	}
	if len(calls) != 2 {
		t.Fatalf("stable retry calls: %d", len(calls))
	}
	first, second := <-calls, <-calls
	if first.RequestID != row.RequestID || first.TurnID != row.TurnID || second.RequestID != first.RequestID || second.TurnID != first.TurnID || second.SessionID != row.SessionID || second.PermissionMode != row.PermissionMode {
		t.Fatalf("retry changed original authority: %+v %+v", first, second)
	}
	var count int64
	if err = svc.Database().Model(&model.AssistantTurn{}).Count(&count).Error; err != nil || count != 2 {
		t.Fatalf("duplicate Go turn: %d %v", count, err)
	}
	if err = svc.FinalizeAssistantTurn(first.TurnID); err != nil {
		t.Fatal(err)
	}
	svc.recoverAssistantContinuations(ctx)
	backgroundWorkersIdle(t, svc)
	if len(calls) != 0 || backgroundReceiptState(t, svc, row.ID) != "done" {
		t.Fatal("completed continuation was resubmitted")
	}
}

func TestAssistantBackgroundContinuationDoesNotResurrectStopOrNewIntent(t *testing.T) {
	for _, pendingOnly := range []bool{false, true} {
		t.Run(map[bool]string{false: "stop", true: "new-user-message"}[pendingOnly], func(t *testing.T) {
			svc, row := newBackgroundContinuation(t, model.TaskStatusFailed)
			// Claim may already have reached Go before Stop or a new message.
			if _, err := svc.ClaimAssistantContinuation("local", row.ID); err != nil {
				t.Fatal(err)
			}
			if err := svc.CancelAssistantContinuations("local", row.CanvasID, row.SessionID, pendingOnly); err != nil {
				t.Fatal(err)
			}
			// A new app service must see the persistent cancellation too.
			reopened := NewLocal(svc.repo, svc.dataDir)
			ctx, _ := reopened.backgroundWorkers().Start()
			t.Cleanup(func() { stopBackgroundWorkers(t, reopened) })
			var calls atomic.Int32
			reopened.SetAssistantContinuationSubmitter(func(context.Context, assistantturns.ContinuationView) error { calls.Add(1); return nil })
			for range 2 {
				reopened.recoverAssistantContinuations(ctx)
				backgroundWorkersIdle(t, reopened)
			}
			if calls.Load() != 0 || backgroundReceiptState(t, reopened, row.ID) != "cancelled" {
				t.Fatal("background scan revived cancelled intent")
			}
		})
	}
}

func TestAssistantBackgroundContinuationUsesRuntimeWorkerAndStopsOnExit(t *testing.T) {
	svc, row := newBackgroundContinuation(t, model.TaskStatusFailed)
	started, cancelled := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	svc.SetAssistantContinuationSubmitter(func(ctx context.Context, _ assistantturns.ContinuationView) error {
		calls.Add(1)
		close(started)
		<-ctx.Done()
		close(cancelled)
		return ctx.Err()
	})
	svc.StartWorker()
	t.Cleanup(func() { stopBackgroundWorkers(t, svc) })
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("application recovery loop did not dispatch the ready continuation")
	}
	for range 3 {
		svc.recoverAssistantContinuations(svc.backgroundWorkers().Context())
	}
	if calls.Load() != 1 {
		t.Fatal("duplicate notifications dispatched multiple observers")
	}
	stopBackgroundWorkers(t, svc)
	select {
	case <-cancelled:
	default:
		t.Fatal("runtime exit left the continuation observer alive")
	}
	if svc.ActiveWorkerTasks() != 0 || backgroundReceiptState(t, svc, row.ID) != "claimed" {
		t.Fatal("exit must release workers and preserve the admitted receipt for recovery")
	}
}

func TestAssistantBackgroundContinuationAdvancesPastFullObserverBatch(t *testing.T) {
	svc, ready := newBackgroundContinuation(t, model.TaskStatusFailed)
	ctx, _ := svc.backgroundWorkers().Start()
	t.Cleanup(func() { stopBackgroundWorkers(t, svc) })
	// These older admitted receipts repeatedly lose their observer. They must
	// not occupy every scan and starve the ready fifth receipt on the same page.
	for index := range 4 {
		row := ready.AssistantContinuation
		row.ID = fmt.Sprintf("%048d", index)
		row.TurnID, row.RequestID, row.State = row.ID, "generation_"+row.ID, "claimed"
		if row.ID >= ready.ID {
			t.Fatal("fixture requires older receipts before the ready receipt")
		}
		if err := svc.Database().Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	calls := make(chan string, 12)
	var release chan struct{}
	svc.SetAssistantContinuationSubmitter(func(_ context.Context, row assistantturns.ContinuationView) error {
		calls <- row.ID
		<-release
		return io.ErrUnexpectedEOF
	})
	for range 2 {
		release = make(chan struct{})
		svc.recoverAssistantContinuations(ctx)
		close(release)
		backgroundWorkersIdle(t, svc)
	}
	close(calls)
	for id := range calls {
		if id == ready.ID {
			return
		}
	}
	t.Fatal("ready continuation was starved by older interrupted observers")
}
