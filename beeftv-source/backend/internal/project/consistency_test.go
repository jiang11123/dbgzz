package project

import (
	"errors"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

func seedUnitWorkflow(t *testing.T, svc *Service, projectID, unitID string) WorkflowDetail {
	t.Helper()
	if err := svc.EnsureBuiltinTemplate(); err != nil {
		t.Fatal(err)
	}
	workflow, err := svc.CreateUnitWorkflow("user-1", projectID, unitID)
	if err != nil {
		t.Fatal(err)
	}
	return workflow
}

func workflowStepByKey(t *testing.T, workflow WorkflowDetail, key string) model.WorkflowStepInstance {
	t.Helper()
	for _, step := range workflow.Steps {
		if step.StepKey == key {
			return step
		}
	}
	t.Fatalf("missing workflow step %s", key)
	return model.WorkflowStepInstance{}
}

func createSucceededTask(t *testing.T, db *gorm.DB, taskID, resourceID, projectID, kind string) (model.Task, model.Resource) {
	t.Helper()
	now := time.Now()
	resource := model.Resource{ID: resourceID, UserID: "user-1", Kind: kind, Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 1024, CreatedAt: now, UpdatedAt: now}
	if kind == "image" {
		resource.MimeType = "image/png"
	}
	task := model.Task{ID: taskID, UserID: "user-1", ProjectID: projectID, Type: "canvas_" + kind, Status: model.TaskStatusSucceeded, ResultJSON: `{"ok":true}`, CreatedAt: now, UpdatedAt: now}
	for _, item := range []any{&resource, &task} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	return task, resource
}

func registerShotOutput(t *testing.T, svc *Service, projectID, stepID, taskID, unitID, shotID, revisionID, artifactType, resourceID string) model.WorkflowStepInstance {
	t.Helper()
	step, err := svc.RegisterTaskOutput("user-1", projectID, stepID, RegisterTaskOutputRequest{
		TaskID: taskID, UnitID: unitID, ShotID: shotID, ShotRevisionID: revisionID,
		ArtifactType: artifactType, ResourceID: resourceID, MediaType: "video",
	})
	if err != nil {
		t.Fatal(err)
	}
	return step
}

func TestTwoShotTaskOutputsOutOfOrderKeepRunningAndMonotonicRevision(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	workflow := seedUnitWorkflow(t, svc, project.ID, unit.ID)
	video := workflowStepByKey(t, workflow, "video")
	first, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "先写的镜头", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.02", Description: "后写的镜头", DurationMs: 3000, Position: 1})
	if err != nil {
		t.Fatal(err)
	}
	taskB, resourceB := createSucceededTask(t, db, "task-b", "resource-b", project.ID, "video")
	taskA, resourceA := createSucceededTask(t, db, "task-a", "resource-a", project.ID, "video")
	var before model.WorkflowInstance
	if err := db.First(&before, "id = ?", workflow.Instance.ID).Error; err != nil {
		t.Fatal(err)
	}
	registerShotOutput(t, svc, project.ID, video.ID, taskB.ID, unit.ID, second.ID, second.CurrentRevisionID, "video", resourceB.ID)
	var afterFirst model.WorkflowInstance
	if err := db.First(&afterFirst, "id = ?", workflow.Instance.ID).Error; err != nil {
		t.Fatal(err)
	}
	registerShotOutput(t, svc, project.ID, video.ID, taskA.ID, unit.ID, first.ID, first.CurrentRevisionID, "video", resourceA.ID)
	stored, err := svc.repo.WorkflowStepForProject(project.ID, video.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.WorkflowStepStatusRunning {
		t.Fatalf("video step = %s, want running", stored.Status)
	}
	var instance model.WorkflowInstance
	if err := db.First(&instance, "id = ?", workflow.Instance.ID).Error; err != nil {
		t.Fatal(err)
	}
	if afterFirst.Revision != before.Revision+1 || instance.Revision != before.Revision+2 {
		t.Fatalf("instance revision before=%d afterFirst=%d afterSecond=%d, want monotonic +1 twice", before.Revision, afterFirst.Revision, instance.Revision)
	}
	var artifacts []model.ShotArtifact
	if err := db.Where("project_id = ? AND type = ?", project.ID, "video").Order("shot_id asc").Find(&artifacts).Error; err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 2 {
		t.Fatalf("artifacts = %d, want 2", len(artifacts))
	}
	for _, artifact := range artifacts {
		if !artifact.Selected || artifact.Status != "ready" {
			t.Fatalf("artifact %+v should be selected ready", artifact)
		}
	}
}

func TestSameTaskRetryAfterLaterStepStateDoesNotRegress(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	workflow := seedUnitWorkflow(t, svc, project.ID, unit.ID)
	video := workflowStepByKey(t, workflow, "video")
	shot, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "人物抬头", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	task, resource := createSucceededTask(t, db, "task-1", "resource-1", project.ID, "video")
	registerShotOutput(t, svc, project.ID, video.ID, task.ID, unit.ID, shot.ID, shot.CurrentRevisionID, "video", resource.ID)
	now := time.Now()
	if err := db.Model(&model.WorkflowStepInstance{}).Where("id = ?", video.ID).Updates(map[string]any{
		"status": model.WorkflowStepStatusCompleted, "updated_at": now, "completed_at": now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.WorkflowInstance{}).Where("id = ?", workflow.Instance.ID).Update("revision", 9).Error; err != nil {
		t.Fatal(err)
	}
	var projectBefore model.Project
	if err := db.First(&projectBefore, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	retried := registerShotOutput(t, svc, project.ID, video.ID, task.ID, unit.ID, shot.ID, shot.CurrentRevisionID, "video", resource.ID)
	if retried.Status != model.WorkflowStepStatusCompleted {
		t.Fatalf("retry status = %s, want completed", retried.Status)
	}
	var instance model.WorkflowInstance
	if err := db.First(&instance, "id = ?", workflow.Instance.ID).Error; err != nil {
		t.Fatal(err)
	}
	if instance.Revision != 9 {
		t.Fatalf("instance revision = %d, want 9", instance.Revision)
	}
	var projectAfter model.Project
	if err := db.First(&projectAfter, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if projectAfter.Revision != projectBefore.Revision {
		t.Fatalf("project revision bumped on same-task retry: %d -> %d", projectBefore.Revision, projectAfter.Revision)
	}
}

func TestRegisterTaskOutputRollsBackMissingLinkWhenArtifactInsertFails(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	workflow := seedUnitWorkflow(t, svc, project.ID, unit.ID)
	video := workflowStepByKey(t, workflow, "video")
	shot, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "人物抬头", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	task, resource := createSucceededTask(t, db, "task-1", "resource-1", project.ID, "video")
	if err := db.Exec("CREATE TRIGGER fail_shot_artifacts BEFORE INSERT ON shot_artifacts BEGIN SELECT RAISE(ABORT, 'forced artifact insert failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RegisterTaskOutput("user-1", project.ID, video.ID, RegisterTaskOutputRequest{
		TaskID: task.ID, UnitID: unit.ID, ShotID: shot.ID, ShotRevisionID: shot.CurrentRevisionID,
		ArtifactType: "video", ResourceID: resource.ID, MediaType: "video",
	}); err == nil {
		t.Fatal("register succeeded after injected artifact failure")
	}
	for _, check := range []struct {
		table string
		where string
		value string
	}{
		{table: "workflow_step_tasks", where: "task_id = ?", value: task.ID},
		{table: "production_task_links", where: "task_id = ?", value: task.ID},
		{table: "shot_artifacts", where: "task_id = ?", value: task.ID},
	} {
		var count int64
		if err := db.Table(check.table).Where(check.where, check.value).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("%s count = %d, error = %v", check.table, count, err)
		}
	}
	stored, err := svc.repo.WorkflowStepForProject(project.ID, video.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.WorkflowStepStatusPending {
		t.Fatalf("step status = %s, want pending after rollback", stored.Status)
	}
}

func TestShotEditedWhileOutputArrivesIsHistoricalAndFailsReadinessGate(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	workflow := seedUnitWorkflow(t, svc, project.ID, unit.ID)
	previz := workflowStepByKey(t, workflow, "previz")
	shot, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "原画面", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	oldRevisionID := shot.CurrentRevisionID
	if _, _, err := svc.CreateShotRevision("user-1", project.ID, shot.ID, ShotRevisionInput{PlotDescription: "改过的画面", DurationMs: 3000}); err != nil {
		t.Fatal(err)
	}
	task, resource := createSucceededTask(t, db, "task-previz", "resource-previz", project.ID, "image")
	registerShotOutput(t, svc, project.ID, previz.ID, task.ID, unit.ID, shot.ID, oldRevisionID, "action_board", resource.ID)
	var artifact model.ShotArtifact
	if err := db.First(&artifact, "task_id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if artifact.Selected || artifact.Status != "stale" || artifact.RevisionID != oldRevisionID {
		t.Fatalf("stale output = selected=%v status=%s revision=%s", artifact.Selected, artifact.Status, artifact.RevisionID)
	}
	if err := db.Model(&model.WorkflowStepInstance{}).Where("id = ?", previz.ID).Update("status", model.WorkflowStepStatusRunning).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateWorkflowStep("user-1", project.ID, previz.ID, UpdateWorkflowStepRequest{Status: string(model.WorkflowStepStatusCompleted)}); err == nil {
		t.Fatal("completed previz with only historical artifact")
	}
}

func TestShotDeletedWhileOutputArrivesDoesNotResurrect(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	workflow := seedUnitWorkflow(t, svc, project.ID, unit.ID)
	video := workflowStepByKey(t, workflow, "video")
	shot, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "将被删除", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	task, resource := createSucceededTask(t, db, "task-del", "resource-del", project.ID, "video")
	now := time.Now()
	link := &model.WorkflowStepTask{ID: kernel.NewID(), WorkflowStepID: video.ID, TaskID: task.ID, CreatedAt: now}
	production := &model.ProductionTaskLink{ID: kernel.NewID(), TaskID: task.ID, ProjectID: project.ID, UnitID: unit.ID, ShotID: shot.ID, WorkflowStepID: video.ID, ArtifactType: "video", CreatedAt: now, UpdatedAt: now}
	if err := svc.DeleteProjectShot("user-1", project.ID, shot.ID); err != nil {
		t.Fatal(err)
	}
	_, err = svc.repo.RegisterWorkflowTaskOutputActive("user-1", project.ID, video.ID, shot.ID, shot.CurrentRevisionID, unit.ID, repository.WorkflowTaskOutputRecords{Link: link, ProductionLink: production}, func(current repository.WorkflowOutputCurrent) (repository.WorkflowOutputPlan, error) {
		return planRegisteredTaskOutput(now, task.ID, "{}", "{}", resource.ID, "video", shot.CurrentRevisionID, current)
	})
	if !IsNotFound(err) {
		t.Fatalf("deleted shot output = %v, want not found", err)
	}
	var shotCount, artifactCount, linkCount int64
	if err := db.Model(&model.Shot{}).Where("id = ?", shot.ID).Count(&shotCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ShotArtifact{}).Where("shot_id = ?", shot.ID).Count(&artifactCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.WorkflowStepTask{}).Where("task_id = ?", task.ID).Count(&linkCount).Error; err != nil {
		t.Fatal(err)
	}
	if shotCount != 0 || artifactCount != 0 || linkCount != 0 {
		t.Fatalf("resurrected rows shot=%d artifact=%d link=%d", shotCount, artifactCount, linkCount)
	}
	if _, err := svc.RegisterTaskOutput("user-1", project.ID, video.ID, RegisterTaskOutputRequest{
		TaskID: task.ID, UnitID: unit.ID, ShotID: shot.ID, ShotRevisionID: shot.CurrentRevisionID,
		ArtifactType: "video", ResourceID: resource.ID, MediaType: "video",
	}); !IsNotFound(err) {
		t.Fatalf("domain register after delete = %v, want not found", err)
	}
}

func TestEmptyShotPointerStillCAS(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	now := time.Now()
	shot := model.Shot{ID: "shot-empty", ProjectID: project.ID, UnitID: unit.ID, Title: "空指针", Description: "待写入", Status: "draft", CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&shot).Error; err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for _, plot := range []string{"甲写入", "乙写入"} {
		workers.Add(1)
		go func(plot string) {
			defer workers.Done()
			at := time.Now()
			next := shot
			next.Description = plot
			next.UpdatedAt = at
			revision := model.ShotRevision{ID: kernel.NewID(), ShotID: shot.ID, PlotDescription: plot, DurationMs: 3000, CreatedBy: "user-1", CreatedAt: at}
			<-start
			results <- svc.repo.SaveShotWithRevisionActive("user-1", &next, &revision, false, "")
		}(plot)
	}
	close(start)
	workers.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, repository.ErrProjectRevisionConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
}

func TestEmptyCharacterPointerStillCAS(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	now := time.Now()
	asset := model.Asset{ID: "asset-empty", UserID: "user-1", Kind: "entity", Category: model.AssetCategoryCharacter, Status: model.AssetVersionStatusDraft, Title: "未定主版本", PayloadJSON: "{}", CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for index, name := range []string{"角色甲", "角色乙"} {
		workers.Add(1)
		go func(index int, name string) {
			defer workers.Done()
			at := time.Now()
			nextID := kernel.NewID()
			next := asset
			next.Title = name
			next.PrimaryVersionID = nextID
			next.UpdatedAt = at
			version := model.AssetVersion{ID: nextID, AssetID: asset.ID, Version: index + 1, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: `{"role":"主角"}`, CreatedAt: at, UpdatedAt: at}
			<-start
			results <- svc.repo.SaveCharacterVersionActive("user-1", project.ID, "", &next, &version, nil, nil)
		}(index, name)
	}
	close(start)
	workers.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, repository.ErrProjectRevisionConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
}

func TestSaveShotRechecksUnitInsideTransaction(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	now := time.Now()
	shot := model.Shot{ID: kernel.NewID(), ProjectID: project.ID, UnitID: unit.ID, Title: "迟到镜头", Description: "画面", Status: "draft", CreatedAt: now, UpdatedAt: now}
	revision := model.ShotRevision{ID: kernel.NewID(), ShotID: shot.ID, PlotDescription: "画面", DurationMs: 1000, CreatedAt: now}
	if err := svc.DeleteProjectUnit("user-1", project.ID, unit.ID); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.SaveShotWithRevisionActive("user-1", &shot, &revision, true, ""); !IsNotFound(err) {
		t.Fatalf("save shot after unit delete = %v, want not found", err)
	}
	var shotCount int64
	if err := db.Model(&model.Shot{}).Where("id = ?", shot.ID).Count(&shotCount).Error; err != nil {
		t.Fatal(err)
	}
	if shotCount != 0 {
		t.Fatalf("shot count = %d, want 0", shotCount)
	}
}

func TestReplaceShotsRechecksUnitAndVersionInsideTransaction(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	now := time.Now()
	asset := model.Asset{ID: "asset-1", UserID: "user-1", Kind: "image", Category: model.AssetCategory("prop"), Status: model.AssetVersionStatus("ready"), PrimaryVersionID: "version-1", Title: "道具", CreatedAt: now, UpdatedAt: now}
	version := model.AssetVersion{ID: "version-1", AssetID: asset.ID, Version: 1, Status: model.AssetVersionStatus("ready"), CreatedAt: now, UpdatedAt: now}
	link := model.ProjectAssetLink{ID: "link-1", ProjectID: project.ID, AssetID: asset.ID, CreatedAt: now}
	for _, item := range []any{&asset, &version, &link} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	created, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            []ReplaceProjectUnitShotInput{{CreateProjectShotRequest: CreateProjectShotRequest{Title: "SC.01", Description: "原分镜", DurationMs: 3000}, AssetVersionIDs: []string{version.ID}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	owned, err := svc.Owned("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	nextShotID := kernel.NewID()
	nextRevisionID := kernel.NewID()
	nextShots := []model.Shot{{ID: nextShotID, ProjectID: project.ID, UnitID: unit.ID, CurrentRevisionID: nextRevisionID, Title: "SC.02", Description: "替换", Position: 0, DurationMs: 3000, Status: "draft", CreatedAt: now, UpdatedAt: now}}
	nextRevisions := []model.ShotRevision{{ID: nextRevisionID, ShotID: nextShotID, Version: 1, PlotDescription: "替换", DurationMs: 3000, CreatedAt: now}}
	nextRefs := []model.ShotAssetReference{{ID: kernel.NewID(), ShotID: nextShotID, AssetVersionID: version.ID, Role: "reference", Status: "linked", CreatedAt: now}}
	pointers := map[string]string{created[0].ID: created[0].CurrentRevisionID}
	if err := db.Delete(&model.ProjectAssetLink{}, "id = ?", link.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.ReplaceProjectUnitShotsActive("user-1", project.ID, unit.ID, nextShots, nextRevisions, nextRefs, []string{created[0].ID}, pointers, owned.Revision); !IsNotFound(err) {
		t.Fatalf("replace after version unlink = %v, want not found", err)
	}
	var stored model.Shot
	if err := db.First(&stored, "id = ?", created[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Title != "SC.01" {
		t.Fatalf("title = %s, want original SC.01", stored.Title)
	}
	if err := svc.DeleteProjectUnit("user-1", project.ID, unit.ID); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.ReplaceProjectUnitShotsActive("user-1", project.ID, unit.ID, nextShots, nextRevisions, nil, []string{}, map[string]string{}, owned.Revision); !IsNotFound(err) {
		t.Fatalf("replace after unit delete = %v, want not found", err)
	}
	var resurrected int64
	if err := db.Model(&model.Shot{}).Where("id = ?", nextShotID).Count(&resurrected).Error; err != nil {
		t.Fatal(err)
	}
	if resurrected != 0 {
		t.Fatalf("replaced shots resurrected deleted unit, count=%d", resurrected)
	}
}

func TestReplaceShotsRejectsInPlaceEditWithCapturedRevision(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	created, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            []ReplaceProjectUnitShotInput{{CreateProjectShotRequest: CreateProjectShotRequest{Title: "SC.01", Description: "原画面", DurationMs: 3000}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	owned, err := svc.Owned("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.CreateShotRevision("user-1", project.ID, created[0].ID, ShotRevisionInput{PlotDescription: "人工改过的画面", DurationMs: 3500}); err != nil {
		t.Fatal(err)
	}
	_, err = svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{created[0].ID},
		ExpectedRevision: owned.Revision,
		Shots:            []ReplaceProjectUnitShotInput{{CreateProjectShotRequest: CreateProjectShotRequest{Title: "SC.99", Description: "整章覆盖", DurationMs: 3000}}},
	})
	if err == nil {
		t.Fatal("in-place edit was erased by id-only replace")
	}
	if !IsConflict(err) && err.Error() != "本章分镜已发生变化，请刷新后重新确认" {
		t.Fatalf("in-place replace conflict = %v", err)
	}
	var stored model.Shot
	if err := db.First(&stored, "id = ?", created[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Description != "人工改过的画面" {
		t.Fatalf("description = %q, want 人工改过的画面", stored.Description)
	}
}

func TestReplaceShotsPreflightToTxPointerSnapshot(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	created, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            []ReplaceProjectUnitShotInput{{CreateProjectShotRequest: CreateProjectShotRequest{Title: "SC.01", Description: "原画面", DurationMs: 3000}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	owned, err := svc.Owned("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{created[0].ID}
	pointers := map[string]string{created[0].ID: created[0].CurrentRevisionID}
	expectedRevision := owned.Revision
	if _, _, err := svc.CreateShotRevision("user-1", project.ID, created[0].ID, ShotRevisionInput{PlotDescription: "并发改镜头", DurationMs: 3000}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	nextShotID := kernel.NewID()
	nextRevisionID := kernel.NewID()
	nextShots := []model.Shot{{ID: nextShotID, ProjectID: project.ID, UnitID: unit.ID, CurrentRevisionID: nextRevisionID, Title: "SC.02", Description: "覆盖并发", Status: "draft", DurationMs: 3000, CreatedAt: now, UpdatedAt: now}}
	nextRevisions := []model.ShotRevision{{ID: nextRevisionID, ShotID: nextShotID, Version: 1, PlotDescription: "覆盖并发", DurationMs: 3000, CreatedAt: now}}
	err = svc.repo.ReplaceProjectUnitShotsActive("user-1", project.ID, unit.ID, nextShots, nextRevisions, nil, ids, pointers, expectedRevision)
	if !errors.Is(err, repository.ErrProjectUnitShotsChanged) && !errors.Is(err, repository.ErrProjectRevisionConflict) {
		t.Fatalf("preflight-to-tx replace = %v, want shots changed or revision conflict", err)
	}
	var stored model.Shot
	if err := db.First(&stored, "id = ?", created[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Description != "并发改镜头" {
		t.Fatalf("description = %q, want 并发改镜头", stored.Description)
	}
}

func TestMatchingShotIDsDoNotHideInPlaceContentChange(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	created, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            []ReplaceProjectUnitShotInput{{CreateProjectShotRequest: CreateProjectShotRequest{Title: "SC.01", Description: "原画面", DurationMs: 3000}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.CreateShotRevision("user-1", project.ID, created[0].ID, ShotRevisionInput{PlotDescription: "内容已变", DurationMs: 3000}); err != nil {
		t.Fatal(err)
	}
	owned, err := svc.Owned("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	nextShotID := kernel.NewID()
	nextRevisionID := kernel.NewID()
	nextShots := []model.Shot{{ID: nextShotID, ProjectID: project.ID, UnitID: unit.ID, CurrentRevisionID: nextRevisionID, Title: "SC.02", Description: "用 ID 假装没变", Status: "draft", DurationMs: 3000, CreatedAt: now, UpdatedAt: now}}
	nextRevisions := []model.ShotRevision{{ID: nextRevisionID, ShotID: nextShotID, Version: 1, PlotDescription: "用 ID 假装没变", DurationMs: 3000, CreatedAt: now}}
	err = svc.repo.ReplaceProjectUnitShotsActive("user-1", project.ID, unit.ID, nextShots, nextRevisions, nil, []string{created[0].ID}, map[string]string{created[0].ID: created[0].CurrentRevisionID}, owned.Revision)
	if !errors.Is(err, repository.ErrProjectUnitShotsChanged) {
		t.Fatalf("id-only content change = %v, want shots changed", err)
	}
}

func TestStaleClientSameShotIDsChangedContentDoesNotMutate(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	created, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            []ReplaceProjectUnitShotInput{{CreateProjectShotRequest: CreateProjectShotRequest{Title: "SC.01", Description: "批准时的画面", DurationMs: 3000}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	approvedRevision := ownedRevision(t, svc, project.ID)
	if _, _, err := svc.CreateShotRevision("user-1", project.ID, created[0].ID, ShotRevisionInput{PlotDescription: "镜头已改内容", DurationMs: 3200}); err != nil {
		t.Fatal(err)
	}
	overwrite := []ReplaceProjectUnitShotInput{{CreateProjectShotRequest: CreateProjectShotRequest{Title: "SC.99", Description: "过期客户端整章覆盖", DurationMs: 3000}}}
	_, err = svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs: []string{created[0].ID},
		Shots:           overwrite,
	})
	if err == nil || err.Error() != "请刷新后再保存分镜" {
		t.Fatalf("missing expectedRevision = %v, want 请刷新后再保存分镜", err)
	}
	_, err = svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{created[0].ID},
		ExpectedRevision: 0,
		Shots:            overwrite,
	})
	if err == nil || err.Error() != "请刷新后再保存分镜" {
		t.Fatalf("zero expectedRevision = %v, want 请刷新后再保存分镜", err)
	}
	_, err = svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{created[0].ID},
		ExpectedRevision: approvedRevision,
		Shots:            overwrite,
	})
	if err == nil {
		t.Fatal("stale client with same IDs overwrote changed content")
	}
	if !IsConflict(err) && err.Error() != "本章分镜已发生变化，请刷新后重新确认" {
		t.Fatalf("stale same-id replace = %v", err)
	}
	var stored model.Shot
	if err := db.First(&stored, "id = ?", created[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Description != "镜头已改内容" {
		t.Fatalf("description = %q, want 镜头已改内容", stored.Description)
	}
	if ownedRevision(t, svc, project.ID) <= approvedRevision {
		t.Fatalf("in-place edit should have bumped project revision")
	}
}

func TestUpdateWorkflowStepRechecksStoryGateInsideTransaction(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	workflow := seedUnitWorkflow(t, svc, project.ID, unit.ID)
	story := workflowStepByKey(t, workflow, "story")
	if _, err := svc.UpdateWorkflowStep("user-1", project.ID, story.ID, UpdateWorkflowStepRequest{Status: string(model.WorkflowStepStatusRunning)}); err != nil {
		t.Fatal(err)
	}
	expectedRevision := ownedRevision(t, svc, project.ID)
	if err := db.Model(&model.ProjectUnit{}).Where("id = ?", unit.ID).Update("source_text", "").Error; err != nil {
		t.Fatal(err)
	}
	_, err := svc.repo.UpdateWorkflowProgressActive("user-1", project.ID, story.ID, expectedRevision, func(current repository.WorkflowProgressCurrent) (repository.WorkflowProgressPlan, error) {
		return planWorkflowStepUpdate(time.Now(), UpdateWorkflowStepRequest{Status: string(model.WorkflowStepStatusCompleted)}, current)
	})
	if err == nil || err.Error() != "章节正文为空，不能完成剧情阶段" {
		t.Fatalf("story gate after silent source clear = %v", err)
	}
	stored, err := svc.repo.WorkflowStepForProject(project.ID, story.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.WorkflowStepStatusRunning {
		t.Fatalf("step status = %s, want running", stored.Status)
	}
	if ownedRevision(t, svc, project.ID) != expectedRevision {
		t.Fatalf("project revision mutated after rejected completion")
	}
}

func TestUpdateWorkflowStepRechecksSelectedArtifactsInsideTransaction(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	workflow := seedUnitWorkflow(t, svc, project.ID, unit.ID)
	previz := workflowStepByKey(t, workflow, "previz")
	shot, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "人物抬头", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	task, resource := createSucceededTask(t, db, "task-previz-gate", "resource-previz-gate", project.ID, "image")
	registerShotOutput(t, svc, project.ID, previz.ID, task.ID, unit.ID, shot.ID, shot.CurrentRevisionID, "action_board", resource.ID)
	expectedRevision := ownedRevision(t, svc, project.ID)
	if err := db.Model(&model.ShotArtifact{}).Where("task_id = ?", task.ID).Updates(map[string]any{"selected": false, "status": "stale"}).Error; err != nil {
		t.Fatal(err)
	}
	_, err = svc.repo.UpdateWorkflowProgressActive("user-1", project.ID, previz.ID, expectedRevision, func(current repository.WorkflowProgressCurrent) (repository.WorkflowProgressPlan, error) {
		return planWorkflowStepUpdate(time.Now(), UpdateWorkflowStepRequest{Status: string(model.WorkflowStepStatusCompleted)}, current)
	})
	if err == nil || err.Error() != "仍有镜头缺少已通过的动作预演，不能完成本阶段" {
		t.Fatalf("artifact gate after silent unselect = %v", err)
	}
	stored, err := svc.repo.WorkflowStepForProject(project.ID, previz.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.WorkflowStepStatusRunning {
		t.Fatalf("previz status = %s, want running", stored.Status)
	}
	if ownedRevision(t, svc, project.ID) != expectedRevision {
		t.Fatalf("project revision mutated after rejected previz completion")
	}
}
