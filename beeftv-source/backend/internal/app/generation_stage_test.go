package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestGenerationStageLeaseAndCancellation(t *testing.T) {
	for _, tc := range []struct {
		name               string
		status             model.TaskStatus
		owner              string
		expired, cancelled bool
		wantError          bool
	}{
		{name: "active", status: model.TaskStatusRunning, owner: "owner"},
		{name: "stale owner", status: model.TaskStatusRunning, owner: "replacement", wantError: true},
		{name: "expired", status: model.TaskStatusRunning, owner: "owner", expired: true, wantError: true},
		{name: "cancelled context", status: model.TaskStatusRunning, owner: "owner", cancelled: true, wantError: true},
		{name: "cancelled task", status: model.TaskStatusCancelled, owner: "owner", wantError: true},
		{name: "failed task", status: model.TaskStatusFailed, owner: "owner", wantError: true},
		{name: "succeeded task", status: model.TaskStatusSucceeded, owner: "owner", wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			sqlDB, _ := db.DB()
			defer sqlDB.Close()
			if err := db.AutoMigrate(&model.Task{}); err != nil {
				t.Fatal(err)
			}
			expires := time.Now().Add(time.Minute)
			if tc.expired {
				expires = time.Now().Add(-time.Minute)
			}
			task := model.Task{ID: "task", Status: tc.status, Stage: "original", Error: "existing error", Progress: 47, LeaseOwner: tc.owner, LeaseExpiresAt: &expires}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			port := appTaskStagePort{service: &Service{repo: repository.New(db)}, task: model.Task{ID: task.ID, LeaseOwner: "owner"}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tc.cancelled {
				cancel()
			}
			err = port.SetStage(ctx, "正在准备参考素材")
			if (err != nil) != tc.wantError {
				t.Fatalf("error = %v", err)
			}
			if tc.cancelled && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancel error = %v", err)
			}
			var got model.Task
			if err := db.First(&got, "id = ?", task.ID).Error; err != nil {
				t.Fatal(err)
			}
			wantStage := "正在准备参考素材"
			if tc.wantError {
				wantStage = task.Stage
			}
			if got.Stage != wantStage || got.Progress != task.Progress || got.Status != task.Status || got.Error != task.Error {
				t.Fatalf("stage update corrupted task: %+v", got)
			}
		})
	}
}
