package task

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type sqlitePersist struct{ repo *repository.Repository }

func (p sqlitePersist) CreateAdmitted(task *model.Task, limit int) error {
	return p.repo.CreateTaskWithActiveLimit(task, limit)
}

type sqliteProjects struct{ repo *repository.Repository }

func (p sqliteProjects) EnsureActive(userID, canvasOrProjectID string) error {
	if err := p.repo.RequireTaskScopeActive(userID, canvasOrProjectID); err != nil {
		if mapped := mapTaskScopeError(err); mapped != nil {
			return mapped
		}
		return err
	}
	return nil
}

type sqliteOwnedMedia struct{ repo *repository.Repository }

func (p sqliteOwnedMedia) Resource(userID, id string) (*model.Resource, error) {
	return p.repo.ResourceForUser(userID, id)
}

func specializedSQLite(t *testing.T, extra func(*Dependencies, *drainRuntime)) (*Service, *gorm.DB, *drainRuntime) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "specialized.db")+"?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	pool.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = pool.Close() })
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.Resource{}, &model.Project{}, &model.CanvasProject{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	runtime := &drainRuntime{}
	deps := specializedDeps(sqlitePersist{repo: repo}, sqliteOwnedMedia{repo: repo}, runtime)
	deps.Projects = sqliteProjects{repo: repo}
	if extra != nil {
		extra(&deps, runtime)
	}
	return NewService(NewStore(repo), deps), db, runtime
}

func seedSQLiteUser(t *testing.T, db *gorm.DB, userID, projectID, resourceID, mime string) {
	t.Helper()
	if projectID != "" {
		if err := db.Create(&model.Project{ID: projectID, UserID: userID, Name: projectID, Status: model.ProjectStatusActive}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if resourceID != "" {
		if err := db.Create(&model.Resource{
			ID: resourceID, UserID: userID, Kind: "media", Status: model.ResourceStatusReady,
			Provider: "local", MimeType: mime, Size: 2048, ObjectKey: "users/" + userID + "/" + resourceID,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
}

func countTasks(t *testing.T, db *gorm.DB, userID string) int64 {
	t.Helper()
	var n int64
	query := db.Model(&model.Task{})
	if userID != "" {
		query = query.Where("user_id = ?", userID)
	}
	if err := query.Count(&n).Error; err != nil {
		t.Fatal(err)
	}
	return n
}

func TestSQLiteEmptyProjectIDIsAllowed(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "", "res-1", "video/mp4")
	task, err := svc.CreateTimelineTranscriptionTask("owner", TimelineTranscriptionCreateRequest{ResourceID: "res-1"})
	if err != nil {
		t.Fatal(err)
	}
	if task.ProjectID != "" {
		t.Fatalf("projectId = %q", task.ProjectID)
	}
	if countTasks(t, db, "owner") != 1 {
		t.Fatalf("rows = %d", countTasks(t, db, "owner"))
	}
}

func TestSQLiteSpecializedAdmissionAcceptsLocalExecutorsWithoutCatalog(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-1", "res-1", "video/mp4")

	render, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	trans, err := svc.CreateTimelineTranscriptionTask("owner", TimelineTranscriptionCreateRequest{
		ResourceID: "res-1", Language: "zh", ProjectID: "prj-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	depth, err := svc.CreateDepthCaptureTask("owner", DepthCaptureCreateRequest{ProjectID: "prj-1", ResourceID: "res-1"})
	if err != nil {
		t.Fatal(err)
	}
	if render.Model != LocalExecutorRenderModel || trans.Model != LocalExecutorTranscriptionModel || depth.LogicalModelID != "" {
		t.Fatalf("schema render=%s trans=%s depth.logical=%q", render.Model, trans.Model, depth.LogicalModelID)
	}
	if countTasks(t, db, "owner") != 3 {
		t.Fatalf("rows = %d", countTasks(t, db, "owner"))
	}
}

func TestSQLiteConcurrentClientOperationReplaysOriginal(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-1", "res-1", "video/mp4")
	req := TimelineTranscriptionCreateRequest{
		ResourceID: "res-1", Language: "zh", ProjectID: "prj-1", ClientOperationID: "timeline:race-1",
	}
	const workers = 8
	var wg sync.WaitGroup
	ids := make([]string, workers)
	errs := make([]error, workers)
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func(i int) {
			defer wg.Done()
			task, err := svc.CreateTimelineTranscriptionTask("owner", req)
			errs[i] = err
			if task != nil {
				ids[i] = task.ID
			}
		}(i)
	}
	wg.Wait()
	var first string
	for i := 0; i < workers; i++ {
		if errs[i] != nil {
			t.Fatalf("worker %d: %v", i, errs[i])
		}
		if ids[i] == "" {
			t.Fatalf("worker %d returned empty id", i)
		}
		if first == "" {
			first = ids[i]
		} else if ids[i] != first {
			t.Fatalf("ids diverged: %q %q", first, ids[i])
		}
	}
	if countTasks(t, db, "owner") != 1 {
		t.Fatalf("rows = %d", countTasks(t, db, "owner"))
	}
}

func TestSQLiteClientOperationMismatchRejectsWithoutInsert(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-1", "res-1", "video/mp4")
	seedSQLiteUser(t, db, "owner", "", "res-2", "video/mp4")
	first, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-1"), ClientOperationID: "timeline:mismatch-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-2"), ClientOperationID: "timeline:mismatch-1",
	})
	if err == nil || !isStatus(err, 409) {
		t.Fatalf("mismatch = %v", err)
	}
	if countTasks(t, db, "owner") != 1 {
		t.Fatalf("rows = %d", countTasks(t, db, "owner"))
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", first.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.ID != first.ID {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestSQLiteInactiveAndForeignProjectWriteZeroRows(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-active", "res-1", "video/mp4")
	if err := db.Create(&model.Project{ID: "prj-archived", UserID: "owner", Name: "旧项目", Status: model.ProjectStatusArchived}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Project{ID: "prj-foreign", UserID: "other", Name: "别人的项目", Status: model.ProjectStatusActive}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CanvasProject{ID: "canvas-foreign", UserID: "other", Title: "别人的画布", Revision: 1}).Error; err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name      string
		projectID string
		want      string
	}{
		{"archived", "prj-archived", TaskScopeArchivedMessage},
		{"foreign-project", "prj-foreign", TaskScopeUnavailableMessage},
		{"foreign-canvas", "canvas-foreign", TaskScopeUnavailableMessage},
		{"missing", "missing-project", TaskScopeUnavailableMessage},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			_, err := svc.CreateTimelineTranscriptionTask("owner", TimelineTranscriptionCreateRequest{
				ResourceID: "res-1", ProjectID: item.projectID, ClientOperationID: "timeline:" + item.name,
			})
			var appErr *kernel.AppError
			if err == nil || err.Error() != item.want {
				t.Fatalf("err = %v, want %q", err, item.want)
			}
			if !errors.As(err, &appErr) || appErr.Status != 400 {
				t.Fatalf("status = %v", err)
			}
			if countTasks(t, db, "") != 0 {
				t.Fatalf("rejected scope persisted rows")
			}
		})
	}
}

func TestSQLiteForeignOwnerCannotReuseClientOperation(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-owner", "res-owner", "video/mp4")
	seedSQLiteUser(t, db, "intruder", "prj-intruder", "res-intruder", "video/mp4")
	created, err := svc.CreateDepthCaptureTask("owner", DepthCaptureCreateRequest{
		ProjectID: "prj-owner", ResourceID: "res-owner", ClientOperationID: "depth:shared-key", NodeID: " node-depth ",
	})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := repository.New(db).Task(created.ID)
	if err != nil || TargetBindingFromInput(stored.InputJSON).NodeID != "node-depth" || TargetBindingFromInput(stored.InputJSON).Source != "canvas" {
		t.Fatalf("depth binding not persisted: %#v %v", stored, err)
	}
	intruder, err := svc.CreateDepthCaptureTask("intruder", DepthCaptureCreateRequest{
		ProjectID: "prj-intruder", ResourceID: "res-intruder", ClientOperationID: "depth:shared-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if intruder.ID == created.ID {
		t.Fatal("foreign caller reused another owner's client operation")
	}
	if countTasks(t, db, "owner") != 1 || countTasks(t, db, "intruder") != 1 {
		t.Fatalf("owner=%d intruder=%d", countTasks(t, db, "owner"), countTasks(t, db, "intruder"))
	}
}

func TestSQLiteDrainRejectsNewAndReplaysExisting(t *testing.T) {
	svc, db, runtime := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-1", "res-1", "video/mp4")
	created, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-1"), ClientOperationID: "timeline:drain-sql",
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.draining.Store(true)
	replay, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-1"), ClientOperationID: "timeline:drain-sql",
	})
	if err != nil || replay.ID != created.ID {
		t.Fatalf("drain replay = %+v err=%v", replay, err)
	}
	_, err = svc.CreateTimelineTranscriptionTask("owner", TimelineTranscriptionCreateRequest{ResourceID: "res-1", ProjectID: "prj-1"})
	if !isStatus(err, 503) {
		t.Fatalf("drain create = %v", err)
	}
	if countTasks(t, db, "owner") != 1 {
		t.Fatalf("drain rows = %d", countTasks(t, db, "owner"))
	}
}

func TestSQLiteUnknownResourceDoesNotInsert(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-1", "", "")
	_, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-missing"),
	})
	if err == nil {
		t.Fatal("missing render resource admitted")
	}
	_, err = svc.CreateTimelineTranscriptionTask("owner", TimelineTranscriptionCreateRequest{ResourceID: "res-missing", ProjectID: "prj-1"})
	if err == nil || err.Error() != MissingTranscribableMediaMessage {
		t.Fatalf("missing transcription resource = %v", err)
	}
	if countTasks(t, db, "owner") != 0 {
		t.Fatalf("missing resource rows = %d", countTasks(t, db, "owner"))
	}
}
