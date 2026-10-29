package repository

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func taskScopeDSN(path string) string {
	return path + "?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on"
}

func newTaskScopeRepo(t *testing.T) (*Repository, *gorm.DB) {
	t.Helper()
	repo, db, _ := newTaskScopeRepoAt(t, filepath.Join(t.TempDir(), "task-scope.db"))
	return repo, db
}

func newTaskScopeRepoAt(t *testing.T, path string) (*Repository, *gorm.DB, string) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(taskScopeDSN(path)), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.Task{},
		&model.TaskTextDelta{},
		&model.CanvasProject{},
		&model.CanvasSnapshot{},
		&model.CanvasSnapshotResource{},
		&model.CanvasUnitLink{},
		&model.Project{},
		&model.ProjectUnit{},
		&model.ProjectAssetLink{},
		&model.ProjectAssetFolder{},
		&model.ProjectAssetCandidate{},
		&model.Shot{},
		&model.ShotRevision{},
		&model.ShotArtifact{},
		&model.ShotAssetReference{},
		&model.WorkflowInstance{},
		&model.WorkflowStepInstance{},
		&model.WorkflowStepTask{},
		&model.ProductionTaskLink{},
	); err != nil {
		t.Fatal(err)
	}
	return New(db), db, path
}

func reopenTaskScopeRepo(t *testing.T, db *gorm.DB, path string) (*Repository, *gorm.DB) {
	t.Helper()
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := gorm.Open(sqlite.Open(taskScopeDSN(path)), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	return New(reopened), reopened
}

func seedScopeProject(t *testing.T, db *gorm.DB, project model.Project) model.Project {
	t.Helper()
	if project.Status == "" {
		project.Status = model.ProjectStatusActive
	}
	now := time.Now()
	if project.CreatedAt.IsZero() {
		project.CreatedAt = now
	}
	if project.UpdatedAt.IsZero() {
		project.UpdatedAt = now
	}
	if err := db.Create(&project).Error; err != nil {
		t.Fatal(err)
	}
	return project
}

func seedScopeCanvas(t *testing.T, db *gorm.DB, canvas model.CanvasProject) model.CanvasProject {
	t.Helper()
	now := time.Now()
	if canvas.CreatedAt.IsZero() {
		canvas.CreatedAt = now
	}
	if canvas.UpdatedAt.IsZero() {
		canvas.UpdatedAt = now
	}
	if canvas.Revision == 0 {
		canvas.Revision = 1
	}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	return canvas
}

func queuedScopeTask(id, userID, projectID string) *model.Task {
	return &model.Task{ID: id, UserID: userID, ProjectID: projectID, Type: "canvas_text", Status: model.TaskStatusQueued, Prompt: "生成"}
}

func failedScopeTask(id, userID, projectID string) *model.Task {
	return &model.Task{ID: id, UserID: userID, ProjectID: projectID, Type: "canvas_text", Status: model.TaskStatusFailed, Prompt: "生成"}
}

func countTasks(t *testing.T, db *gorm.DB, id string) int64 {
	t.Helper()
	var count int64
	if err := db.Model(&model.Task{}).Where("id = ?", id).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}

func TestRequireTaskScopeActiveTxAllowsEmptyAndOwnedTargets(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	personal := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-personal", UserID: "user-1", Title: "个人画布"})
	active := seedScopeProject(t, db, model.Project{ID: "project-active", UserID: "user-1", Name: "在产"})
	linked := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-linked", UserID: "user-1", ProjectID: active.ID, Title: "项目画布"})
	for _, id := range []string{"", personal.ID, active.ID, linked.ID} {
		if err := repo.RequireTaskScopeActive("user-1", id); err != nil {
			t.Fatalf("id %q error = %v", id, err)
		}
	}
}

func TestRequireTaskScopeActiveTxRejectsUnknownForeignArchivedDeleted(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	archived := seedScopeProject(t, db, model.Project{ID: "project-archived", UserID: "user-1", Name: "旧项目", Status: model.ProjectStatusArchived})
	foreignProject := seedScopeProject(t, db, model.Project{ID: "project-foreign", UserID: "user-2", Name: "别人的项目"})
	archivedCanvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-archived", UserID: "user-1", ProjectID: archived.ID, Title: "旧画布"})
	foreignCanvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-foreign", UserID: "user-2", Title: "别人的画布"})
	deleted := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-deleted", UserID: "user-1", Title: "将被删除"})
	if err := db.Delete(&model.CanvasProject{}, "id = ?", deleted.ID).Error; err != nil {
		t.Fatal(err)
	}

	archivedCases := []string{archived.ID, archivedCanvas.ID}
	for _, id := range archivedCases {
		if err := repo.RequireTaskScopeActive("user-1", id); !errors.Is(err, ErrTaskScopeArchived) {
			t.Fatalf("archived %s error = %v", id, err)
		}
	}
	inactive := []string{"missing", foreignProject.ID, foreignCanvas.ID, deleted.ID}
	for _, id := range inactive {
		if err := repo.RequireTaskScopeActive("user-1", id); !errors.Is(err, ErrTaskScopeNotActive) {
			t.Fatalf("inactive %s error = %v", id, err)
		}
	}
}

func TestCreateTaskWithActiveLimitAdmitsOwnedCanvasAndProject(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	personal := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-personal", UserID: "user-1", Title: "个人画布"})
	active := seedScopeProject(t, db, model.Project{ID: "project-active", UserID: "user-1", Name: "在产"})
	for _, item := range []struct {
		id        string
		projectID string
	}{
		{"task-empty", ""},
		{"task-canvas", personal.ID},
		{"task-project", active.ID},
	} {
		if err := repo.CreateTaskWithActiveLimit(queuedScopeTask(item.id, "user-1", item.projectID), 8); err != nil {
			t.Fatalf("%s: %v", item.id, err)
		}
	}
}

func TestCreateTaskWithActiveLimitRejectsInvalidScopeWithoutInsert(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	archived := seedScopeProject(t, db, model.Project{ID: "project-archived", UserID: "user-1", Name: "旧项目", Status: model.ProjectStatusArchived})
	foreign := seedScopeProject(t, db, model.Project{ID: "project-foreign", UserID: "user-2", Name: "别人的项目"})
	foreignCanvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-foreign", UserID: "user-2", Title: "别人的画布"})
	deletedProject := seedScopeProject(t, db, model.Project{ID: "project-deleted", UserID: "user-1", Name: "已删"})
	if err := db.Delete(&model.Project{}, "id = ?", deletedProject.ID).Error; err != nil {
		t.Fatal(err)
	}
	orphanedCanvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-orphan-link", UserID: "user-1", ProjectID: deletedProject.ID, Title: "悬空画布"})
	cases := []struct {
		id        string
		projectID string
		want      error
	}{
		{"task-archived", archived.ID, ErrTaskScopeArchived},
		{"task-foreign-project", foreign.ID, ErrTaskScopeNotActive},
		{"task-foreign-canvas", foreignCanvas.ID, ErrTaskScopeNotActive},
		{"task-unknown", "missing", ErrTaskScopeNotActive},
		{"task-deleted-project", deletedProject.ID, ErrTaskScopeNotActive},
		{"task-orphan-canvas", orphanedCanvas.ID, ErrTaskScopeNotActive},
	}
	for _, item := range cases {
		if err := repo.CreateTaskWithActiveLimit(queuedScopeTask(item.id, "user-1", item.projectID), 8); !errors.Is(err, item.want) {
			t.Fatalf("%s error = %v, want %v", item.id, err, item.want)
		}
		if countTasks(t, db, item.id) != 0 {
			t.Fatalf("%s inserted a row", item.id)
		}
	}
}

func TestRetryTaskFailsClosedOnDeletedCanvas(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	canvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-retry", UserID: "user-1", Title: "画布"})
	failed := failedScopeTask("task-retry-deleted", "user-1", canvas.ID)
	if err := db.Create(failed).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteCanvasProject("user-1", canvas.ID); err != nil {
		t.Fatal(err)
	}
	loaded, err := repo.TaskForUser("user-1", failed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ProjectID != canvas.ID {
		t.Fatalf("deleted canvas stripped task scope: %#v", loaded)
	}
	if _, err := repo.RetryTask("user-1", loaded, 8); !errors.Is(err, ErrTaskScopeNotActive) {
		t.Fatalf("retry deleted canvas error = %v", err)
	}
	var still model.Task
	if err := db.First(&still, "id = ?", failed.ID).Error; err != nil || still.Status != model.TaskStatusFailed {
		t.Fatalf("retry mutated deleted-scope task: %#v err=%v", still, err)
	}
	if still.ProjectID != canvas.ID {
		t.Fatalf("retry cleared original scope: %#v", still)
	}
}

func TestRetryTaskAdmitsOwnedCanvas(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	canvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-retry-ok", UserID: "user-1", Title: "画布"})
	failed := failedScopeTask("task-retry-ok", "user-1", canvas.ID)
	if err := db.Create(failed).Error; err != nil {
		t.Fatal(err)
	}
	retried, err := repo.RetryTask("user-1", failed, 8)
	if err != nil || retried.Status != model.TaskStatusQueued {
		t.Fatalf("retry = %#v err=%v", retried, err)
	}
}

func TestCreateTaskReplayAfterTargetDeletionReturnsReceipt(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	canvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-replay", UserID: "user-1", Title: "画布"})
	op := "client-op-replay"
	original := queuedScopeTask("task-replay", "user-1", canvas.ID)
	original.ClientOperationID = &op
	if err := repo.CreateTaskWithActiveLimit(original, 8); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteCanvasProject("user-1", canvas.ID); err != nil {
		t.Fatal(err)
	}
	stored, err := repo.TaskForUser("user-1", original.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ProjectID != canvas.ID {
		t.Fatalf("replay receipt lost original scope: %#v", stored)
	}
	again := queuedScopeTask("task-replay-new", "user-1", canvas.ID)
	again.ClientOperationID = &op
	err = repo.CreateTaskWithActiveLimit(again, 8)
	var replay *ClientOperationReplay
	if !errors.As(err, &replay) || replay.Task.ID != original.ID {
		t.Fatalf("replay after delete = %v", err)
	}
	if countTasks(t, db, again.ID) != 0 {
		t.Fatal("replay inserted a new paid task")
	}
	if countTasks(t, db, original.ID) != 1 {
		t.Fatal("replay deleted the original paid task")
	}
}

func TestCreateTaskAndDeleteCanvasDoNotAdmitDeletedScope(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	canvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-race", UserID: "user-1", Title: "画布"})
	task := queuedScopeTask("task-race", "user-1", canvas.ID)
	var createErr, deleteErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		createErr = repo.CreateTaskWithActiveLimit(task, 8)
	}()
	go func() {
		defer wg.Done()
		deleteErr = repo.DeleteCanvasProject("user-1", canvas.ID)
	}()
	wg.Wait()
	if deleteErr != nil {
		t.Fatalf("delete: %v", deleteErr)
	}
	if createErr != nil && !errors.Is(createErr, ErrTaskScopeNotActive) {
		t.Fatalf("create: %v", createErr)
	}
	var canvasCount int64
	if err := db.Model(&model.CanvasProject{}).Where("id = ?", canvas.ID).Count(&canvasCount).Error; err != nil {
		t.Fatal(err)
	}
	if canvasCount != 0 {
		return
	}
	if createErr != nil {
		if countTasks(t, db, task.ID) != 0 {
			t.Fatal("rejected create still inserted a row")
		}
		return
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.ProjectID != canvas.ID {
		t.Fatalf("admitted task lost original canvas scope: %#v", stored)
	}
}

func TestRetryTaskAndDeleteCanvasDoNotRequeueDeletedScope(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	canvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-retry-race", UserID: "user-1", Title: "画布"})
	failed := failedScopeTask("task-retry-race", "user-1", canvas.ID)
	if err := db.Create(failed).Error; err != nil {
		t.Fatal(err)
	}
	prepared := *failed
	var retryErr, deleteErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, retryErr = repo.RetryTask("user-1", &prepared, 8)
	}()
	go func() {
		defer wg.Done()
		deleteErr = repo.DeleteCanvasProject("user-1", canvas.ID)
	}()
	wg.Wait()
	if deleteErr != nil {
		t.Fatalf("delete: %v", deleteErr)
	}
	if retryErr != nil && !errors.Is(retryErr, ErrTaskScopeNotActive) && !errors.Is(retryErr, ErrTaskNotRetryable) {
		t.Fatalf("retry: %v", retryErr)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", failed.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.ProjectID != canvas.ID {
		t.Fatalf("retry/delete stripped original scope: %#v", stored)
	}
	if errors.Is(retryErr, ErrTaskScopeNotActive) && stored.Status != model.TaskStatusFailed {
		t.Fatalf("rejected retry mutated status=%s", stored.Status)
	}
}

func TestCreateTaskAndArchiveProjectDoNotAdmitArchivedScope(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	project := seedScopeProject(t, db, model.Project{ID: "project-race", UserID: "user-1", Name: "在产"})
	task := queuedScopeTask("task-archive-race", "user-1", project.ID)
	var createErr, archiveErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		createErr = repo.CreateTaskWithActiveLimit(task, 8)
	}()
	go func() {
		defer wg.Done()
		archiveErr = db.Model(&model.Project{}).Where("id = ? AND user_id = ?", project.ID, "user-1").Update("status", model.ProjectStatusArchived).Error
	}()
	wg.Wait()
	if archiveErr != nil {
		t.Fatalf("archive: %v", archiveErr)
	}
	if createErr != nil && !errors.Is(createErr, ErrTaskScopeArchived) && !errors.Is(createErr, ErrTaskScopeNotActive) {
		t.Fatalf("create: %v", createErr)
	}
	var stored model.Project
	if err := db.First(&stored, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Status == model.ProjectStatusArchived && errors.Is(createErr, ErrTaskScopeArchived) && countTasks(t, db, task.ID) != 0 {
		t.Fatal("archived reject inserted a row")
	}
	if createErr == nil && stored.Status == model.ProjectStatusArchived {
		if countTasks(t, db, task.ID) != 1 {
			t.Fatal("create won the race but no task row")
		}
	}
}

func TestCreateLinkedCanvasValidatesBusinessProjectInSameTransaction(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	project := seedScopeProject(t, db, model.Project{ID: "project-linked-race", UserID: "user-1", Name: "在产"})
	canvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-linked-race", UserID: "user-1", ProjectID: project.ID, Title: "项目画布"})
	task := queuedScopeTask("task-linked-race", "user-1", canvas.ID)
	var createErr, archiveErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		createErr = repo.CreateTaskWithActiveLimit(task, 8)
	}()
	go func() {
		defer wg.Done()
		archiveErr = db.Model(&model.Project{}).Where("id = ? AND user_id = ?", project.ID, "user-1").Update("status", model.ProjectStatusArchived).Error
	}()
	wg.Wait()
	if archiveErr != nil {
		t.Fatalf("archive: %v", archiveErr)
	}
	if createErr != nil && !errors.Is(createErr, ErrTaskScopeArchived) && !errors.Is(createErr, ErrTaskScopeNotActive) {
		t.Fatalf("create: %v", createErr)
	}
	if errors.Is(createErr, ErrTaskScopeArchived) && countTasks(t, db, task.ID) != 0 {
		t.Fatal("linked archived reject inserted a row")
	}
}

func TestRetryAfterCanvasDeleteSurvivesReopen(t *testing.T) {
	repo, db, path := newTaskScopeRepoAt(t, filepath.Join(t.TempDir(), "task-scope-reopen.db"))
	canvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-reopen", UserID: "user-1", Title: "画布"})
	admitted := queuedScopeTask("task-reopen-canvas", "user-1", canvas.ID)
	if err := repo.CreateTaskWithActiveLimit(admitted, 8); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", admitted.ID).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteCanvasProject("user-1", canvas.ID); err != nil {
		t.Fatal(err)
	}
	repo, db = reopenTaskScopeRepo(t, db, path)
	loaded, err := repo.TaskForUser("user-1", admitted.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Status != model.TaskStatusFailed || loaded.ProjectID != canvas.ID {
		t.Fatalf("reloaded task = %#v", loaded)
	}
	listed, err := repo.Tasks("user-1", 10, canvas.ID, false)
	if err != nil || len(listed) != 1 || listed[0].ID != admitted.ID {
		t.Fatalf("historical list = %#v err=%v", listed, err)
	}
	if _, err := repo.RetryTask("user-1", loaded, 8); !errors.Is(err, ErrTaskScopeNotActive) {
		t.Fatalf("reopen retry error = %v", err)
	}
	if countTasks(t, db, admitted.ID) != 1 {
		t.Fatal("retry after reopen changed admission count")
	}
	still, err := repo.TaskForUser("user-1", admitted.ID)
	if err != nil || still.Status != model.TaskStatusFailed || still.ProjectID != canvas.ID {
		t.Fatalf("retry after reopen mutated receipt: %#v err=%v", still, err)
	}
}

func TestRetryAfterProjectDeleteSurvivesReopen(t *testing.T) {
	repo, db, path := newTaskScopeRepoAt(t, filepath.Join(t.TempDir(), "task-scope-project-reopen.db"))
	project := seedScopeProject(t, db, model.Project{ID: "project-reopen", UserID: "user-1", Name: "在产"})
	admitted := queuedScopeTask("task-reopen-project", "user-1", project.ID)
	if err := repo.CreateTaskWithActiveLimit(admitted, 8); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", admitted.ID).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteProject("user-1", project.ID, nil); err != nil {
		t.Fatal(err)
	}
	repo, db = reopenTaskScopeRepo(t, db, path)
	loaded, err := repo.TaskForUser("user-1", admitted.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Status != model.TaskStatusFailed || loaded.ProjectID != project.ID {
		t.Fatalf("reloaded project task = %#v", loaded)
	}
	listed, err := repo.Tasks("user-1", 10, project.ID, false)
	if err != nil || len(listed) != 1 || listed[0].ID != admitted.ID {
		t.Fatalf("historical project list = %#v err=%v", listed, err)
	}
	if _, err := repo.RetryTask("user-1", loaded, 8); !errors.Is(err, ErrTaskScopeNotActive) {
		t.Fatalf("reopen project retry error = %v", err)
	}
	if countTasks(t, db, admitted.ID) != 1 {
		t.Fatal("project retry after reopen changed admission count")
	}
	still, err := repo.TaskForUser("user-1", admitted.ID)
	if err != nil || still.Status != model.TaskStatusFailed || still.ProjectID != project.ID {
		t.Fatalf("project retry after reopen mutated receipt: %#v err=%v", still, err)
	}
}
