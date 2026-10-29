package app

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

const tinyPNGDataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

func TestGenerationDeliverySurvivesSQLiteReopenAndUIClose(t *testing.T) {
	path := filepath.Join(t.TempDir(), "generation-delivery.db")
	open := func() (*Service, *gorm.DB) {
		return newGenerationDeliveryService(t, path)
	}

	svc, db := open()
	now := time.Now()
	resource := model.Resource{ID: "res-image-1", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png", Size: 12, Width: 64, Height: 64, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	operation := "canvas-op-manual-1"
	task := model.Task{
		ID: "task-manual-1", UserID: "user-1", ProjectID: "canvas-1", Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Prompt: "a cat", ClientOperationID: &operation,
		InputJSON:  `{"metadata":{"source":"canvas","nodeId":"node-1","clientOperationId":"canvas-op-manual-1"}}`,
		ResultJSON: `{"mode":"image","images":[{"resourceId":"res-image-1","storageKey":"resource:res-image-1","url":"/api/resources/res-image-1/file"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	closeDB(t, db)

	reopened, db := open()
	defer closeDB(t, db)
	got, err := reopened.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantAsset := localtask.MaterializedAssetID(task.ID, 0)
	if got.ResultState != localtask.ResultStateReady || len(got.Outputs) != 1 {
		t.Fatalf("reopened task = state:%s outputs:%#v", got.ResultState, got.Outputs)
	}
	output := got.Outputs[0]
	if output.MaterializedAssetID != wantAsset || output.ResourceID != resource.ID || output.TargetBinding == nil || output.TargetBinding.NodeID != "node-1" {
		t.Fatalf("reopened output = %#v, want asset %s", output, wantAsset)
	}
	if output.EffectKey != localtask.MaterializeEffectKey(task.ID, 0) {
		t.Fatalf("effect key = %q", output.EffectKey)
	}
	var assets, representations, results int64
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 1 {
		t.Fatalf("assets = %d err=%v", assets, err)
	}
	if err := db.Model(&model.AssetRepresentation{}).Count(&representations).Error; err != nil || representations != 1 {
		t.Fatalf("representations = %d err=%v", representations, err)
	}
	if err := db.Model(&model.Result{}).Where("kind = ?", localtask.ResultKindGenerationOutput).Count(&results).Error; err != nil || results != 1 {
		t.Fatalf("generation results = %d err=%v", results, err)
	}
	summaries, err := reopened.TasksWithOptions("user-1", TaskListOptions{Limit: 10, ProjectID: "canvas-1"})
	if err != nil || len(summaries) != 1 || summaries[0].ResultState != localtask.ResultStateReady || len(summaries[0].Outputs) != 1 || summaries[0].Outputs[0].MaterializedAssetID != wantAsset {
		t.Fatalf("summaries = %#v err=%v", summaries, err)
	}
}

func TestGenerationDeliveryGetDoesNotWriteRepairAfterCompletionWithoutWorkerDeliver(t *testing.T) {
	path := filepath.Join(t.TempDir(), "generation-repair.db")
	svc, db := newGenerationDeliveryService(t, path)
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-video-1", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 24, Width: 1280, Height: 720, DurationMs: 5000, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-repair-1", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"source":"create-page","conversationId":"conv-1","messageId":"msg-1"}}`,
		ResultJSON: `{"mode":"video","video":{"resourceId":"res-video-1","storageKey":"resource:res-video-1"}}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Outputs[0].MaterializedAssetID != "" {
		t.Fatalf("GET wrote a delivery repair: %#v", got.Outputs[0])
	}
	var assets, results int64
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 0 {
		t.Fatalf("GET created assets = %d err=%v", assets, err)
	}
	if err := db.Model(&model.Result{}).Where("kind = ?", localtask.ResultKindGenerationOutput).Count(&results).Error; err != nil || results != 0 {
		t.Fatalf("GET created results = %d err=%v", results, err)
	}
	if err := svc.RecoverIncompleteGenerationDeliveries(8); err != nil {
		t.Fatal(err)
	}
	got, err = svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState != localtask.ResultStateReady || len(got.Outputs) != 1 || got.Outputs[0].MediaType != "video" {
		t.Fatalf("background recovered task = %#v", got)
	}
	if got.Outputs[0].MaterializedAssetID != localtask.MaterializedAssetID(task.ID, 0) {
		t.Fatalf("recovered asset = %q", got.Outputs[0].MaterializedAssetID)
	}
	if got.Outputs[0].TargetBinding == nil || got.Outputs[0].TargetBinding.MessageID != "msg-1" || got.Outputs[0].TargetBinding.ConversationID != "conv-1" {
		t.Fatalf("message binding = %#v", got.Outputs[0].TargetBinding)
	}
}

func TestGenerationDeliveryGetFailedTaskDoesNotPayOrMaterialize(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-get-failed.db"))
	defer closeDB(t, db)
	now := time.Now()
	task := model.Task{
		ID: "task-failed-get", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusFailed,
		InputJSON:  `{"metadata":{"source":"create-page","conversationId":"conv-1","messageId":"msg-1"}}`,
		ResultJSON: `{"images":[{"url":"https://example.invalid/paid-retry.png"}]}`,
		Error:      "upstream failed",
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Task("user-1", task.ID); err != nil {
		t.Fatal(err)
	}
	var assets, results int64
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 0 {
		t.Fatalf("failed GET created assets = %d err=%v", assets, err)
	}
	if err := db.Model(&model.Result{}).Count(&results).Error; err != nil || results != 0 {
		t.Fatalf("failed GET created results = %d err=%v", results, err)
	}
}

func TestGenerationDeliveryIsIdenticalForManualAndAgentMetadata(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-agent.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-shared", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png", Size: 8, Width: 32, Height: 32, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	manual := seedSucceededImageTask(t, db, "task-manual", `{"metadata":{"source":"canvas","nodeId":"node-manual"}}`)
	agent := seedSucceededImageTask(t, db, "task-agent", `{"metadata":{"source":"canvas","nodeId":"node-agent","clientOperationId":"proposal:gp-1:node-agent"}}`)
	if err := svc.DeliverSucceededTask(manual); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(agent); err != nil {
		t.Fatal(err)
	}
	manualGot, err := svc.Task("user-1", manual.ID)
	if err != nil {
		t.Fatal(err)
	}
	agentGot, err := svc.Task("user-1", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if manualGot.ResultState != localtask.ResultStateReady || agentGot.ResultState != localtask.ResultStateReady {
		t.Fatalf("states manual=%s agent=%s", manualGot.ResultState, agentGot.ResultState)
	}
	if manualGot.Outputs[0].ResourceID != "res-shared" || agentGot.Outputs[0].ResourceID != "res-shared" {
		t.Fatalf("resource ownership drifted: %#v %#v", manualGot.Outputs[0], agentGot.Outputs[0])
	}
	if manualGot.Outputs[0].MaterializedAssetID == agentGot.Outputs[0].MaterializedAssetID {
		t.Fatal("distinct tasks must keep distinct asset identities")
	}
	if manualGot.Outputs[0].TargetBinding.NodeID != "node-manual" || agentGot.Outputs[0].TargetBinding.NodeID != "node-agent" {
		t.Fatalf("target bindings = %#v %#v", manualGot.Outputs[0].TargetBinding, agentGot.Outputs[0].TargetBinding)
	}
}

func TestGenerationDeliveryRejectsForeignResourceAndSkipsCancelled(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-guard.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "foreign-res", UserID: "other-user", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	foreign := model.Task{
		ID: "task-foreign", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"resourceId":"foreign-res"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&foreign).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(foreign); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task("user-1", foreign.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState != localtask.ResultStateFailedPermanent || got.Outputs[0].MaterializedAssetID != "" || got.Outputs[0].MaterializationErrorCode != localtask.MaterializeErrorResourceForeign {
		t.Fatalf("foreign delivery = %#v", got)
	}
	cancelled := model.Task{ID: "task-cancelled", UserID: "user-1", Status: model.TaskStatusCancelled, ResultJSON: `{"images":[{"resourceId":"foreign-res"}]}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&cancelled).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(cancelled); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := db.Model(&model.Result{}).Where("task_id = ?", cancelled.ID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("cancelled delivery wrote results: %d %v", count, err)
	}
}

func TestGenerationDeliveryReusesWorkflowOutputSlot(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-workflow.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-workflow", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 10, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	assetID := localtask.StableEntityID("asset", "task-workflow")
	versionID := localtask.OutputVersionID("task-workflow", 0)
	if err := db.Create(&model.Asset{ID: assetID, UserID: "user-1", Kind: "video", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, PrimaryVersionID: versionID, Title: "镜头产物 · 视频", PayloadJSON: `{"id":"` + assetID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AssetVersion{ID: versionID, AssetID: assetID, Version: 1, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: "{}", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AssetRepresentation{ID: "existing-output", TaskID: "task-workflow", AssetVersionID: versionID, ResourceID: "res-workflow", MediaType: "video", Role: "output", CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-workflow", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"video":{"resourceId":"res-workflow"}}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Outputs[0].MaterializedAssetID != assetID {
		t.Fatalf("workflow slot replaced: %q want %q", got.Outputs[0].MaterializedAssetID, assetID)
	}
	var representations int64
	if err := db.Model(&model.AssetRepresentation{}).Count(&representations).Error; err != nil || representations != 1 {
		t.Fatalf("representations = %d err=%v", representations, err)
	}
	var stored model.Asset
	if err := db.First(&stored, "id = ?", assetID).Error; err != nil || stored.Title != "镜头产物 · 视频" {
		t.Fatalf("workflow asset overwritten: %#v err=%v", stored, err)
	}
}

func TestGenerationDeliveryLeavesWorkflowSlotForProjectRegistration(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-workflow-pending.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-workflow-pending", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 10, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-workflow-pending", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"workflowStepId":"step-1","shotId":"shot-1"}}`,
		ResultJSON: `{"video":{"resourceId":"res-workflow-pending"}}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	var assets, representations int64
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 0 {
		t.Fatalf("workflow first pass created assets = %d err=%v", assets, err)
	}
	if err := db.Model(&model.AssetRepresentation{}).Count(&representations).Error; err != nil || representations != 0 {
		t.Fatalf("workflow first pass created representations = %d err=%v", representations, err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState != localtask.ResultStatePendingMaterialization || got.Outputs[0].MaterializedAssetID != "" {
		t.Fatalf("workflow pending = %#v", got)
	}

	assetID := localtask.StableEntityID("asset", task.ID)
	versionID := localtask.OutputVersionID(task.ID, 0)
	if err := db.Create(&model.Asset{ID: assetID, UserID: "user-1", Kind: "video", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, PrimaryVersionID: versionID, Title: "镜头产物 · 视频", PayloadJSON: `{"id":"` + assetID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AssetVersion{ID: versionID, AssetID: assetID, Version: 1, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: "{}", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AssetRepresentation{ID: "existing-output", TaskID: task.ID, AssetVersionID: versionID, ResourceID: "res-workflow-pending", MediaType: "video", Role: "output", CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	bound, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if bound.ResultState != localtask.ResultStateReady || bound.Outputs[0].MaterializedAssetID != assetID {
		t.Fatalf("workflow bind = %#v", bound)
	}
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 1 {
		t.Fatalf("workflow bind created extra assets = %d err=%v", assets, err)
	}
}

func TestGenerationDeliveryPersistsLeftoverRemoteURLThroughMedia(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-remote.db"))
	defer closeDB(t, db)
	now := time.Now()
	resource := model.Resource{ID: "res-remote-1", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png", Size: 8, Width: 16, Height: 16, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	media := &deliveryMediaStub{resource: &resource}
	svc.generationDeliveryMedia = media
	task := model.Task{
		ID: "task-remote", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"url":"https://upstream.example/a.png"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	if media.persists.Load() != 1 || media.lastURL != "https://upstream.example/a.png" || media.lastIdentity != "task-remote:0" {
		t.Fatalf("media persist = calls:%d url:%q identity:%q", media.persists.Load(), media.lastURL, media.lastIdentity)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	if err := svc.RecoverIncompleteGenerationDeliveries(8); err != nil {
		t.Fatal(err)
	}
	if media.persists.Load() != 1 {
		t.Fatalf("complete leftover replay re-downloaded: %d", media.persists.Load())
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState != localtask.ResultStateReady || got.Outputs[0].ResourceID != resource.ID || got.Outputs[0].MaterializedAssetID == "" {
		t.Fatalf("persisted leftover = %#v", got)
	}
}

func TestGenerationDeliveryLeftoverURLWithoutMediaIsRetryable(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-remote-retry.db"))
	defer closeDB(t, db)
	now := time.Now()
	task := model.Task{
		ID: "task-remote-retry", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"url":"https://upstream.example/a.png"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState != localtask.ResultStateFailedRetryable || got.Outputs[0].MaterializationErrorCode != localtask.MaterializeErrorPersistFailed || got.Outputs[0].MaterializedAssetID != "" {
		t.Fatalf("leftover without media = %#v", got)
	}
}

func TestGenerationDeliveryRecordsUnsupportedBlobShape(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-blob.db"))
	defer closeDB(t, db)
	now := time.Now()
	task := model.Task{
		ID: "task-blob", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"url":"blob:https://local/abc"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState != localtask.ResultStateFailedPermanent || got.Outputs[0].MaterializationErrorCode != localtask.MaterializeErrorUnsupportedShape {
		t.Fatalf("blob shape = %#v", got)
	}
}

func TestGenerationDeliveryKeepsClientOperationIdentity(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-opid.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-shared", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	key := "proposal:gp-1:node-1"
	task := seedSucceededImageTask(t, db, "task-op-1", `{"metadata":{"nodeId":"node-1","clientOperationId":"proposal:gp-1:node-1"}}`)
	task.ClientOperationID = &key
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("client_operation_id", key).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	existing, err := svc.repo.TaskByClientOperation("user-1", key)
	if err != nil || existing == nil || existing.ID != task.ID {
		t.Fatalf("client operation identity lost: %#v %v", existing, err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil || got.ClientOperationID == nil || *got.ClientOperationID != key {
		t.Fatalf("task client operation = %#v err=%v", got, err)
	}
}

func TestGenerationDeliveryConcurrentReplayPreservesEditedMetadata(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-concurrent.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-edit", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png", Size: 8, Width: 32, Height: 32, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-edit", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"resourceId":"res-edit"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	assetID := localtask.MaterializedAssetID(task.ID, 0)
	if err := db.Model(&model.Asset{}).Where("id = ?", assetID).Updates(map[string]any{
		"title":        "用户改过的标题",
		"folder_id":    "folder-user",
		"payload_json": `{"id":"` + assetID + `","title":"用户改过的标题"}`,
	}).Error; err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- svc.DeliverSucceededTask(task)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var stored model.Asset
	if err := db.First(&stored, "id = ?", assetID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Title != "用户改过的标题" || stored.FolderID != "folder-user" {
		t.Fatalf("concurrent replay reset metadata: %#v", stored)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil || got.ResultState != localtask.ResultStateReady || got.Outputs[0].MaterializedAssetID != assetID {
		t.Fatalf("concurrent replay = %#v err=%v", got, err)
	}
}

func TestGenerationDeliveryRejectsForeignStableAssetID(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-foreign-asset.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-owned", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-collision", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"resourceId":"res-owned"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	assetID := localtask.MaterializedAssetID(task.ID, 0)
	if err := db.Create(&model.Asset{ID: assetID, UserID: "other-user", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "别人的素材", PayloadJSON: `{"id":"` + assetID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState != localtask.ResultStateFailedPermanent || got.Outputs[0].MaterializationErrorCode != localtask.MaterializeErrorAssetForeign || got.Outputs[0].MaterializedAssetID != "" {
		t.Fatalf("foreign collision = %#v", got)
	}
	var stored model.Asset
	if err := db.First(&stored, "id = ?", assetID).Error; err != nil || stored.UserID != "other-user" || stored.Title != "别人的素材" {
		t.Fatalf("foreign asset mutated: %#v err=%v", stored, err)
	}
}

func TestGenerationDeliveryUnreadableRecordsAreObservable(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-unreadable.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-unreadable", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := seedSucceededImageTask(t, db, "task-unreadable", `{"metadata":{"nodeId":"node-1"}}`)
	task.ResultJSON = `{"images":[{"resourceId":"res-unreadable"}]}`
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("result_json", task.ResultJSON).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Result{}).Where("task_id = ? AND kind = ?", task.ID, localtask.ResultKindGenerationOutput).Update("payload", "{").Error; err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState == localtask.ResultStateReady || len(got.Outputs) == 0 || got.Outputs[0].MaterializationErrorCode != localtask.MaterializeErrorDeliveryUnreadable || got.Outputs[0].MaterializedAssetID != "" {
		t.Fatalf("unreadable get = %#v", got)
	}
	summaries, err := svc.TasksWithOptions("user-1", TaskListOptions{Limit: 10})
	if err != nil || len(summaries) != 1 || summaries[0].ResultState == localtask.ResultStateReady || len(summaries[0].Outputs) == 0 || summaries[0].Outputs[0].MaterializationErrorCode != localtask.MaterializeErrorDeliveryUnreadable {
		t.Fatalf("unreadable list = %#v err=%v", summaries, err)
	}
}

func TestGenerationDeliveryRestartRecoversWithoutGetOrList(t *testing.T) {
	path := filepath.Join(t.TempDir(), "generation-restart.db")
	_, db := newGenerationDeliveryService(t, path)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-restart", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png", Size: 8, Width: 32, Height: 32, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-restart", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		InputJSON: `{"metadata":{"nodeId":"node-restart"}}`, ResultJSON: `{"images":[{"resourceId":"res-restart"}]}`,
		CreatedAt: now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	closeDB(t, db)

	reopened, db := newGenerationDeliveryService(t, path)
	defer closeDB(t, db)
	if err := reopened.RecoverIncompleteGenerationDeliveries(8); err != nil {
		t.Fatal(err)
	}
	results, err := reopened.repo.GenerationOutputResults(task.ID)
	if err != nil || len(results) != 1 {
		t.Fatalf("recovered results = %#v err=%v", results, err)
	}
	output, err := localtask.DecodeOutputPayload(results[0].Payload)
	if err != nil || output.MaterializedAssetID != localtask.MaterializedAssetID(task.ID, 0) || output.ResourceID != "res-restart" {
		t.Fatalf("recovered payload = %#v err=%v", output, err)
	}
	var assets int64
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 1 {
		t.Fatalf("recovered assets = %d err=%v", assets, err)
	}
	intents := reopened.CanvasBindingIntents(task)
	if len(intents) != 1 || intents[0].TargetBinding == nil || intents[0].TargetBinding.NodeID != "node-restart" || intents[0].AssetID != output.MaterializedAssetID {
		t.Fatalf("binding intents = %#v", intents)
	}
}

func TestGenerationDeliveryMultipleOutputsAndNoDuplicatePersist(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-multi.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-a", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Resource{ID: "res-b", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	media := &deliveryMediaStub{resource: &model.Resource{ID: "should-not-persist"}}
	svc.generationDeliveryMedia = media
	task := model.Task{
		ID: "task-multi", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"resourceId":"res-a"},{"resourceId":"res-b"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	if media.persists.Load() != 0 {
		t.Fatalf("resource-backed delivery called persist %d times", media.persists.Load())
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil || got.ResultState != localtask.ResultStateReady || len(got.Outputs) != 2 {
		t.Fatalf("multioutput = %#v err=%v", got, err)
	}
	if got.Outputs[0].ResourceID != "res-a" || got.Outputs[1].ResourceID != "res-b" {
		t.Fatalf("multioutput resources = %#v", got.Outputs)
	}
	if got.Outputs[0].MaterializedAssetID == got.Outputs[1].MaterializedAssetID {
		t.Fatal("multioutput shared asset identity")
	}
	var assets, results int64
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 2 {
		t.Fatalf("multioutput assets = %d err=%v", assets, err)
	}
	if err := db.Model(&model.Result{}).Where("kind = ?", localtask.ResultKindGenerationOutput).Count(&results).Error; err != nil || results != 2 {
		t.Fatalf("multioutput results = %d err=%v", results, err)
	}
}

func TestProviderTaskRecoveryAttachesDeliveryWithoutGet(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-provider-recovery.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-recovered", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 16, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-recovered", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"source":"create-page","messageId":"msg-recovered"}}`,
		ResultJSON: `{"mode":"video","video":{"resourceId":"res-recovered"}}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	projected := svc.attachRecoveredProviderTask(&task)
	if projected == nil || projected.ResultState != localtask.ResultStateReady || len(projected.Outputs) != 1 || projected.Outputs[0].MaterializedAssetID == "" {
		t.Fatalf("provider recovery projection = %#v", projected)
	}
	if projected.Outputs[0].TargetBinding == nil || projected.Outputs[0].TargetBinding.MessageID != "msg-recovered" {
		t.Fatalf("provider recovery binding = %#v", projected.Outputs[0])
	}
	var assets int64
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 1 {
		t.Fatalf("provider recovery assets = %d err=%v", assets, err)
	}
}

func TestGenerationDeliveryFairKeysetSweepRecoversOldPartialCorruptAndDoesNotStarve(t *testing.T) {
	path := filepath.Join(t.TempDir(), "generation-sweep.db")
	_, db := newGenerationDeliveryService(t, path)
	now := time.Now()
	old := now.Add(-365 * 24 * time.Hour)
	for _, resource := range []model.Resource{
		{ID: "res-t3-0", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: old, UpdatedAt: old},
		{ID: "res-t3-1", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: old, UpdatedAt: old},
		{ID: "res-t4", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: old, UpdatedAt: old},
		{ID: "res-t5", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now},
	} {
		if err := db.Create(&resource).Error; err != nil {
			t.Fatal(err)
		}
	}
	seedSucceededTaskAt(t, db, "t1-permanent", `{"images":[{"url":"blob:https://local/old-1"}]}`, now)
	seedSucceededTaskAt(t, db, "t2-permanent", `{"images":[{"url":"blob:https://local/old-2"}]}`, now)
	seedSucceededTaskAt(t, db, "t3-partial", `{"images":[{"resourceId":"res-t3-0"},{"resourceId":"res-t3-1"}]}`, old)
	partial := localtask.CanonicalOutput{OutputIndex: 0, MediaType: "image", ResourceID: "res-t3-0", MaterializedAssetID: localtask.MaterializedAssetID("t3-partial", 0)}
	payload, err := localtask.EncodeOutputPayload(partial)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Result{ID: localtask.OutputResultID("t3-partial", 0), UserID: "user-1", TaskID: "t3-partial", Kind: localtask.ResultKindGenerationOutput, Payload: payload, CreatedAt: old}).Error; err != nil {
		t.Fatal(err)
	}
	seedSucceededTaskAt(t, db, "t4-corrupt", `{"images":[{"resourceId":"res-t4"}]}`, old)
	if err := db.Create(&model.Result{ID: localtask.OutputResultID("t4-corrupt", 0), UserID: "user-1", TaskID: "t4-corrupt", Kind: localtask.ResultKindGenerationOutput, Payload: "{", CreatedAt: old}).Error; err != nil {
		t.Fatal(err)
	}
	seedSucceededTaskAt(t, db, "t5-later", `{"images":[{"resourceId":"res-t5"}]}`, now)
	closeDB(t, db)

	svc, db := newGenerationDeliveryService(t, path)
	defer closeDB(t, db)
	if err := svc.RecoverIncompleteGenerationDeliveries(2); err != nil {
		t.Fatal(err)
	}
	if got := generationOutputCount(t, db, "t1-permanent"); got != 1 {
		t.Fatalf("tick1 t1 results = %d", got)
	}
	if got := generationOutputCount(t, db, "t2-permanent"); got != 1 {
		t.Fatalf("tick1 t2 results = %d", got)
	}
	if got := generationOutputCount(t, db, "t3-partial"); got != 1 {
		t.Fatalf("tick1 old partial scanned too early = %d", got)
	}
	if payload := generationOutputPayloads(t, db, "t4-corrupt"); len(payload) != 1 || payload[0] != "{" {
		t.Fatalf("tick1 corrupt payload = %#v", payload)
	}
	if got := generationOutputCount(t, db, "t5-later"); got != 0 {
		t.Fatalf("tick1 later task starved in = %d", got)
	}

	if err := svc.RecoverIncompleteGenerationDeliveries(2); err != nil {
		t.Fatal(err)
	}
	t3 := generationOutputsByIndex(t, svc, "t3-partial")
	if len(t3) != 2 || t3[0].MaterializedAssetID == "" || t3[1].MaterializedAssetID == "" || t3[0].ResourceID != "res-t3-0" || t3[1].ResourceID != "res-t3-1" {
		t.Fatalf("tick2 old partial = %#v", t3)
	}
	t4 := mustDecodeGenerationOutputs(t, svc, "t4-corrupt")
	if len(t4) != 1 || t4[0].MaterializedAssetID == "" || t4[0].ResourceID != "res-t4" {
		t.Fatalf("tick2 corrupt = %#v", t4)
	}
	if got := generationOutputCount(t, db, "t5-later"); got != 0 {
		t.Fatalf("tick2 later task still unreached = %d", got)
	}

	if err := svc.RecoverIncompleteGenerationDeliveries(2); err != nil {
		t.Fatal(err)
	}
	t5 := mustDecodeGenerationOutputs(t, svc, "t5-later")
	if len(t5) != 1 || t5[0].MaterializedAssetID == "" || t5[0].ResourceID != "res-t5" {
		t.Fatalf("tick3 later task = %#v", t5)
	}
	t1 := mustDecodeGenerationOutputs(t, svc, "t1-permanent")
	if t1[0].MaterializationErrorCode != localtask.MaterializeErrorUnsupportedShape {
		t.Fatalf("permanent t1 = %#v", t1)
	}
	if err := svc.RecoverIncompleteGenerationDeliveries(2); err != nil {
		t.Fatal(err)
	}
	if got := generationOutputCount(t, db, "t5-later"); got != 1 {
		t.Fatalf("wrap rewritten later task = %d", got)
	}
}

func TestGenerationDeliveryBindExistingRequiresOwnedReadyResource(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-bind-existing.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-pending-bind", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	missingTask := seedBindExistingTask(t, db, "task-missing-res", "res-gone", now)
	if err := svc.DeliverSucceededTask(missingTask); err != nil {
		t.Fatal(err)
	}
	missing := mustDecodeGenerationOutputs(t, svc, missingTask.ID)
	if len(missing) != 1 || missing[0].MaterializedAssetID != "" || missing[0].MaterializationErrorCode != localtask.MaterializeErrorResourceMissing {
		t.Fatalf("missing resource bind = %#v", missing)
	}
	pendingTask := seedBindExistingTask(t, db, "task-pending-res", "res-pending-bind", now)
	if err := svc.DeliverSucceededTask(pendingTask); err != nil {
		t.Fatal(err)
	}
	pending := mustDecodeGenerationOutputs(t, svc, pendingTask.ID)
	if len(pending) != 1 || pending[0].MaterializedAssetID != "" || pending[0].MaterializationErrorCode != localtask.MaterializeErrorResourceNotReady {
		t.Fatalf("not-ready resource bind = %#v", pending)
	}
	got, err := svc.Task("user-1", missingTask.ID)
	if err != nil || got.ResultState == localtask.ResultStateReady || got.Outputs[0].MaterializedAssetID != "" {
		t.Fatalf("missing resource projected ready: %#v err=%v", got, err)
	}
}

func TestGenerationDeliveryBindExistingMissingVersionIsNotReady(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-bind-version.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-version-missing", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-missing-version", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"resourceId":"res-version-missing"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AssetRepresentation{ID: "repr-missing-version", TaskID: task.ID, AssetVersionID: "version-does-not-exist", ResourceID: "res-version-missing", MediaType: "image", Role: "output", CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	stored := mustDecodeGenerationOutputs(t, svc, task.ID)
	if len(stored) != 1 || stored[0].MaterializedAssetID != "" || stored[0].MaterializationErrorCode != localtask.MaterializeErrorPersistFailed {
		t.Fatalf("missing version bind = %#v", stored)
	}
}

func TestGenerationDeliveryRecoversFailedAndPendingResourceSameIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "generation-media-retry.db")
	dataDir := t.TempDir()
	svc, db := newGenerationDeliveryMediaService(t, path, dataDir)
	now := time.Now()
	failedTask := model.Task{
		ID: "task-media-failed", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"url":"` + tinyPNGDataURL + `"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&failedTask).Error; err != nil {
		t.Fatal(err)
	}
	failedSeed := seedLeftoverGenerationArtifact(t, svc, "res-media-failed", "user-1", failedTask.ID+":0", model.ResourceStatusFailed, tinyPNGDataURL)
	if err := svc.RecoverIncompleteGenerationDeliveries(8); err != nil {
		t.Fatal(err)
	}
	failedStored := mustDecodeGenerationOutputs(t, svc, failedTask.ID)
	if len(failedStored) != 1 || failedStored[0].ResourceID != failedSeed.ID || failedStored[0].MaterializedAssetID == "" {
		t.Fatalf("failed recovery = %#v want %s", failedStored, failedSeed.ID)
	}
	failedResource, err := svc.repo.Resource(failedSeed.ID)
	if err != nil || failedResource.Status != model.ResourceStatusReady || !generationArtifactPresent(t, svc, failedResource) {
		t.Fatalf("failed resource = %#v err=%v", failedResource, err)
	}

	pendingTask := model.Task{
		ID: "task-media-pending", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"url":"` + tinyPNGDataURL + `"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&pendingTask).Error; err != nil {
		t.Fatal(err)
	}
	pendingSeed := seedLeftoverGenerationArtifact(t, svc, "res-media-pending", "user-1", pendingTask.ID+":0", model.ResourceStatusPending, tinyPNGDataURL)
	day := time.Now().UTC().Format("2006-01-02")
	usageBefore, err := svc.repo.DailyUploadBytes("user-1", day)
	if err != nil {
		t.Fatal(err)
	}
	closeDB(t, db)

	reopened, db := newGenerationDeliveryMediaService(t, path, dataDir)
	defer closeDB(t, db)
	if err := reopened.RecoverIncompleteGenerationDeliveries(8); err != nil {
		t.Fatal(err)
	}
	pendingStored := mustDecodeGenerationOutputs(t, reopened, pendingTask.ID)
	if len(pendingStored) != 1 || pendingStored[0].ResourceID != pendingSeed.ID || pendingStored[0].MaterializedAssetID == "" {
		t.Fatalf("pending reopen = %#v want %s", pendingStored, pendingSeed.ID)
	}
	pendingResource, err := reopened.repo.Resource(pendingSeed.ID)
	if err != nil || pendingResource.Status != model.ResourceStatusReady || !generationArtifactPresent(t, reopened, pendingResource) {
		t.Fatalf("pending resource = %#v err=%v", pendingResource, err)
	}
	usageAfter, err := reopened.repo.DailyUploadBytes("user-1", day)
	if err != nil {
		t.Fatal(err)
	}
	if usageAfter != usageBefore {
		t.Fatalf("pending promote consumed extra quota: before=%d after=%d", usageBefore, usageAfter)
	}
}

func TestGenerationDeliveryReadyReplayRepairsMissingLocalArtifact(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "generation-ready-missing.db"), t.TempDir())
	defer closeDB(t, db)
	now := time.Now()
	task := model.Task{
		ID: "task-ready-missing", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"url":"` + tinyPNGDataURL + `"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	adapter := generationDeliveryMediaAdapter{service: svc}
	first, err := adapter.PersistRemoteArtifact("user-1", "image", tinyPNGDataURL, task.ID+":0")
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != model.ResourceStatusReady || !generationArtifactPresent(t, svc, first) {
		t.Fatalf("first persist = %#v", first)
	}
	if err := localasset.NewFileStore(svc.dataDir).Delete(first.ObjectKey); err != nil {
		t.Fatal(err)
	}
	if generationArtifactPresent(t, svc, first) {
		t.Fatal("deleted artifact still present")
	}
	replay, err := adapter.PersistRemoteArtifact("user-1", "image", tinyPNGDataURL, task.ID+":0")
	if err != nil {
		t.Fatal(err)
	}
	if replay.ID != first.ID || replay.Status != model.ResourceStatusReady {
		t.Fatalf("ready replay = %#v want %s", replay, first.ID)
	}
	if !generationArtifactPresent(t, svc, replay) {
		t.Fatal("ready replay invented success without a local file")
	}
	if err := svc.RecoverIncompleteGenerationDeliveries(8); err != nil {
		t.Fatal(err)
	}
	stored := mustDecodeGenerationOutputs(t, svc, task.ID)
	if len(stored) != 1 || stored[0].ResourceID != first.ID || stored[0].MaterializedAssetID == "" {
		t.Fatalf("ready missing delivery = %#v", stored)
	}
	var resources int64
	if err := db.Model(&model.Resource{}).Count(&resources).Error; err != nil || resources != 1 {
		t.Fatalf("ready replay created extra resources = %d err=%v", resources, err)
	}
}

func TestGenerationDeliveryConcurrentFailedRetryKeepsOneResource(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "generation-media-concurrent.db"), t.TempDir())
	defer closeDB(t, db)
	now := time.Now()
	task := model.Task{
		ID: "task-media-concurrent", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"url":"` + tinyPNGDataURL + `"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	adapter := generationDeliveryMediaAdapter{service: svc}
	seed, err := adapter.PersistRemoteArtifact("user-1", "image", tinyPNGDataURL, task.ID+":0")
	if err != nil {
		t.Fatal(err)
	}
	seed.Status = model.ResourceStatusFailed
	if err := svc.repo.SaveResource(seed); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := adapter.PersistRemoteArtifact("user-1", "image", tinyPNGDataURL, task.ID+":0")
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	resource, err := svc.repo.Resource(seed.ID)
	if err != nil || resource.Status != model.ResourceStatusReady || !generationArtifactPresent(t, svc, resource) {
		t.Fatalf("concurrent retry = %#v err=%v", resource, err)
	}
	var resources int64
	if err := db.Model(&model.Resource{}).Count(&resources).Error; err != nil || resources != 1 {
		t.Fatalf("concurrent retry resources = %d err=%v", resources, err)
	}
}

func TestPersistRemoteArtifactIsolatesForeignCaller(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "generation-foreign.db"), t.TempDir())
	defer closeDB(t, db)
	adapter := generationDeliveryMediaAdapter{service: svc}
	identity := "task-foreign:0"
	first, err := adapter.PersistRemoteArtifact("user-1", "image", tinyPNGDataURL, identity)
	if err != nil {
		t.Fatal(err)
	}
	second, err := adapter.PersistRemoteArtifact("user-2", "image", tinyPNGDataURL, identity)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID || first.UserID != "user-1" || second.UserID != "user-2" {
		t.Fatalf("foreign persist shared row: %#v %#v", first, second)
	}
	owned, err := svc.repo.Resource(first.ID)
	if err != nil || owned.UserID != "user-1" || owned.Status != model.ResourceStatusReady {
		t.Fatalf("owner row mutated: %#v err=%v", owned, err)
	}
}

func TestPersistRemoteArtifactConcurrentFirstPersistKeepsOneResource(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "generation-first-concurrent.db"), t.TempDir())
	defer closeDB(t, db)
	adapter := generationDeliveryMediaAdapter{service: svc}
	identity := "task-first-concurrent:0"
	var wg sync.WaitGroup
	results := make([]*model.Resource, 2)
	errs := make([]error, 2)
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func(index int) {
			defer wg.Done()
			results[index], errs[index] = adapter.PersistRemoteArtifact("user-1", "image", tinyPNGDataURL, identity)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("caller %d: %v", i, err)
		}
	}
	if results[0] == nil || results[1] == nil || results[0].ID != results[1].ID {
		t.Fatalf("concurrent persist = %#v %#v", results[0], results[1])
	}
	var resources int64
	if err := db.Model(&model.Resource{}).Count(&resources).Error; err != nil || resources != 1 {
		t.Fatalf("resources = %d err=%v", resources, err)
	}
	if !generationArtifactPresent(t, svc, results[0]) {
		t.Fatal("concurrent persist missing local file")
	}
}

func TestCanonicalOutputJSONRoundTripMatchesFrontendContract(t *testing.T) {
	output := localtask.BindOutput(localtask.CanonicalOutput{OutputIndex: 0, MediaType: "image", ResourceID: "res-1"}, "task-1", localtask.TargetBinding{NodeID: "node-1"})
	output.MaterializedAssetID = localtask.MaterializedAssetID("task-1", 0)
	raw, err := json.Marshal(modelTaskOutputs([]localtask.CanonicalOutput{output}))
	if err != nil {
		t.Fatal(err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded) != 1 || decoded[0]["outputIndex"] != float64(0) || decoded[0]["materializedAssetId"] != output.MaterializedAssetID {
		t.Fatalf("json = %s", raw)
	}
}

type deliveryMediaStub struct {
	resource     *model.Resource
	err          error
	persists     atomic.Int64
	lastURL      string
	lastIdentity string
}

func (m *deliveryMediaStub) PersistRemoteArtifact(_, _, artifactURL, identity string) (*model.Resource, error) {
	m.persists.Add(1)
	m.lastURL = artifactURL
	m.lastIdentity = identity
	if m.err != nil {
		return nil, m.err
	}
	return m.resource, nil
}

func (m *deliveryMediaStub) Generate(string) (*model.Resource, error) {
	panic("generation/provider submit must not run during delivery")
}

func newGenerationDeliveryService(t *testing.T, path string) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(path+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.SystemSetting{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}, &model.Task{}, &model.TaskLog{}, &model.Result{},
		&model.Asset{}, &model.AssetVersion{}, &model.AssetRepresentation{}, &model.Resource{},
	); err != nil {
		t.Fatal(err)
	}
	return &Service{repo: repository.New(db)}, db
}

func newGenerationDeliveryMediaService(t *testing.T, path, dataDir string) (*Service, *gorm.DB) {
	t.Helper()
	if dataDir == "" {
		dataDir = t.TempDir()
	}
	svc, db := newGenerationDeliveryService(t, path)
	svc.dataDir = dataDir
	svc.mode = serviceModeLocal
	svc.localResourceStorage = true
	return svc, db
}

func seedSucceededImageTask(t *testing.T, db *gorm.DB, id, inputJSON string) model.Task {
	t.Helper()
	now := time.Now()
	task := model.Task{
		ID: id, UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		InputJSON: inputJSON, ResultJSON: `{"images":[{"resourceId":"res-shared","storageKey":"resource:res-shared"}]}`,
		CreatedAt: now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	return task
}

func seedSucceededTaskAt(t *testing.T, db *gorm.DB, id, resultJSON string, at time.Time) model.Task {
	t.Helper()
	task := model.Task{
		ID: id, UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: resultJSON, CreatedAt: at, UpdatedAt: at, CompletedAt: &at,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	return task
}

func seedBindExistingTask(t *testing.T, db *gorm.DB, taskID, resourceID string, now time.Time) model.Task {
	t.Helper()
	task := model.Task{
		ID: taskID, UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"resourceId":"` + resourceID + `"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	assetID := localtask.MaterializedAssetID(taskID, 0)
	versionID := localtask.OutputVersionID(taskID, 0)
	if err := db.Create(&model.Asset{ID: assetID, UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, PrimaryVersionID: versionID, Title: "生成图片", PayloadJSON: `{"id":"` + assetID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AssetVersion{ID: versionID, AssetID: assetID, Version: 1, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: "{}", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AssetRepresentation{ID: localtask.OutputRepresentationID(taskID, 0), TaskID: taskID, AssetVersionID: versionID, ResourceID: resourceID, MediaType: "image", Role: "output", CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	return task
}

func generationOutputCount(t *testing.T, db *gorm.DB, taskID string) int64 {
	t.Helper()
	var count int64
	if err := db.Model(&model.Result{}).Where("task_id = ? AND kind = ?", taskID, localtask.ResultKindGenerationOutput).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}

func generationOutputPayloads(t *testing.T, db *gorm.DB, taskID string) []string {
	t.Helper()
	var results []model.Result
	if err := db.Where("task_id = ? AND kind = ?", taskID, localtask.ResultKindGenerationOutput).Order("id asc").Find(&results).Error; err != nil {
		t.Fatal(err)
	}
	payloads := make([]string, 0, len(results))
	for _, result := range results {
		payloads = append(payloads, result.Payload)
	}
	return payloads
}

func mustDecodeGenerationOutputs(t *testing.T, svc *Service, taskID string) []localtask.CanonicalOutput {
	t.Helper()
	results, err := svc.repo.GenerationOutputResults(taskID)
	if err != nil {
		t.Fatal(err)
	}
	outputs, err := localtask.DecodeOutputResults(results)
	if err != nil {
		t.Fatalf("task %s payload %#v err=%v", taskID, results, err)
	}
	return outputs
}

func generationOutputsByIndex(t *testing.T, svc *Service, taskID string) map[int]localtask.CanonicalOutput {
	t.Helper()
	byIndex := map[int]localtask.CanonicalOutput{}
	for _, output := range mustDecodeGenerationOutputs(t, svc, taskID) {
		byIndex[output.OutputIndex] = output
	}
	return byIndex
}

func generationArtifactPresent(t *testing.T, svc *Service, resource *model.Resource) bool {
	t.Helper()
	return svc.generationLocalArtifactPresent(resource)
}

func seedLeftoverGenerationArtifact(t *testing.T, svc *Service, resourceID, userID, identity string, status model.ResourceStatus, artifactURL string) *model.Resource {
	t.Helper()
	// NewService releases FAILED leftovers. Initialize the domain while empty.
	_ = svc.resourceDomain()
	kind, data, mimeType, fileName, width, height, durationMs, err := (generationDeliveryMediaAdapter{service: svc}).decodeGenerationArtifact(userID, identity, "image", artifactURL)
	if err != nil {
		t.Fatal(err)
	}
	uploadKey := localasset.NormalizedUploadKey([]string{identity})
	if uploadKey == nil {
		t.Fatal("generation artifact identity is incomplete")
	}
	now := time.Now()
	resource := model.Resource{
		ID: resourceID, UserID: userID, Kind: kind, Status: status, Provider: "local",
		ObjectKey: localasset.ObjectKey(userID, kind, fileName, mimeType, now),
		MimeType:  mimeType, Size: int64(len(data)), Width: width, Height: height, DurationMs: durationMs,
		UploadKey: uploadKey, CreatedAt: now, UpdatedAt: now,
	}
	if status == model.ResourceStatusFailed {
		resource.Error = "simulated persist crash"
	}
	if status == model.ResourceStatusPending {
		resource.Error = "simulated crash after write"
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	if err := localasset.NewFileStore(svc.dataDir).Write(resource.ObjectKey, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	if err := svc.repo.ReserveIdentifiedDailyUpload(userID, day, *uploadKey, resource.Size, 1<<40); err != nil {
		t.Fatal(err)
	}
	return &resource
}

func closeDB(t *testing.T, db *gorm.DB) {
	t.Helper()
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
}
