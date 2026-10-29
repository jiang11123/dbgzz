package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

func TestCanvasRenderAtomicAdmissionReplayAndNativeOutput(t *testing.T) {
	_, db := newTimelineTaskTestService(t)
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	svc := NewLocal(repository.New(db), t.TempDir())
	if err := db.Create(&model.Workspace{ID: "owner", Name: "test"}).Error; err != nil {
		t.Fatal(err)
	}
	bin, err := editing.ResolveFFmpegBinary()
	if err != nil {
		t.Fatalf("ffmpeg needed for actualrender: %v", err)
	}
	inputPath := filepath.Join(t.TempDir(), "source.mp4")
	if out, err := exec.Command(bin, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", inputPath).CombinedOutput(); err != nil {
		t.Fatalf("fixture %v %s", err, out)
	}
	file, err := os.Open(inputPath)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	stat, _ := file.Stat()
	resource, err := svc.UploadLocalResourceFile("owner", "source.mp4", stat.Size(), "video", 320, 240, 1000, file)
	if err != nil {
		t.Fatal(err)
	}
	assetPayload, _ := json.Marshal(map[string]any{"resourceId": resource.ID})
	if err := db.Create(&model.Asset{ID: "asset", UserID: "owner", Kind: "video", PayloadJSON: string(assetPayload)}).Error; err != nil {
		t.Fatal(err)
	}
	timeline := renderTestProject("resource:" + resource.ID)
	timeline.Clips[0].DirectMedia.AssetID = "asset"
	timeline.DurationMs = 1000
	timeline.Clips[0].DurationMs = 1000
	doc := map[string]any{"id": "canvas", "revision": 0, "title": "render", "nodes": []any{map[string]any{"id": "clip-v1", "type": "video", "metadata": map[string]any{"storageKey": "resource:" + resource.ID, "assetId": "asset"}}}, "connections": []any{}, "timeline": timeline}
	raw, _ := json.Marshal(doc)
	summary, err := svc.UpsertUserCanvasProject("owner", raw)
	if err != nil {
		t.Fatal(err)
	}
	registry := operations.NewRegistry(svc, operations.NewStore(db))
	operations.RegisterDefaultOps(registry)
	turnID := "1234abcd5678abcd"
	if _, err := svc.BeginAssistantTurn("owner", "canvas", turnID, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	trustedScope := &agentops.AssistantScope{CanvasID: "canvas"}
	nodeOnly := timeline
	nodeOnly.Clips = append([]editing.Clip{}, timeline.Clips...)
	nodeOnly.Clips[0].DirectMedia = nil
	editPayload, _ := json.Marshal(map[string]any{"canvasId": "canvas", "expectedRevision": summary.Revision, "timeline": nodeOnly})
	edited, err := registry.Execute(operations.Request{UserID: "owner", Caller: operations.AssistantCaller(trustedScope, false), TurnID: turnID, Op: "canvas.timeline.update", OpID: "edit-before-render", Params: editPayload})
	if err != nil {
		t.Fatalf("real SQLite timeline save failed: %v", err)
	}
	summary.Revision = edited.Revision
	saved, err := svc.UserCanvasProject("owner", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	var savedDoc struct {
		Timeline editing.Project `json:"timeline"`
	}
	if err := json.Unmarshal(saved, &savedDoc); err != nil {
		t.Fatal(err)
	}
	if savedDoc.Timeline.Clips[0].DirectMedia.AssetID != "asset" {
		t.Fatal("ownedasset field lost in save")
	}
	payload, _ := json.Marshal(map[string]any{"canvasId": "canvas", "expectedRevision": summary.Revision, "options": editing.Options{Width: 320, Height: 240, FPS: 24}})
	request := operations.Request{Context: context.Background(), UserID: "owner", Caller: operations.AssistantCaller(trustedScope, false), TurnID: turnID, Op: "canvas.timeline.render", OpID: "render-stable", Params: payload}
	first, err := registry.Execute(request)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := registry.Execute(request)
	if err != nil {
		t.Fatal(err)
	}
	taskID := first.Result.(map[string]any)["taskId"].(string)
	scope, ok, err := svc.AssistantTurnScopeForHost("owner", turnID)
	if err != nil || !ok || len(scope.TaskIDs) != 1 || scope.TaskIDs[0] != taskID {
		t.Fatalf("render receipt not in trusted taskscope: %+v %v", scope, err)
	}
	trustedScope.TaskIDs = map[string]bool{taskID: true}
	query, _ := json.Marshal(map[string]any{"taskId": taskID})
	if _, err := registry.Execute(operations.Request{UserID: "owner", Caller: operations.AssistantCaller(trustedScope, false), Op: "task.get", Params: query}); err != nil {
		t.Fatalf("can't query renderedtask: %v", err)
	}
	foreignQuery, _ := json.Marshal(map[string]any{"taskId": "unreferenced-task"})
	if _, err := registry.Execute(operations.Request{UserID: "owner", Caller: operations.AssistantCaller(trustedScope, false), Op: "task.get", Params: foreignQuery}); err == nil {
		t.Fatal("unreferenced taskscope widened")
	}
	if !replay.Replayed || replay.Result.(map[string]any)["taskId"] != taskID {
		t.Fatal("duplicate render")
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatalf("tasks %d", count)
	}
	// Receipt failure rolls task admission back on the same single connection.
	injected := errors.New("receipt write failed")
	if err := db.Callback().Update().Before("gorm:update").Register("test_render_receipt_failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "agent_op_records" {
			tx.AddError(injected)
		}
	}); err != nil {
		t.Fatal(err)
	}
	broken := request
	broken.OpID = "render-rollback"
	if _, err := registry.Execute(broken); err == nil {
		t.Fatal("receipt failure accepted")
	}
	db.Callback().Update().Remove("test_render_receipt_failure")
	db.Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatal("orphan task survived rollback")
	}
	createPayload, _ := json.Marshal(map[string]any{"canvasId": "canvas", "expectedRevision": summary.Revision, "nodes": []any{map[string]any{"title": "成片预览", "type": "video"}}})
	created, err := registry.Execute(operations.Request{UserID: "owner", Caller: operations.AssistantCaller(trustedScope, false), TurnID: turnID, Op: "canvas.nodes.create", OpID: "preview-node", Params: createPayload})
	if err != nil {
		t.Fatal(err)
	}
	previewID := created.Result.(map[string]any)["created"].([]any)[0].(map[string]any)["id"].(string)
	stale := request
	stale.OpID = "render-stale"
	if _, err := registry.Execute(stale); err == nil {
		t.Fatal("stale render accepted")
	}
	var task model.Task
	if err := db.First(&task, "id = ?", taskID).Error; err != nil {
		t.Fatal(err)
	}
	task.Status = model.TaskStatusRunning
	if err := db.Model(&model.Task{}).Where("id = ?", taskID).Update("status", task.Status).Error; err != nil {
		t.Fatal(err)
	}
	worker := newTaskWorkerCoordinator(svc)
	if err := worker.processTimelineRender(&task, context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&task, "id = ?", taskID).Error; err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusSucceeded {
		t.Fatalf("render failed %+v", task)
	}
	queried, err := registry.Execute(operations.Request{UserID: "owner", Caller: operations.AssistantCaller(trustedScope, false), Op: "task.get", Params: query})
	if err != nil {
		t.Fatal(err)
	}
	queryOutputs, _ := json.Marshal(queried.Result.(map[string]any)["outputs"])
	var delivered []model.TaskOutput
	if err := json.Unmarshal(queryOutputs, &delivered); err != nil {
		t.Fatal(err)
	}
	if len(delivered) != 1 || delivered[0].ResourceID == "" || delivered[0].MaterializedAssetID == "" {
		t.Fatalf("render not delivered: %s", queryOutputs)
	}
	// Reconstruct the host's current scope from the real turn and project
	// membership for each read, rather than granting the rendered asset in a fixture.
	readMedia := func(t *testing.T, params map[string]any) (operations.Result, error) {
		t.Helper()
		current, open, scopeErr := svc.AssistantTurnScopeForHost("owner", turnID)
		if scopeErr != nil || !open {
			t.Fatalf("render turn no longer open: %v", scopeErr)
		}
		mediaScope := &agentops.AssistantScope{CanvasID: current.CanvasID, PermissionMode: current.PermissionMode, AssetIDs: map[string]bool{},
			ProjectReference: func(kind, id string) error {
				return svc.ValidateAgentProjectReference("owner", current.CanvasID, kind, id)
			}}
		for _, id := range current.AssetIDs {
			mediaScope.AssetIDs[id] = true
		}
		encoded, marshalErr := json.Marshal(params)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		return registry.Execute(operations.Request{Context: context.Background(), UserID: "owner", Caller: operations.AssistantCaller(mediaScope, false), TurnID: turnID, Op: "media.overview", Params: encoded})
	}
	for _, tc := range []struct {
		name   string
		params map[string]any
	}{
		{"unbound rendered asset cannot grant media access", map[string]any{"canvasId": "canvas", "assetId": delivered[0].MaterializedAssetID}},
		{"bare rendered resource cannot grant media access", map[string]any{"canvasId": "canvas", "resourceId": delivered[0].ResourceID}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := readMedia(t, tc.params)
			if err == nil || operations.AsError(err).Reason != "scope_denied" {
				t.Fatalf("unbound output must remain scope_denied: %v", err)
			}
		})
	}
	// The adapter ignores caller-provided internal flags and only permits a
	// succeeded local render owned by this user and this canvas.
	session := &operationSession{canvas: svc.canvasDomain(), service: svc, repo: svc.repo}
	for _, tc := range []struct{ name, field, value string }{
		{"foreign canvas", "project_id", "other-canvas"},
		{"foreign owner", "user_id", "other-owner"},
		{"paid task", "type", "video"},
		{"external provider", "provider", "paid"},
		{"unfinished task", "status", string(model.TaskStatusRunning)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := db.Model(&model.Task{}).Where("id = ?", taskID).Update(tc.field, tc.value).Error; err != nil {
				t.Fatal(err)
			}
			_, bindErr := session.BindExistingCanvasNode("owner", canvas.TaskOutputBind{AllowEmptyVideo: true, CanvasID: "canvas", NodeID: previewID, TaskID: taskID, MediaType: "video"})
			if bindErr == nil {
				t.Fatal("untrusted empty-node bind accepted")
			}
			if err := db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{"project_id": task.ProjectID, "user_id": task.UserID, "type": task.Type, "provider": task.Provider, "status": task.Status}).Error; err != nil {
				t.Fatal(err)
			}
		})
	}
	if _, err := session.BindExistingCanvasNode("owner", canvas.TaskOutputBind{CanvasID: "canvas", NodeID: "clip-v1", TaskID: taskID, MediaType: "video"}); err == nil {
		t.Fatal("render overwrote existing media")
	}
	bindPayload, _ := json.Marshal(map[string]any{"canvasId": "canvas", "taskId": taskID, "nodeId": previewID, "outputIndex": 0})
	bound, err := registry.Execute(operations.Request{UserID: "owner", Caller: operations.AssistantCaller(trustedScope, false), TurnID: turnID, Op: "canvas.task.bind", OpID: localtask.AttachNodeEffectKey(taskID, previewID, 0), Params: bindPayload})
	if err != nil {
		t.Fatalf("cannot bind render: %v", err)
	}
	if bound.Result.(map[string]any)["bindingStatus"] != "bound" {
		t.Fatal("preview not bound")
	}
	t.Run("bound render can be inspected in the same turn", func(t *testing.T) {
		view, err := readMedia(t, map[string]any{"canvasId": "canvas", "nodeId": previewID})
		if err != nil {
			t.Fatalf("cannot inspect the bound local render: %v", err)
		}
		encoded, err := json.Marshal(view.Result)
		if err != nil {
			t.Fatal(err)
		}
		var overview operations.MediaResult
		if err := json.Unmarshal(encoded, &overview); err != nil {
			t.Fatal(err)
		}
		if overview.Source.CanvasID != "canvas" || overview.Source.NodeID != previewID || overview.Source.ResourceID != delivered[0].ResourceID || overview.Source.Version == "" {
			t.Fatalf("overview must identify this rendered output: %+v", overview.Source)
		}
		if !overview.HasVideo || overview.DurationMs < 900 || overview.DurationMs > 1100 || len(overview.Content) == 0 {
			t.Fatalf("actual rendered media was not read: video=%v duration=%d frames=%d", overview.HasVideo, overview.DurationMs, len(overview.Content))
		}
		for _, part := range overview.Content {
			if part.Data == "" || part.Source.ResourceID != delivered[0].ResourceID || part.Source.Version != overview.Source.Version {
				t.Fatal("preview frames must come from the bound resource version")
			}
		}
	})
	for _, tc := range []struct {
		name, reason string
		params       map[string]any
	}{
		{"binding does not allow another canvas", "scope_denied", map[string]any{"canvasId": "other-canvas", "nodeId": previewID}},
		{"binding does not allow an unlinked owned resource", "media_not_referenced", map[string]any{"canvasId": "canvas", "nodeId": previewID, "resourceId": resource.ID}},
		{"binding does not allow a missing node", "node_not_in_canvas", map[string]any{"canvasId": "canvas", "nodeId": "missing-node", "resourceId": delivered[0].ResourceID}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := readMedia(t, tc.params)
			if err == nil || operations.AsError(err).Reason != tc.reason {
				t.Fatalf("expected %s, got %v", tc.reason, err)
			}
		})
	}
	if err := svc.FinalizeAssistantTurn(turnID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UndoAssistantTurn("owner", "canvas", turnID); err != nil {
		t.Fatalf("render/edit/bind undo failed: %v", err)
	}
	restored, err := svc.UserCanvasProject("owner", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	var restoredDoc map[string]any
	json.Unmarshal(restored, &restoredDoc)
	if len(restoredDoc["nodes"].([]any)) != 1 {
		t.Fatal("undo left preview node")
	}
	var result timelineRenderResult
	if err := json.Unmarshal([]byte(task.ResultJSON), &result); err != nil {
		t.Fatal(err)
	}
	output, reader, err := svc.OpenResource("owner", result.ResourceID)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if output.Size <= 0 || result.DurationMs < 900 || result.DurationMs > 1100 {
		t.Fatalf("bad actualoutput %+v", result)
	}
	if first.Result.(map[string]any)["charged"] != false {
		t.Fatal("localrender must be free")
	}
	// Later manual timeline changes cannot rewrite the task's frozen input/result.
	laterTimeline := timeline
	laterTimeline.Clips = append([]editing.Clip{}, timeline.Clips...)
	laterTimeline.DurationMs = 500
	laterTimeline.Clips[0].DurationMs = 500
	restoredDoc["timeline"] = laterTimeline
	raw, _ = json.Marshal(restoredDoc)
	if _, err := svc.UpsertUserCanvasProject("owner", raw); err != nil {
		t.Fatal(err)
	}
	var frozen timelineRenderInput
	if err := json.Unmarshal([]byte(task.InputJSON), &frozen); err != nil {
		t.Fatal(err)
	}
	if frozen.Timeline.Clips[0].DurationMs != 1000 {
		t.Fatal("render input changed")
	}
}
