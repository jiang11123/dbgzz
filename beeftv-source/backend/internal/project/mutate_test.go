package project

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestCreateProjectUnitRollsBackWhenRevisionBumpFails(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	if err := db.Exec("CREATE TRIGGER fail_project_revision BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'forced revision bump failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateProjectUnit("user-1", project.ID, CreateProjectUnitRequest{Title: "第一章"}); err == nil {
		t.Fatal("CreateProjectUnit succeeded after injected revision failure")
	}
	var unitCount int64
	if err := db.Model(&model.ProjectUnit{}).Where("project_id = ?", project.ID).Count(&unitCount).Error; err != nil {
		t.Fatal(err)
	}
	if unitCount != 0 {
		t.Fatalf("unit count = %d, want 0 after rollback", unitCount)
	}
	var stored model.Project
	if err := db.First(&stored, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Revision != 1 {
		t.Fatalf("revision = %d, want 1 after rollback", stored.Revision)
	}
}

func TestLinkCanvasUnitRollsBackWhenLinkInsertFails(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit, err := svc.CreateProjectUnit("user-1", project.ID, CreateProjectUnitRequest{Title: "第一集"})
	if err != nil {
		t.Fatal(err)
	}
	canvas := model.CanvasProject{
		ID: "canvas-1", UserID: "user-1", Title: "分镜", Revision: 3,
		PayloadJSON: `{"projectId":"old-project","nodes":[{"id":"n1"}],"futureField":true,"nested":{"keep":1}}`,
	}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("CREATE TRIGGER fail_canvas_link BEFORE INSERT ON canvas_unit_links BEGIN SELECT RAISE(ABORT, 'forced canvas link failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID}); err == nil {
		t.Fatal("LinkCanvasUnit succeeded after injected link failure")
	}
	var storedCanvas model.CanvasProject
	if err := db.First(&storedCanvas, "id = ?", canvas.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedCanvas.ProjectID != "" || storedCanvas.Revision != 3 {
		t.Fatalf("canvas assignment leaked after rollback: %+v", storedCanvas)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(storedCanvas.PayloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["projectId"] != "old-project" {
		t.Fatalf("payload projectId changed after rollback: %s", storedCanvas.PayloadJSON)
	}
	if payload["futureField"] != true {
		t.Fatalf("unknown payload field dropped after rollback: %s", storedCanvas.PayloadJSON)
	}
	var linkCount int64
	if err := db.Model(&model.CanvasUnitLink{}).Count(&linkCount).Error; err != nil {
		t.Fatal(err)
	}
	if linkCount != 0 {
		t.Fatalf("link count = %d, want 0 after rollback", linkCount)
	}
}

func TestLinkCanvasUnitWritesPayloadProjectIdAndPreservesUnknownKeys(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit, err := svc.CreateProjectUnit("user-1", project.ID, CreateProjectUnitRequest{Title: "第一集"})
	if err != nil {
		t.Fatal(err)
	}
	canvas := model.CanvasProject{
		ID: "canvas-1", UserID: "user-1", Title: "分镜", Revision: 2,
		PayloadJSON: `{"projectId":"stale","nodes":[{"id":"n1"}],"futureField":true,"nested":{"keep":1}}`,
	}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID}); err != nil {
		t.Fatal(err)
	}
	var storedCanvas model.CanvasProject
	if err := db.First(&storedCanvas, "id = ?", canvas.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedCanvas.ProjectID != project.ID {
		t.Fatalf("canvas column project id = %q", storedCanvas.ProjectID)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(storedCanvas.PayloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["projectId"] != project.ID {
		t.Fatalf("payload projectId = %v, want column agreement", payload["projectId"])
	}
	if payload["futureField"] != true {
		t.Fatalf("unknown payload field dropped: %s", storedCanvas.PayloadJSON)
	}
	nested, _ := payload["nested"].(map[string]any)
	if nested["keep"] != float64(1) {
		t.Fatalf("nested unknown data dropped: %s", storedCanvas.PayloadJSON)
	}
}

func TestLinkCanvasUnitMovesOldProjectLinksAndRevisions(t *testing.T) {
	svc, db := newTestService(t, nil)
	source := seedProject(t, db, model.Project{ID: "project-a", UserID: "user-1", Name: "原项目", Revision: 4})
	target := seedProject(t, db, model.Project{ID: "project-b", UserID: "user-1", Name: "新项目"})
	sourceUnit, err := svc.CreateProjectUnit("user-1", source.ID, CreateProjectUnitRequest{Title: "原章"})
	if err != nil {
		t.Fatal(err)
	}
	targetUnit, err := svc.CreateProjectUnit("user-1", target.ID, CreateProjectUnitRequest{Title: "新章"})
	if err != nil {
		t.Fatal(err)
	}
	canvas := model.CanvasProject{
		ID: "canvas-1", UserID: "user-1", Title: "分镜", Revision: 1,
		PayloadJSON: `{"nodes":[]}`,
	}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.LinkCanvasUnit("user-1", source.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: sourceUnit.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.LinkCanvasUnit("user-1", target.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: targetUnit.ID}); err != nil {
		t.Fatal(err)
	}
	var storedCanvas model.CanvasProject
	if err := db.First(&storedCanvas, "id = ?", canvas.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedCanvas.ProjectID != target.ID {
		t.Fatalf("moved canvas project id = %q", storedCanvas.ProjectID)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(storedCanvas.PayloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["projectId"] != target.ID {
		t.Fatalf("moved payload projectId = %v", payload["projectId"])
	}
	var sourceLinks int64
	if err := db.Model(&model.CanvasUnitLink{}).Where("project_id = ?", source.ID).Count(&sourceLinks).Error; err != nil {
		t.Fatal(err)
	}
	if sourceLinks != 0 {
		t.Fatalf("old project still has %d canvas links", sourceLinks)
	}
	var storedSource model.Project
	if err := db.First(&storedSource, "id = ?", source.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedSource.Revision < 7 {
		t.Fatalf("old project revision = %d, want bump after losing canvas", storedSource.Revision)
	}
}

func TestCreateProjectFolderRejectsForeignOrMissingParent(t *testing.T) {
	svc, db := newTestService(t, nil)
	own, err := svc.CreateProjectFolder("user-1", CreateProjectFolderRequest{Name: "进行中"})
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := svc.CreateProjectFolder("user-2", CreateProjectFolderRequest{Name: "别人的夹"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateProjectFolder("user-1", CreateProjectFolderRequest{Name: "子夹", ParentID: foreign.ID}); !IsNotFound(err) {
		t.Fatalf("foreign parent error = %v, want not found", err)
	}
	if _, err := svc.CreateProjectFolder("user-1", CreateProjectFolderRequest{Name: "子夹", ParentID: "missing-folder"}); !IsNotFound(err) {
		t.Fatalf("missing parent error = %v, want not found", err)
	}
	child, err := svc.CreateProjectFolder("user-1", CreateProjectFolderRequest{Name: "子夹", ParentID: own.ID})
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentID != own.ID {
		t.Fatalf("child parent = %q", child.ParentID)
	}
	root, err := svc.CreateProjectFolder("user-1", CreateProjectFolderRequest{Name: "根夹", ParentID: "  "})
	if err != nil {
		t.Fatal(err)
	}
	if root.ParentID != "" {
		t.Fatalf("root parent = %q", root.ParentID)
	}
	var leaked int64
	if err := db.Model(&model.ProjectFolder{}).Where("user_id = ? AND parent_id = ?", "user-1", foreign.ID).Count(&leaked).Error; err != nil {
		t.Fatal(err)
	}
	if leaked != 0 {
		t.Fatalf("foreign parent still attached %d folders", leaked)
	}
}

func TestArchivedProjectRejectsUnitAndLinkMutations(t *testing.T) {
	svc, db := newTestService(t, nil)
	archived := seedProject(t, db, model.Project{ID: "archived", UserID: "user-1", Name: "旧项目", Status: model.ProjectStatusArchived})
	unit := model.ProjectUnit{ID: "unit-1", ProjectID: archived.ID, Title: "旧章", Status: model.ProjectUnitStatusDraft, Kind: model.ProjectUnitKindChapter}
	if err := db.Create(&unit).Error; err != nil {
		t.Fatal(err)
	}
	canvas := model.CanvasProject{ID: "canvas-1", UserID: "user-1", Title: "旧画布", PayloadJSON: `{}`}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateProjectUnit("user-1", archived.ID, CreateProjectUnitRequest{Title: "新章"}); err == nil {
		t.Fatal("created unit on archived project")
	}
	if _, err := svc.UpdateProjectUnit("user-1", archived.ID, unit.ID, UpdateProjectUnitRequest{Title: "改"}); err == nil {
		t.Fatal("updated unit on archived project")
	}
	if err := svc.DeleteProjectUnit("user-1", archived.ID, unit.ID); err == nil {
		t.Fatal("deleted unit on archived project")
	}
	if _, err := svc.ImportProjectUnits("user-1", archived.ID, ImportProjectUnitsRequest{Units: []CreateProjectUnitRequest{{Title: "导入"}}}); err == nil {
		t.Fatal("imported units on archived project")
	}
	if _, err := svc.LinkCanvasUnit("user-1", archived.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID}); err == nil {
		t.Fatal("linked canvas on archived project")
	}
	got, err := svc.GetProjectUnit("user-1", archived.ID, unit.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != unit.ID {
		t.Fatalf("read archived unit = %+v", got)
	}
	active, err := svc.UpdateProject("user-1", archived.ID, UpdateProjectRequest{Status: string(model.ProjectStatusActive)})
	if err != nil {
		t.Fatal(err)
	}
	if active.Status != model.ProjectStatusActive {
		t.Fatalf("unarchive = %+v", active)
	}
}

func TestMoveProjectIncrementsRevision(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	folder, err := svc.CreateProjectFolder("user-1", CreateProjectFolderRequest{Name: "进行中"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.MoveProjectToFolder("user-1", project.ID, folder.ID); err != nil {
		t.Fatal(err)
	}
	var stored model.Project
	if err := db.First(&stored, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.FolderID != folder.ID || stored.Revision != 2 {
		t.Fatalf("moved = %+v", stored)
	}
	if err := svc.MoveProjectToFolder("user-1", project.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&stored, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.FolderID != "" || stored.Revision != 3 {
		t.Fatalf("cleared = %+v", stored)
	}
}

func TestUpdateProjectCASRejectsStaleAndConcurrentWrites(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)

	updated, err := svc.UpdateProject("user-1", project.ID, UpdateProjectRequest{Name: "短剧改"})
	if err != nil {
		t.Fatal(err)
	}
	stale := updated
	stale.Name = "不应写入"
	stale.UpdatedAt = time.Now()
	if err := svc.repo.UpdateProjectCAS("user-1", project.Revision, &stale); !errors.Is(err, repository.ErrProjectRevisionConflict) {
		t.Fatalf("stale CAS error = %v", err)
	}
	var stored model.Project
	if err := db.First(&stored, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Name != "短剧改" || stored.Revision != 2 {
		t.Fatalf("stale write mutated project: %+v", stored)
	}

	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for _, name := range []string{"并发甲", "并发乙"} {
		workers.Add(1)
		go func(name string) {
			defer workers.Done()
			next := stored
			next.Name = name
			next.Revision = stored.Revision + 1
			next.UpdatedAt = time.Now()
			<-start
			results <- svc.repo.UpdateProjectCAS("user-1", stored.Revision, &next)
		}(name)
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
	if err := db.First(&stored, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Revision != 3 || (stored.Name != "并发甲" && stored.Name != "并发乙") {
		t.Fatalf("winner = %+v", stored)
	}
}

func TestCreateProjectRollsBackWhenWorkflowInsertFails(t *testing.T) {
	svc, db := newTestService(t, &recordingWorkflows{})
	if err := db.Exec("CREATE TRIGGER fail_workflow BEFORE INSERT ON workflow_instances BEGIN SELECT RAISE(ABORT, 'forced workflow insert failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateProject("user-1", CreateProjectRequest{Name: "事务项目"}); err == nil {
		t.Fatal("CreateProject succeeded after injected workflow failure")
	}
	var projectCount int64
	if err := db.Model(&model.Project{}).Count(&projectCount).Error; err != nil {
		t.Fatal(err)
	}
	if projectCount != 0 {
		t.Fatalf("project count = %d, want 0 after workflow rollback", projectCount)
	}
	var workflowCount int64
	if err := db.Model(&model.WorkflowInstance{}).Count(&workflowCount).Error; err != nil {
		t.Fatal(err)
	}
	if workflowCount != 0 {
		t.Fatalf("workflow count = %d, want 0 after rollback", workflowCount)
	}
}

func TestCreateProjectDefaultsToOwnedWorkflowSeed(t *testing.T) {
	svc, db := newTestService(t, nil)
	created, err := svc.CreateProject("user-1", CreateProjectRequest{Name: "空白项目"})
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 2 {
		t.Fatalf("revision = %d, want 2 after default workflow creation", created.Revision)
	}
	var workflowCount int64
	if err := db.Model(&model.WorkflowInstance{}).Count(&workflowCount).Error; err != nil {
		t.Fatal(err)
	}
	if workflowCount != 1 {
		t.Fatalf("workflow count = %d, want 1", workflowCount)
	}
	var stepCount int64
	if err := db.Model(&model.WorkflowStepInstance{}).Count(&stepCount).Error; err != nil {
		t.Fatal(err)
	}
	if stepCount != int64(len(builtinShortDramaSteps)) {
		t.Fatalf("workflow steps = %d, want %d", stepCount, len(builtinShortDramaSteps))
	}
}

func TestUpdateProjectConflictIsTyped(t *testing.T) {
	err := mapProjectWriteError(repository.ErrProjectRevisionConflict)
	if !IsConflict(err) {
		t.Fatalf("mapped conflict = %v", err)
	}
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Message != "项目已被其他操作更新，请重新加载后再保存" {
		t.Fatalf("conflict message = %#v", appErr)
	}
}
