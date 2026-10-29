package project

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestCanvasProductionExistingTaskBindsOnceAndRevisionChangeInvalidatesConfirmations(t *testing.T) {
	svc, db := newTestService(t, nil)
	project, err := svc.CreateProject("user-1", CreateProjectRequest{Name: "两镜头制作"})
	if err != nil {
		t.Fatal(err)
	}
	unit := seedChapter(t, svc, project.ID)
	otherUnit, err := svc.CreateProjectUnit("user-1", project.ID, CreateProjectUnitRequest{Title: "独立章节", SourceText: "其他内容"})
	if err != nil {
		t.Fatal(err)
	}
	otherWorkflow := seedUnitWorkflow(t, svc, project.ID, otherUnit.ID)
	shot, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "镜头A", Description: "原画面", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := model.Task{ID: "existing-canvas-task", UserID: "user-1", ProjectID: "ordinary-canvas", Type: "canvas_video", Status: model.TaskStatusSucceeded, ProviderRequestID: "upstream-original", ResultJSON: `{"video":{"storageKey":"resource:ordinary-output"}}`, CreatedAt: now, UpdatedAt: now}
	resource := model.Resource{ID: "ordinary-output", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 512, CreatedAt: now, UpdatedAt: now}
	payload, _ := json.Marshal(map[string]any{"id": task.ProjectID, "revision": 1, "title": "普通画布", "nodes": []any{map[string]any{"id": "node-video", "type": "video", "title": "原视频节点", "metadata": map[string]any{"taskId": task.ID}}}, "connections": []any{}})
	canvasRow := model.CanvasProject{ID: task.ProjectID, UserID: "user-1", Title: "普通画布", Revision: 1, PayloadJSON: string(payload), CreatedAt: now, UpdatedAt: now}
	for _, row := range []any{&task, &resource, &canvasRow} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	proposed, err := svc.CanvasProductionContext("user-1", project.ID, task.ProjectID, unit.ID, shot.ID, "video")
	if err != nil {
		t.Fatal(err)
	}
	if proposed.Linked || proposed.WorkflowAvailable || proposed.ShotRevisionID != shot.CurrentRevisionID {
		t.Fatalf("read created association %+v", proposed)
	}
	request := CanvasProductionTaskRequest{TaskID: task.ID, UnitID: unit.ID, ShotID: shot.ID, ShotRevisionID: shot.CurrentRevisionID, StepKey: "video"}
	first, err := svc.RegisterCanvasProductionTask("user-1", project.ID, task.ProjectID, request)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Context.Linked || first.ResourceID != resource.ID || first.TaskID != task.ID {
		t.Fatalf("wrong result %+v", first)
	}
	if _, err = svc.RegisterCanvasProductionTask("user-1", project.ID, task.ProjectID, request); err != nil {
		t.Fatal(err)
	}
	assertWorkflowOutputCounts(t, db, task.ID, 1)
	// Binding a recovered existing file uses the same task/effect identity and
	// never invokes a task-creation or provider port.
	canvases := canvas.New(repository.New(db), nil)
	bind := canvas.TaskOutputBind{CanvasID: task.ProjectID, NodeID: "node-video", TaskID: task.ID, EffectKey: "attach-node:" + task.ID + ":node-video:0", MediaType: "video", ResourceID: resource.ID, StorageKey: "resource:" + resource.ID, Content: "/api/resources/" + resource.ID + "/file", MimeType: "video/mp4"}
	bound, err := canvases.BindTaskOutputToExistingNode("user-1", bind)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := canvases.BindTaskOutputToExistingNode("user-1", bind)
	if err != nil {
		t.Fatal(err)
	}
	if retry.Revision != bound.Revision {
		t.Fatal("binding retry rewrote canvas")
	}
	if err := db.Model(&model.WorkflowStepInstance{}).Where("workflow_instance_id IN (?)", db.Model(&model.WorkflowInstance{}).Select("id").Where("project_id = ?", project.ID)).Updates(map[string]any{"status": model.WorkflowStepStatusCompleted, "completed_at": now}).Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err = svc.CreateShotRevision("user-1", project.ID, shot.ID, ShotRevisionInput{PlotDescription: "改为镜头B", DurationMs: 3500}); err != nil {
		t.Fatal(err)
	}
	workflows, err := svc.ProjectWorkflows("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, flow := range workflows {
		for _, step := range flow.Steps {
			want := model.WorkflowStepStatusCompleted
			if flow.Instance.ID != otherWorkflow.Instance.ID && step.Position >= 2 {
				want = model.WorkflowStepStatusPending
				if step.StepKey == "storyboard" {
					want = model.WorkflowStepStatusRunning
				}
			}
			if step.Status != want {
				t.Fatalf("flow %s step %s got %s want %s (current unit %s)", flow.Instance.ID, step.StepKey, step.Status, want, first.Step.WorkflowInstanceID)
			}
		}
	}
	var artifact model.ShotArtifact
	if err := db.Where("task_id = ?", task.ID).First(&artifact).Error; err != nil {
		t.Fatal(err)
	}
	if artifact.Status != "stale" || artifact.Selected {
		t.Fatalf("old approval survived A→B %+v", artifact)
	}
	_, err = svc.RegisterCanvasProductionTask("user-1", project.ID, task.ProjectID, request)
	var conflict *kernel.AppError
	if !errors.As(err, &conflict) || conflict.Reason != "production_revision_conflict" {
		t.Fatalf("old request rebound to B: %v", err)
	}
	updated, err := svc.CanvasProductionContext("user-1", project.ID, task.ProjectID, unit.ID, shot.ID, "video")
	if err != nil {
		t.Fatal(err)
	}
	request.ShotRevisionID = updated.ShotRevisionID
	_, err = svc.RegisterCanvasProductionTask("user-1", project.ID, task.ProjectID, request)
	if !errors.As(err, &conflict) || conflict.Reason != "production_output_revision_mismatch" {
		t.Fatalf("new request silently certified old artifact for B: %v", err)
	}
	var taskCount, resourceCount int64
	db.Model(&model.Task{}).Count(&taskCount)
	db.Model(&model.Resource{}).Count(&resourceCount)
	if taskCount != 1 || resourceCount != 1 {
		t.Fatalf("recovery generated new work tasks=%d resources=%d", taskCount, resourceCount)
	}
	var after model.Task
	db.First(&after, "id = ?", task.ID)
	if after.ProviderRequestID != task.ProviderRequestID || after.Status != task.Status {
		t.Fatal("existing upstream task identity changed")
	}
}

func TestCanvasProductionRejectsPendingForeignAndStaleBeforeAssociation(t *testing.T) {
	svc, db := newTestService(t, nil)
	project, unit, _, shot := seedWorkflowOutputFixture(t, svc, db)
	now := time.Now()
	row := model.CanvasProject{ID: "canvas", UserID: "user-1", Title: "普通画布", Revision: 1, PayloadJSON: `{"id":"canvas","nodes":[],"connections":[]}`, CreatedAt: now, UpdatedAt: now}
	resource := model.Resource{ID: "pending-output", UserID: "user-1", Kind: "video", Status: model.ResourceStatusPending, CreatedAt: now, UpdatedAt: now}
	task := model.Task{ID: "pending-file-task", UserID: "user-1", ProjectID: row.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded, ResultJSON: `{"video":{"storageKey":"resource:pending-output"}}`, CreatedAt: now, UpdatedAt: now}
	for _, item := range []any{&row, &resource, &task} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	request := CanvasProductionTaskRequest{TaskID: task.ID, UnitID: unit.ID, ShotID: shot.ID, ShotRevisionID: shot.CurrentRevisionID, StepKey: "video"}
	if _, err := svc.RegisterCanvasProductionTask("user-1", project.ID, row.ID, request); err == nil {
		t.Fatal("pending local file recorded as ready")
	}
	var links int64
	db.Model(&model.CanvasUnitLink{}).Where("canvas_id = ?", row.ID).Count(&links)
	if links != 0 {
		t.Fatal("failed validation created association")
	}
	if _, err := svc.CanvasProductionContext("foreign", project.ID, row.ID, unit.ID, shot.ID, "video"); err == nil {
		t.Fatal("foreign owner read production context")
	}
	request.ShotRevisionID = "missing-revision"
	if _, err := svc.RegisterCanvasProductionTask("user-1", project.ID, row.ID, request); err == nil {
		t.Fatal("stale confirmation accepted")
	}
}

func TestCanvasProductionFailureRollsBackAssociationAndGeneratedAsset(t *testing.T) {
	svc, db := newTestService(t, nil)
	project, unit, _, shot := seedWorkflowOutputFixture(t, svc, db)
	now := time.Now()
	row := model.CanvasProject{ID: "rollback-canvas", UserID: "user-1", Title: "普通画布", Revision: 1, PayloadJSON: `{"id":"rollback-canvas","nodes":[],"connections":[]}`, CreatedAt: now, UpdatedAt: now}
	resource := model.Resource{ID: "rollback-output", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", CreatedAt: now, UpdatedAt: now}
	task := model.Task{ID: "rollback-task", UserID: "user-1", ProjectID: row.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded, ResultJSON: `{"video":{"storageKey":"resource:rollback-output"}}`, CreatedAt: now, UpdatedAt: now}
	for _, item := range []any{&row, &resource, &task} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Exec(`CREATE TRIGGER reject_canvas_artifact BEFORE INSERT ON shot_artifacts BEGIN SELECT RAISE(ABORT, 'injected artifact failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	request := CanvasProductionTaskRequest{TaskID: task.ID, UnitID: unit.ID, ShotID: shot.ID, ShotRevisionID: shot.CurrentRevisionID, StepKey: "video"}
	if _, err := svc.RegisterCanvasProductionTask("user-1", project.ID, row.ID, request); err == nil {
		t.Fatal("injected failure passed")
	}
	for _, table := range []string{"canvas_unit_links", "assets", "asset_versions", "asset_representations", "shot_artifacts", "production_task_links"} {
		var n int64
		if err := db.Table(table).Count(&n).Error; err != nil || n != 0 {
			t.Fatalf("partial %s rows=%d err=%v", table, n, err)
		}
	}
	var stored model.CanvasProject
	db.First(&stored, "id = ?", row.ID)
	if stored.ProjectID != "" || stored.Revision != 1 {
		t.Fatal("failed registration moved canvas")
	}
}

func TestCanvasProductionMultiOutputRequiresExactSelectionAndCannotChangeReceipt(t *testing.T) {
	svc, db := newTestService(t, nil)
	project, unit, _, shot := seedWorkflowOutputFixture(t, svc, db)
	now := time.Now()
	row := model.CanvasProject{ID: "multi-canvas", UserID: "user-1", Title: "多张图片", Revision: 1, PayloadJSON: `{"id":"multi-canvas","nodes":[],"connections":[]}`, CreatedAt: now, UpdatedAt: now}
	one := model.Resource{ID: "image-one", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png", CreatedAt: now, UpdatedAt: now}
	two := one
	two.ID = "image-two"
	task := model.Task{ID: "images-task", UserID: "user-1", ProjectID: row.ID, Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: `{"images":[{"storageKey":"resource:image-one"},{"storageKey":"resource:image-two"}]}`, CreatedAt: now, UpdatedAt: now}
	for _, item := range []any{&row, &one, &two, &task} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	request := CanvasProductionTaskRequest{TaskID: task.ID, UnitID: unit.ID, ShotID: shot.ID, ShotRevisionID: shot.CurrentRevisionID, StepKey: "storyboard"}
	if _, err := svc.RegisterCanvasProductionTask("user-1", project.ID, row.ID, request); err == nil {
		t.Fatal("multi-output silently selected first")
	}
	request.ResourceID = two.ID
	result, err := svc.RegisterCanvasProductionTask("user-1", project.ID, row.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.ResourceID != two.ID {
		t.Fatal("wrong selected resource")
	}
	request.ResourceID = one.ID
	if _, err := svc.RegisterCanvasProductionTask("user-1", project.ID, row.ID, request); err == nil {
		t.Fatal("retry replaced originally associated resource")
	}
	assertWorkflowOutputCounts(t, db, task.ID, 1)
}
