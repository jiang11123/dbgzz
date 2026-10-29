package project

import (
	"errors"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func seedChapter(t *testing.T, svc *Service, projectID string) model.ProjectUnit {
	t.Helper()
	unit, err := svc.CreateProjectUnit("user-1", projectID, CreateProjectUnitRequest{Title: "第一章", SourceText: "角色推门进入房间。"})
	if err != nil {
		t.Fatal(err)
	}
	return unit
}

func TestWorkflowStepMachineRejectsIllegalTransitionAndEmptyStoryGate(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	if err := svc.EnsureBuiltinTemplate(); err != nil {
		t.Fatal(err)
	}
	workflow, err := svc.CreateUnitWorkflow("user-1", project.ID, unit.ID)
	if err != nil {
		t.Fatal(err)
	}
	step := workflow.Steps[0]
	if _, err := svc.UpdateWorkflowStep("user-1", project.ID, step.ID, UpdateWorkflowStepRequest{Status: string(model.WorkflowStepStatusCompleted)}); err == nil {
		t.Fatal("ready step completed without running")
	}
	if _, err := svc.UpdateWorkflowStep("user-1", project.ID, step.ID, UpdateWorkflowStepRequest{Status: string(model.WorkflowStepStatusRunning)}); err != nil {
		t.Fatal(err)
	}
	empty := seedProject(t, db, model.Project{ID: "project-empty", UserID: "user-1", Name: "空章项目"})
	emptyUnit, err := svc.CreateProjectUnit("user-1", empty.ID, CreateProjectUnitRequest{Title: "空章"})
	if err != nil {
		t.Fatal(err)
	}
	emptyWorkflow, err := svc.CreateUnitWorkflow("user-1", empty.ID, emptyUnit.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateWorkflowStep("user-1", empty.ID, emptyWorkflow.Steps[0].ID, UpdateWorkflowStepRequest{Status: string(model.WorkflowStepStatusRunning)}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateWorkflowStep("user-1", empty.ID, emptyWorkflow.Steps[0].ID, UpdateWorkflowStepRequest{Status: string(model.WorkflowStepStatusCompleted)}); err == nil {
		t.Fatal("empty chapter completed story gate")
	}
	completed, err := svc.UpdateWorkflowStep("user-1", project.ID, step.ID, UpdateWorkflowStepRequest{Status: string(model.WorkflowStepStatusCompleted)})
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != model.WorkflowStepStatusCompleted {
		t.Fatalf("story step = %s, want completed", completed.Status)
	}
	next := workflow.Steps[1]
	storedNext, err := svc.repo.WorkflowStepForProject(project.ID, next.ID)
	if err != nil {
		t.Fatal(err)
	}
	if storedNext.Status != model.WorkflowStepStatusReady {
		t.Fatalf("assets step = %s, want ready", storedNext.Status)
	}
}

func TestArchivedAndForeignOwnerRejectProductionWrites(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	if err := svc.EnsureBuiltinTemplate(); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateUnitWorkflow("user-1", project.ID, unit.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateProjectShot("user-2", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "画面", DurationMs: 1000}); !IsNotFound(err) {
		t.Fatalf("foreign shot create = %v, want not found", err)
	}
	archived, err := svc.UpdateProject("user-1", project.ID, UpdateProjectRequest{Status: string(model.ProjectStatusArchived)})
	if err != nil {
		t.Fatal(err)
	}
	if archived.Status != model.ProjectStatusArchived {
		t.Fatalf("status = %s", archived.Status)
	}
	if _, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "画面", DurationMs: 1000}); err == nil {
		t.Fatal("created shot on archived project")
	}
	if _, err := svc.LinkProjectAsset("user-1", project.ID, LinkProjectAssetRequest{AssetID: "missing"}); err == nil {
		t.Fatal("linked asset on archived project")
	}
	if _, err := svc.CreateProjectCharacter("user-1", project.ID, CreateProjectCharacterRequest{Name: "角色"}); err == nil {
		t.Fatal("created character on archived project")
	}
	if _, err := svc.CreateUnitWorkflow("user-1", project.ID, unit.ID); err == nil {
		t.Fatal("created workflow on archived project")
	}
	now := time.Now()
	if err := svc.repo.SaveShotWithRevisionActive("user-1", &model.Shot{ID: "shot-x", ProjectID: project.ID, UnitID: unit.ID, Title: "归档后", Description: "画面", CreatedAt: now, UpdatedAt: now}, &model.ShotRevision{ID: "rev-x", ShotID: "shot-x", PlotDescription: "画面", CreatedAt: now}, true, ""); !errors.Is(err, repository.ErrProjectArchived) {
		t.Fatalf("archived repo shot write = %v, want ErrProjectArchived", err)
	}
	active := seedProject(t, db, model.Project{ID: "project-2", UserID: "user-1", Name: "进行中"})
	if err := svc.repo.SaveShotWithRevisionActive("user-2", &model.Shot{ID: "shot-y", ProjectID: active.ID, Title: "劫持", Description: "画面", CreatedAt: now, UpdatedAt: now}, &model.ShotRevision{ID: "rev-y", ShotID: "shot-y", PlotDescription: "画面", CreatedAt: now}, true, ""); !IsNotFound(err) {
		t.Fatalf("foreign repo shot write = %v, want not found", err)
	}
}

func TestLinkCanvasUnitKeepsExistingIDAndSkipsForeignOldProjectBump(t *testing.T) {
	svc, db := newTestService(t, nil)
	foreign := seedProject(t, db, model.Project{ID: "foreign", UserID: "user-2", Name: "别人的项目", Revision: 9})
	target := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit, err := svc.CreateProjectUnit("user-1", target.ID, CreateProjectUnitRequest{Title: "第一章"})
	if err != nil {
		t.Fatal(err)
	}
	canvas := model.CanvasProject{ID: "canvas-1", UserID: "user-1", Title: "分镜", ProjectID: foreign.ID, Revision: 1, PayloadJSON: `{"nodes":[]}`}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	first, err := svc.LinkCanvasUnit("user-1", target.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID, Role: "storyboard"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.LinkCanvasUnit("user-1", target.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID, Role: "reference"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == "" || first.ID != second.ID {
		t.Fatalf("link ids = %q %q, want stable existing id", first.ID, second.ID)
	}
	var storedForeign model.Project
	if err := db.First(&storedForeign, "id = ?", foreign.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedForeign.Revision != 9 {
		t.Fatalf("foreign revision = %d, want 9", storedForeign.Revision)
	}
	var linkCount int64
	if err := db.Model(&model.CanvasUnitLink{}).Where("canvas_id = ?", canvas.ID).Count(&linkCount).Error; err != nil {
		t.Fatal(err)
	}
	if linkCount != 1 {
		t.Fatalf("link count = %d, want 1", linkCount)
	}
}

func TestConfirmCandidateRollsBackWhenAssetInsertFails(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	created, err := svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Source: AssetCandidateSourceChapterCharacter,
		Candidates: []AssetCandidateInput{{
			UnitID: unit.ID, Name: "小红帽", Category: string(model.AssetCategoryCharacter),
			Details: map[string]any{"role": "主角", "appearance": "红色斗篷", "clothing": "红色兜帽", "physique": "儿童", "personality": "勇敢", "voiceLanguage": "普通话", "voiceAge": "儿童", "voiceTimbre": "清亮"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 {
		t.Fatalf("candidates = %d, want 1", len(created))
	}
	if err := db.Exec("CREATE TRIGGER fail_candidate_asset BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT, 'forced asset insert failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmProjectAssetCandidate("user-1", project.ID, created[0].ID, ConfirmProjectAssetCandidateRequest{}); err == nil {
		t.Fatal("confirm succeeded after injected asset failure")
	}
	var assetCount int64
	if err := db.Model(&model.Asset{}).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 0 {
		t.Fatalf("asset count = %d, want 0 after rollback", assetCount)
	}
	var candidate model.ProjectAssetCandidate
	if err := db.First(&candidate, "id = ?", created[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if candidate.Status != "pending_confirmation" {
		t.Fatalf("candidate status = %s, want pending_confirmation", candidate.Status)
	}
}

func TestShotRevisionCASRejectsStaleCurrentPointer(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	shot, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "人物抬头", DurationMs: 3000})
	if err != nil {
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
	for _, plot := range []string{"甲改画面", "乙改画面"} {
		workers.Add(1)
		go func(plot string) {
			defer workers.Done()
			now := time.Now()
			next := shot
			revision := model.ShotRevision{ID: kernel.NewID(), ShotID: shot.ID, PlotDescription: plot, DurationMs: 3000, CreatedBy: "user-1", CreatedAt: now}
			next.Description = plot
			next.UpdatedAt = now
			<-start
			results <- svc.repo.SaveShotWithRevisionActive("user-1", &next, &revision, false, shot.CurrentRevisionID)
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
	var revisions int64
	if err := db.Model(&model.ShotRevision{}).Where("shot_id = ?", shot.ID).Count(&revisions).Error; err != nil {
		t.Fatal(err)
	}
	if revisions != 2 {
		t.Fatalf("revisions = %d, want 2 (initial plus one winner)", revisions)
	}
}

func TestCharacterVersionCASRejectsStalePrimary(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	created, err := svc.CreateProjectCharacter("user-1", project.ID, CreateProjectCharacterRequest{Name: "小红帽", Definition: map[string]any{"role": "主角"}})
	if err != nil {
		t.Fatal(err)
	}
	storedAsset, err := svc.repo.ProjectCharacterAsset("user-1", project.ID, created.Asset.ID)
	if err != nil {
		t.Fatal(err)
	}
	expectedPrimary := storedAsset.PrimaryVersionID
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for index, name := range []string{"小红帽甲", "小红帽乙"} {
		workers.Add(1)
		go func(index int, name string) {
			defer workers.Done()
			now := time.Now()
			nextID := kernel.NewID()
			asset := *storedAsset
			asset.Title = name
			asset.PrimaryVersionID = nextID
			asset.UpdatedAt = now
			version := model.AssetVersion{ID: nextID, AssetID: asset.ID, Version: index + 2, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: `{"role":"主角"}`, CreatedAt: now, UpdatedAt: now}
			<-start
			results <- svc.repo.SaveCharacterVersionActive("user-1", project.ID, expectedPrimary, &asset, &version, nil, nil)
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

func TestReplaceShotsRejectsStaleExpectedIDs(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	if _, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            []ReplaceProjectUnitShotInput{{CreateProjectShotRequest: CreateProjectShotRequest{Title: "SC.01", Description: "拾起信封", DurationMs: 3000}}},
	}); err != nil {
		t.Fatal(err)
	}
	_, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{"stale-shot"},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            []ReplaceProjectUnitShotInput{{CreateProjectShotRequest: CreateProjectShotRequest{Title: "SC.02", Description: "并发", DurationMs: 3000}}},
	})
	if err == nil || err.Error() != "本章分镜已发生变化，请刷新后重新确认" {
		t.Fatalf("stale replace = %v", err)
	}
}

func TestGeneratedOutputIsIdempotentByTaskIdentity(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	if err := svc.EnsureBuiltinTemplate(); err != nil {
		t.Fatal(err)
	}
	workflow, err := svc.CreateUnitWorkflow("user-1", project.ID, unit.ID)
	if err != nil {
		t.Fatal(err)
	}
	var videoStep model.WorkflowStepInstance
	for _, step := range workflow.Steps {
		if step.StepKey == "video" {
			videoStep = step
		}
	}
	if videoStep.ID == "" {
		t.Fatal("missing video step")
	}
	shot, err := svc.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "人物抬头", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	resource := model.Resource{ID: "resource-video-1", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 1024, CreatedAt: now, UpdatedAt: now}
	task := model.Task{ID: "task-output-1", UserID: "user-1", ProjectID: project.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded, ResultJSON: `{"video":{"resourceId":"resource-video-1"}}`, CreatedAt: now, UpdatedAt: now}
	for _, item := range []any{&resource, &task} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	register := func() {
		t.Helper()
		versionID, err := svc.EnsureGeneratedProjectAsset("user-1", project.ID, task.ID, shot.ID, resource.ID, "video", "生成")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := svc.RegisterTaskOutput("user-1", project.ID, videoStep.ID, RegisterTaskOutputRequest{
			TaskID: task.ID, UnitID: unit.ID, ShotID: shot.ID, ShotRevisionID: shot.CurrentRevisionID,
			ArtifactType: "video", AssetVersionID: versionID, ResourceID: resource.ID, MediaType: "video", Role: "output",
			OutputJSON: task.ResultJSON,
		}); err != nil {
			t.Fatal(err)
		}
	}
	register()
	var instanceAfterFirst model.WorkflowInstance
	if err := db.First(&instanceAfterFirst, "id = ?", workflow.Instance.ID).Error; err != nil {
		t.Fatal(err)
	}
	register()
	var instanceAfterRetry model.WorkflowInstance
	if err := db.First(&instanceAfterRetry, "id = ?", workflow.Instance.ID).Error; err != nil {
		t.Fatal(err)
	}
	if instanceAfterRetry.Revision != instanceAfterFirst.Revision {
		t.Fatalf("same-task retry revision = %d, want %d", instanceAfterRetry.Revision, instanceAfterFirst.Revision)
	}
	assetID := GeneratedEntityID("asset", task.ID)
	checks := []struct {
		table string
		where string
		value string
	}{
		{table: "assets", where: "id = ?", value: assetID},
		{table: "project_asset_links", where: "asset_id = ?", value: assetID},
		{table: "asset_representations", where: "task_id = ? AND role = 'output'", value: task.ID},
		{table: "shot_artifacts", where: "task_id = ? AND type = 'video'", value: task.ID},
		{table: "workflow_step_tasks", where: "task_id = ?", value: task.ID},
	}
	for _, check := range checks {
		var count int64
		if err := db.Table(check.table).Where(check.where, check.value).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("%s count = %d, error = %v", check.table, count, err)
		}
	}
}

func TestMoveProjectAssetRejectsMissingFolderInsideTransaction(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	now := time.Now()
	resource := model.Resource{ID: "resource-1", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png", CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.LinkProjectAsset("user-1", project.ID, LinkProjectAssetRequest{AssetID: resource.ID, Title: "海报", Source: AssetSourceUploaded}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.MoveProjectAssetActive("user-1", project.ID, resource.ID, "missing-folder", 0); !IsNotFound(err) {
		t.Fatalf("missing folder move = %v, want not found", err)
	}
}
