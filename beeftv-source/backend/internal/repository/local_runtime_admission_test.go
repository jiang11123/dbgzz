package repository

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestTaskAdmissionWithinCreationTransactionRollsBack(t *testing.T) {
	repo, db := newAdmissionRepo(t)
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	pool.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = pool.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	rollback := errors.New("approval receipt failed")
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		task := model.Task{ID: "nested", UserID: "user", Type: "canvas_image", Status: model.TaskStatusQueued, InputJSON: `{}`}
		if err := repo.WithTx(tx).CreateTaskWithActiveLimit(&task, 10); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatalf("nested admission failed: %v", err)
	}
	var count int64
	if err := db.Model(&model.Task{}).Where("id = ?", "nested").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("task escaped failed approval transaction")
	}
}

func newAdmissionRepo(t *testing.T) (*Repository, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "admission.db")+"?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.Task{}, &model.TaskLog{}, &model.Result{}, &model.TaskTextDelta{},
		&model.Resource{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{},
		&model.Asset{}, &model.CanvasProject{},
		&model.AssetRepresentation{}, &model.VoiceProfile{}, &model.ShotArtifact{},
		&model.ArkPrivateAssetBinding{}, &model.ResourceDeletionJob{}, &model.AgentOpRecord{},
	); err != nil {
		t.Fatal(err)
	}
	return New(db), db
}

func seedReadyResource(t *testing.T, db *gorm.DB, id, userID string) model.Resource {
	t.Helper()
	resource := model.Resource{ID: id, UserID: userID, Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "users/" + userID + "/image/" + id + ".png"}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	return resource
}

func mustTaskInputResourceIDs(t *testing.T, input string) []string {
	t.Helper()
	ids, err := taskInputResourceIDs(input)
	if err != nil {
		t.Fatalf("taskInputResourceIDs(%s) err=%v", input, err)
	}
	return ids
}

func TestTaskInputResourceIDsCollectsProductFieldsAndIgnoresPublicSecrets(t *testing.T) {
	if ids := mustTaskInputResourceIDs(t, ""); len(ids) != 0 {
		t.Fatalf("empty = %v", ids)
	}
	if ids := mustTaskInputResourceIDs(t, `{"prompt":"plain text"}`); len(ids) != 0 {
		t.Fatalf("text = %v", ids)
	}
	if ids := mustTaskInputResourceIDs(t, `{"prompt":"a cat","url":"https://cdn.example/a.png","content":"https://example.com/file.mp4"}`); len(ids) != 0 {
		t.Fatalf("public urls = %v", ids)
	}
	if ids := mustTaskInputResourceIDs(t, `{"config":{"apiKey":"enc:v1:secret","headers":{"Authorization":"enc:v1:hdr"}},"prompt":"hi"}`); len(ids) != 0 {
		t.Fatalf("encrypted blobs = %v", ids)
	}
	got := mustTaskInputResourceIDs(t, `{"storageKey":"resource:res-storage","url":"/api/resources/res-file/file","resourceId":"res-field","resourceIds":["res-multi"],"sampleResourceId":"res-sample"}`)
	want := []string{"res-field", "res-file", "res-multi", "res-sample", "res-storage"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
	if ids := mustTaskInputResourceIDs(t, "resource:bare-id"); len(ids) != 1 || ids[0] != "bare-id" {
		t.Fatalf("bare resource = %v", ids)
	}
	if ids := mustTaskInputResourceIDs(t, "/api/resources/url-id/file"); len(ids) != 1 || ids[0] != "url-id" {
		t.Fatalf("bare file url = %v", ids)
	}
}

func TestTaskInputResourceIDsInvalidJSONFailsClosedAndPromptIsNotMedia(t *testing.T) {
	ids, err := taskInputResourceIDs(`{"prompt":"use resource:res-storage and /api/resources/res-file/file"}`)
	if err != nil || len(ids) != 0 {
		t.Fatalf("prompt syntax ids=%v err=%v", ids, err)
	}
	if ids, err := taskInputResourceIDs(`{not-json`); !errors.Is(err, ErrTaskInputInvalid) || ids != nil {
		t.Fatalf("invalid json ids=%v err=%v", ids, err)
	}
	if ids, err := taskInputResourceIDs(`please use resource:res-storage`); !errors.Is(err, ErrTaskInputInvalid) || ids != nil {
		t.Fatalf("plain prompt ids=%v err=%v", ids, err)
	}
}

func TestCreateTaskWithActiveLimitRejectsInvalidJSON(t *testing.T) {
	repo, db := newAdmissionRepo(t)
	task := &model.Task{ID: "task-bad-json", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusQueued, InputJSON: `{not-json`}
	if err := repo.CreateTaskWithActiveLimit(task, 8); !errors.Is(err, ErrTaskInputInvalid) {
		t.Fatalf("invalid json error = %v", err)
	}
	var count int64
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("invalid json inserted a row")
	}
}

func TestCreateTaskWithActiveLimitIgnoresPromptEmbeddedResourceSyntax(t *testing.T) {
	repo, _ := newAdmissionRepo(t)
	task := &model.Task{
		ID: "task-prompt-syntax", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusQueued,
		InputJSON: `{"prompt":"use resource:res-storage and /api/resources/res-file/file"}`,
	}
	if err := repo.CreateTaskWithActiveLimit(task, 8); err != nil {
		t.Fatalf("prompt syntax treated as media: %v", err)
	}
}

func TestRetryTaskRejectsInvalidJSON(t *testing.T) {
	repo, db := newAdmissionRepo(t)
	failed := &model.Task{ID: "task-retry-bad-json", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusFailed, InputJSON: `{"prompt":"ok"}`}
	if err := db.Create(failed).Error; err != nil {
		t.Fatal(err)
	}
	failed.InputJSON = `{not-json`
	if _, err := repo.RetryTask("user-1", failed, 8); !errors.Is(err, ErrTaskInputInvalid) {
		t.Fatalf("retry invalid json error = %v", err)
	}
	var still model.Task
	if err := db.First(&still, "id = ?", failed.ID).Error; err != nil || still.Status != model.TaskStatusFailed {
		t.Fatalf("retry mutated failed task: %#v err=%v", still, err)
	}
}

func TestCreateTaskWithActiveLimitAdmitsOrdinaryInputs(t *testing.T) {
	repo, _ := newAdmissionRepo(t)
	for _, item := range []struct {
		id    string
		input string
	}{
		{"task-text", `{"prompt":"hello"}`},
		{"task-media", `{"prompt":"a cat","mode":"image"}`},
		{"task-https", `{"url":"https://cdn.example/ref.png"}`},
		{"task-secret", `{"apiKey":"enc:v1:blob","headers":{"X-Key":"enc:v1:hdr"}}`},
	} {
		task := &model.Task{ID: item.id, UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusQueued, InputJSON: item.input}
		if err := repo.CreateTaskWithActiveLimit(task, 8); err != nil {
			t.Fatalf("%s: %v", item.id, err)
		}
	}
}

func TestCreateTaskWithActiveLimitRejectsUnreadyReferences(t *testing.T) {
	repo, db := newAdmissionRepo(t)
	ready := seedReadyResource(t, db, "res-ready", "user-1")
	pending := model.Resource{ID: "res-pending", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending, Provider: "local", ObjectKey: "users/user-1/image/pending.png"}
	failed := model.Resource{ID: "res-failed", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed, Provider: "local", ObjectKey: "users/user-1/image/failed.png"}
	foreign := seedReadyResource(t, db, "res-foreign", "user-2")
	for _, item := range []any{&pending, &failed} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	admitted := &model.Task{ID: "task-ready-ref", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusQueued, InputJSON: `{"storageKey":"resource:` + ready.ID + `"}`}
	if err := repo.CreateTaskWithActiveLimit(admitted, 8); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		id    string
		input string
	}{
		{"task-pending", `{"resourceId":"` + pending.ID + `"}`},
		{"task-failed", `{"url":"/api/resources/` + failed.ID + `/file"}`},
		{"task-missing", `{"storageKey":"resource:res-missing"}`},
		{"task-foreign", `{"referenceResourceId":"` + foreign.ID + `"}`},
	}
	for _, item := range cases {
		task := &model.Task{ID: item.id, UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusQueued, InputJSON: item.input}
		if err := repo.CreateTaskWithActiveLimit(task, 8); !errors.Is(err, ErrResourceNotReadyForAdmission) {
			t.Fatalf("%s error = %v", item.id, err)
		}
		var count int64
		if err := db.Model(&model.Task{}).Where("id = ?", item.id).Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s inserted a row", item.id)
		}
	}
}

func TestRetryTaskRequiresReadyOwnedResources(t *testing.T) {
	repo, db := newAdmissionRepo(t)
	ready := seedReadyResource(t, db, "res-retry-ready", "user-1")
	pending := model.Resource{ID: "res-retry-pending", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending, Provider: "local", ObjectKey: "users/user-1/image/retry-pending.png"}
	if err := db.Create(&pending).Error; err != nil {
		t.Fatal(err)
	}
	failed := &model.Task{ID: "task-retry", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusFailed, InputJSON: `{"resourceId":"` + pending.ID + `"}`}
	if err := db.Create(failed).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RetryTask("user-1", failed, 8); !errors.Is(err, ErrResourceNotReadyForAdmission) {
		t.Fatalf("pending retry error = %v", err)
	}
	var still model.Task
	if err := db.First(&still, "id = ?", failed.ID).Error; err != nil || still.Status != model.TaskStatusFailed {
		t.Fatalf("retry mutated failed task: %#v err=%v", still, err)
	}
	failed.InputJSON = `{"resourceId":"` + ready.ID + `"}`
	retried, err := repo.RetryTask("user-1", failed, 8)
	if err != nil || retried.Status != model.TaskStatusQueued {
		t.Fatalf("ready retry = %#v err=%v", retried, err)
	}
}

func TestCreateTaskAndDeleteDetachedDoNotDropQueuedMaterial(t *testing.T) {
	repo, db := newAdmissionRepo(t)
	resource := seedReadyResource(t, db, "res-race", "user-1")
	task := &model.Task{
		ID: "task-race", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusQueued,
		InputJSON: `{"storageKey":"resource:` + resource.ID + `"}`,
	}
	var createErr, deleteErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		createErr = repo.CreateTaskWithActiveLimit(task, 8)
	}()
	go func() {
		defer wg.Done()
		deleteErr = repo.DeleteDetachedResources([]model.Resource{resource}, nil)
	}()
	wg.Wait()
	if deleteErr != nil && !errors.Is(deleteErr, ErrResourceCleanupStillReferenced) && !errors.Is(deleteErr, ErrResourceCleanupSetChanged) {
		t.Fatalf("delete: %v", deleteErr)
	}
	if createErr != nil && !errors.Is(createErr, ErrResourceNotReadyForAdmission) {
		t.Fatalf("create: %v", createErr)
	}
	if deleteErr == nil && createErr == nil {
		t.Fatal("delete and admission both committed")
	}
	var resourceCount, taskCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&resourceCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Count(&taskCount).Error; err != nil {
		t.Fatal(err)
	}
	if taskCount == 1 && resourceCount == 0 {
		t.Fatal("queued task lost its material")
	}
	if createErr == nil && resourceCount != 1 {
		t.Fatalf("admitted task but resource count=%d", resourceCount)
	}
}

func TestRetryTaskAndDeleteDetachedDoNotDropMaterial(t *testing.T) {
	repo, db := newAdmissionRepo(t)
	resource := seedReadyResource(t, db, "res-retry-race", "user-1")
	failed := &model.Task{
		ID: "task-retry-race", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusFailed,
		InputJSON: `{"storageKey":"resource:` + resource.ID + `"}`,
	}
	if err := db.Create(failed).Error; err != nil {
		t.Fatal(err)
	}
	var retryErr, deleteErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, retryErr = repo.RetryTask("user-1", failed, 8)
	}()
	go func() {
		defer wg.Done()
		deleteErr = repo.DeleteDetachedResources([]model.Resource{resource}, nil)
	}()
	wg.Wait()
	if deleteErr != nil && !errors.Is(deleteErr, ErrResourceCleanupStillReferenced) && !errors.Is(deleteErr, ErrResourceCleanupSetChanged) {
		t.Fatalf("delete: %v", deleteErr)
	}
	if retryErr != nil && !errors.Is(retryErr, ErrResourceNotReadyForAdmission) && !errors.Is(retryErr, ErrTaskNotRetryable) {
		t.Fatalf("retry: %v", retryErr)
	}
	if deleteErr == nil && retryErr == nil {
		t.Fatal("delete and retry both committed")
	}
	var resourceCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&resourceCount).Error; err != nil {
		t.Fatal(err)
	}
	var task model.Task
	if err := db.First(&task, "id = ?", failed.ID).Error; err != nil {
		t.Fatal(err)
	}
	if retryErr == nil && (task.Status != model.TaskStatusQueued || resourceCount != 1) {
		t.Fatalf("retried task lost material status=%s resource=%d", task.Status, resourceCount)
	}
	if errors.Is(deleteErr, ErrResourceCleanupStillReferenced) && resourceCount != 1 {
		t.Fatalf("blocked delete dropped resource count=%d", resourceCount)
	}
}

func TestDeleteDetachedResourcesInspectsQueuedAndCompletedTasks(t *testing.T) {
	repo, db := newAdmissionRepo(t)
	queuedRes := seedReadyResource(t, db, "res-queued", "user-1")
	completedRes := seedReadyResource(t, db, "res-completed", "user-1")
	orphan := seedReadyResource(t, db, "res-orphan", "user-1")
	if err := db.Create(&model.Task{
		ID: "task-queued-ref", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusQueued,
		InputJSON: `{"storageKey":"resource:` + queuedRes.ID + `"}`,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{
		ID: "task-completed-ref", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"resourceId":"` + completedRes.ID + `"}]}`,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteDetachedResources([]model.Resource{queuedRes}, nil); !errors.Is(err, ErrResourceCleanupStillReferenced) {
		t.Fatalf("queued delete = %v", err)
	}
	if err := repo.DeleteDetachedResources([]model.Resource{completedRes}, nil); !errors.Is(err, ErrResourceCleanupStillReferenced) {
		t.Fatalf("completed delete = %v", err)
	}
	if err := repo.DeleteDetachedResources([]model.Resource{orphan}, nil); err != nil {
		t.Fatalf("orphan delete = %v", err)
	}
	var leftover int64
	if err := db.Model(&model.Resource{}).Where("id = ?", orphan.ID).Count(&leftover).Error; err != nil || leftover != 0 {
		t.Fatalf("orphan remained count=%d err=%v", leftover, err)
	}
}
