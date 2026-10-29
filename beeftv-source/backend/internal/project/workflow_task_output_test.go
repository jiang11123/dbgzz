package project

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func TestCanonicalTaskOutputResourceWalksNestedResultJSON(t *testing.T) {
	id, mediaType := CanonicalTaskOutputResource(
		`{"mode":"video","outputs":[{"video":{"url":"https://local/api/resources/resource-nested-1/file?download=1"}}]}`,
		"canvas_video",
	)
	if id != "resource-nested-1" || mediaType != "video" {
		t.Fatalf("nested file URL resource = %q %q", id, mediaType)
	}
	id, mediaType = CanonicalTaskOutputResource(
		`{"mode":"video","video":{"resourceId":"ignored","storageKey":"resource:resource-storage-1"}}`,
		"canvas_video",
	)
	if id != "resource-storage-1" || mediaType != "video" {
		t.Fatalf("storageKey resource = %q %q", id, mediaType)
	}
}

func TestRegisterTaskOutputFromTaskUsesNestedMetadataAndCanonicalResource(t *testing.T) {
	svc, db := newTestService(t, nil)
	project, unit, video, shot := seedWorkflowOutputFixture(t, svc, db)
	now := time.Now()
	resource := model.Resource{ID: "resource-nested-1", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 2048, CreatedAt: now, UpdatedAt: now}
	input, err := json.Marshal(map[string]any{
		"prompt": "nested",
		"metadata": map[string]any{
			"workflowStepId":  video.ID,
			"domainProjectId": project.ID,
			"unitId":          unit.ID,
			"shotId":          shot.ID,
			"shotRevisionId":  shot.CurrentRevisionID,
			"artifactType":    "video",
			"role":            "output",
			"artifactMetadata": map[string]any{
				"model": "MiniMax-H3",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-nested-1", UserID: "user-1", ProjectID: project.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		Prompt: "nested", InputJSON: "encrypted-not-used", ResultJSON: `{"mode":"video","outputs":[{"clip":{"storageKey":"resource:resource-nested-1"}}]}`,
		CreatedAt: now, UpdatedAt: now,
	}
	for _, item := range []any{&resource, &task} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.RegisterTaskOutputFromTask(task, string(input)); err != nil {
		t.Fatal(err)
	}
	assertWorkflowOutputCounts(t, db, task.ID, 1)
	var artifact model.ShotArtifact
	if err := db.First(&artifact, "task_id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if artifact.ResourceID != resource.ID || artifact.MetadataJSON != `{"model":"MiniMax-H3"}` {
		t.Fatalf("artifact = %+v", artifact)
	}
	assetID := GeneratedEntityID("asset", task.ID)
	versionID := GeneratedEntityID("version", task.ID)
	var asset model.Asset
	if err := db.First(&asset, "id = ?", assetID).Error; err != nil {
		t.Fatal(err)
	}
	if asset.PrimaryVersionID != versionID {
		t.Fatalf("primary version = %q, want %q", asset.PrimaryVersionID, versionID)
	}
}

func TestRegisterTaskOutputFromTaskKeepsTopLevelOverMetadata(t *testing.T) {
	svc, db := newTestService(t, nil)
	project, unit, video, shot := seedWorkflowOutputFixture(t, svc, db)
	now := time.Now()
	owned := model.Resource{ID: "resource-owned", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 512, CreatedAt: now, UpdatedAt: now}
	foreign := model.Resource{ID: "resource-foreign-meta", UserID: "user-2", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 512, CreatedAt: now, UpdatedAt: now}
	input, err := json.Marshal(map[string]any{
		"workflowStepId":  video.ID,
		"domainProjectId": project.ID,
		"unitId":          unit.ID,
		"shotId":          shot.ID,
		"resourceId":      owned.ID,
		"mediaType":       "video",
		"artifactType":    "video",
		"metadata": map[string]any{
			"workflowStepId": "missing-step",
			"resourceId":     foreign.ID,
			"shotId":         "missing-shot",
			"artifactMetadata": map[string]any{
				"model": "should-win",
			},
		},
		"metadataJson": `{"model":"top-level"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-precedence-1", UserID: "user-1", ProjectID: project.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"video":{"storageKey":"resource:resource-foreign-meta"}}`, CreatedAt: now, UpdatedAt: now,
	}
	for _, item := range []any{&owned, &foreign, &task} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.RegisterTaskOutputFromTask(task, string(input)); err != nil {
		t.Fatal(err)
	}
	var artifact model.ShotArtifact
	if err := db.First(&artifact, "task_id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if artifact.ResourceID != owned.ID {
		t.Fatalf("resource = %q, want top-level %q", artifact.ResourceID, owned.ID)
	}
	if artifact.MetadataJSON != `{"model":"top-level"}` {
		t.Fatalf("metadata = %q, want top-level JSON", artifact.MetadataJSON)
	}
}

func TestRegisterTaskOutputFromTaskRejectsForeignProjectAndResource(t *testing.T) {
	svc, db := newTestService(t, nil)
	project, unit, video, shot := seedWorkflowOutputFixture(t, svc, db)
	foreignProject := seedProject(t, db, model.Project{ID: "project-foreign", UserID: "user-2", Name: "别人的项目"})
	now := time.Now()
	ownedResource := model.Resource{ID: "resource-owned", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 512, CreatedAt: now, UpdatedAt: now}
	foreignResource := model.Resource{ID: "resource-foreign", UserID: "user-2", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 512, CreatedAt: now, UpdatedAt: now}
	for _, item := range []any{&ownedResource, &foreignResource} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}

	foreignProjectTask := model.Task{
		ID: "task-foreign-project", UserID: "user-1", ProjectID: project.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"video":{"storageKey":"resource:resource-owned"}}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&foreignProjectTask).Error; err != nil {
		t.Fatal(err)
	}
	foreignProjectInput, err := json.Marshal(map[string]any{
		"metadata": map[string]any{
			"workflowStepId": video.ID, "domainProjectId": foreignProject.ID,
			"unitId": unit.ID, "shotId": shot.ID, "artifactType": "video",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterTaskOutputFromTask(foreignProjectTask, string(foreignProjectInput)); !IsNotFound(err) {
		t.Fatalf("foreign project = %v, want not found", err)
	}
	assertWorkflowOutputCounts(t, db, foreignProjectTask.ID, 0)

	foreignResourceTask := model.Task{
		ID: "task-foreign-resource", UserID: "user-1", ProjectID: project.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"video":{"storageKey":"resource:resource-foreign"}}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&foreignResourceTask).Error; err != nil {
		t.Fatal(err)
	}
	foreignResourceInput, err := json.Marshal(map[string]any{
		"metadata": map[string]any{
			"workflowStepId": video.ID, "domainProjectId": project.ID,
			"unitId": unit.ID, "shotId": shot.ID, "artifactType": "video",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterTaskOutputFromTask(foreignResourceTask, string(foreignResourceInput)); !errors.Is(err, gorm.ErrRecordNotFound) && !IsNotFound(err) {
		t.Fatalf("foreign resource = %v, want not found", err)
	}
	assertWorkflowOutputCounts(t, db, foreignResourceTask.ID, 0)
}

func TestRegisterTaskOutputFromTaskIsIdempotentForTheSameTask(t *testing.T) {
	svc, db := newTestService(t, nil)
	project, unit, video, shot := seedWorkflowOutputFixture(t, svc, db)
	now := time.Now()
	resource := model.Resource{ID: "resource-idempotent", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 1024, CreatedAt: now, UpdatedAt: now}
	input, err := json.Marshal(map[string]any{
		"metadata": map[string]any{
			"workflowStepId": video.ID, "domainProjectId": project.ID,
			"unitId": unit.ID, "shotId": shot.ID, "shotRevisionId": shot.CurrentRevisionID,
			"artifactType": "video", "role": "output",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "ac745990450a86d3365eb92ec26f378e", UserID: "user-1", ProjectID: project.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		Prompt: "人物抬头", ResultJSON: `{"mode":"video","video":{"storageKey":"resource:resource-idempotent"}}`,
		CreatedAt: now, UpdatedAt: now,
	}
	for _, item := range []any{&resource, &task} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.RegisterTaskOutputFromTask(task, string(input)); err != nil {
		t.Fatal(err)
	}
	var instanceAfterFirst model.WorkflowInstance
	if err := db.First(&instanceAfterFirst, "project_id = ? AND unit_id = ?", project.ID, unit.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterTaskOutputFromTask(task, string(input)); err != nil {
		t.Fatal(err)
	}
	assertWorkflowOutputCounts(t, db, task.ID, 1)
	var instanceAfterRetry model.WorkflowInstance
	if err := db.First(&instanceAfterRetry, "id = ?", instanceAfterFirst.ID).Error; err != nil {
		t.Fatal(err)
	}
	if instanceAfterRetry.Revision != instanceAfterFirst.Revision {
		t.Fatalf("retry revision = %d, want %d", instanceAfterRetry.Revision, instanceAfterFirst.Revision)
	}
	assetID := GeneratedEntityID("asset", task.ID)
	var count int64
	if err := db.Table("assets").Where("id = ?", assetID).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("deterministic asset count = %d, err = %v", count, err)
	}
}

func TestRegisterTaskOutputFromTaskFallsBackToOwnedTaskProject(t *testing.T) {
	svc, db := newTestService(t, nil)
	project, unit, video, shot := seedWorkflowOutputFixture(t, svc, db)
	now := time.Now()
	resource := model.Resource{ID: "resource-fallback", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 256, CreatedAt: now, UpdatedAt: now}
	input, err := json.Marshal(map[string]any{
		"workflowStepId": video.ID,
		"unitId":         unit.ID,
		"shotId":         shot.ID,
		"artifactType":   "video",
	})
	if err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-fallback-1", UserID: "user-1", ProjectID: project.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"video":{"storageKey":"resource:resource-fallback"}}`, CreatedAt: now, UpdatedAt: now,
	}
	for _, item := range []any{&resource, &task} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.RegisterTaskOutputFromTask(task, string(input)); err != nil {
		t.Fatal(err)
	}
	assertWorkflowOutputCounts(t, db, task.ID, 1)
}

func TestRegisterTaskOutputFromTaskRequiresBusinessProjectWhenTaskScopeIsCanvas(t *testing.T) {
	svc, db := newTestService(t, nil)
	now := time.Now()
	canvas := model.CanvasProject{ID: "canvas-scope-1", UserID: "user-1", Title: "探索", CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-canvas-scope", UserID: "user-1", ProjectID: canvas.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ResultJSON: `{}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	err := svc.RegisterTaskOutputFromTask(task, `{"workflowStepId":"step-1"}`)
	if err == nil || err.Error() != "任务未提供短剧项目 ID，无法登记产物" {
		t.Fatalf("canvas scope = %v", err)
	}
}

func seedWorkflowOutputFixture(t *testing.T, svc *Service, db *gorm.DB) (model.Project, model.ProjectUnit, model.WorkflowStepInstance, model.Shot) {
	t.Helper()
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	workflow := seedUnitWorkflow(t, svc, project.ID, unit.ID)
	video := workflowStepByKey(t, workflow, "video")
	shot, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "人物抬头", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	return project, unit, video, shot
}

func assertWorkflowOutputCounts(t *testing.T, db *gorm.DB, taskID string, want int64) {
	t.Helper()
	for _, check := range []struct {
		table string
		where string
	}{
		{table: "workflow_step_tasks", where: "task_id = ?"},
		{table: "production_task_links", where: "task_id = ?"},
		{table: "shot_artifacts", where: "task_id = ?"},
	} {
		var count int64
		if err := db.Table(check.table).Where(check.where, taskID).Count(&count).Error; err != nil || count != want {
			t.Fatalf("%s count = %d, want %d, err = %v", check.table, count, want, err)
		}
	}
}
