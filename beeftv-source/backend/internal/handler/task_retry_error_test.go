package handler

import (
	"net/http"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

func TestTaskRetryHandlerPreservesStructuredErrors(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name    string
		status  model.TaskStatus
		stage   string
		drain   bool
		want    int
		reason  string
		message string
	}{
		{"paused delivery during drain", model.TaskStatusSucceeded, "delivery_paused", true, http.StatusServiceUnavailable, "unavailable", localtask.DrainRetryMessage},
		{"failed task during drain", model.TaskStatusFailed, "任务失败", true, http.StatusServiceUnavailable, "unavailable", localtask.DrainRetryMessage},
		{"ordinary retry error", model.TaskStatusSucceeded, "生成完成", false, http.StatusBadRequest, "invalid_argument", localtask.RetryOnlyFailedOrCancelled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "retry-errors.db")),
				&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
			if err != nil {
				t.Fatal(err)
			}
			if err := database.MigrateLocalSchema(db); err != nil {
				t.Fatal(err)
			}
			service := app.NewLocal(repository.New(db), t.TempDir())
			t.Cleanup(func() { _ = service.Close() })
			owner, err := service.LocalWorkspaceOwner()
			if err != nil {
				t.Fatal(err)
			}
			task := model.Task{ID: "retry-errors", UserID: owner.ID, Type: "canvas_video", Status: tc.status, Stage: tc.stage}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if tc.drain {
				service.BeginDrain()
			}
			router := gin.New()
			router.Use(RuntimeDependenciesMiddleware(defaultRuntimeDependencies(service)))
			RegisterTaskRoutes(router.Group("/api"), service)

			response := creationAuthCall(t, router, http.MethodPost, "/api/tasks/retry-errors/retry", nil, "{}")
			body := decodeFailureEnvelope(t, response)
			if response.Code != tc.want || body.Code != tc.want || body.Reason != tc.reason || body.Msg != tc.message {
				t.Fatalf("response = status %d, body %+v; want status/code %d, reason %q, message %q", response.Code, body, tc.want, tc.reason, tc.message)
			}
			stored := loadTask(t, db, task.ID)
			if stored.Status != tc.status || stored.Stage != tc.stage || stored.RouteRun != 0 {
				t.Fatalf("rejected retry changed task: %+v", stored)
			}
		})
	}
}
