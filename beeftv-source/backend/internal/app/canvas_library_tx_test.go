package app

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestHostedCanvasDrawingWriteDoesNotDeadlockOnSingleSQLiteConn(t *testing.T) {
	svc := newHostedCanvasLibraryService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
			done <- err
			return
		}
		created, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", drawingPayload(0, `{"v":1}`))
		if err != nil {
			done <- err
			return
		}
		_, err = svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", drawingPayload(created.Revision, `{"v":2}`))
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("hosted drawing create/update deadlocked on the single SQLite connection")
	}
}

func TestHostedCanvasDrawingAboveEightMiBAcceptedUnderQuota(t *testing.T) {
	svc := newHostedCanvasLibraryService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
			done <- err
			return
		}
		raw, err := json.Marshal(map[string]any{
			"drawingId": "sketch", "engine": "excalidraw", "revision": 0,
			"snapshot":   map[string]any{"pad": strings.Repeat("a", 9<<20)},
			"shapeCount": 1, "pageCount": 1,
		})
		if err != nil {
			done <- err
			return
		}
		if len(raw) <= 8<<20 {
			done <- errors.New("fixture too small")
			return
		}
		_, err = svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("hosted 9MiB drawing write deadlocked on the single SQLite connection")
	}
}

func TestHostedCanvasDrawingAboveEightMiBRejectedWhenQuotaInsufficient(t *testing.T) {
	svc := newHostedCanvasLibraryService(t)
	policy := defaultRuntimePolicy()
	policy.Resource.StructuredDataMB = 8
	rawPolicy, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.DB().Create(&model.SystemSetting{Key: "runtime_policy", ValueJSON: string(rawPolicy)}).Error; err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
			done <- err
			return
		}
		raw, err := json.Marshal(map[string]any{
			"drawingId": "sketch", "engine": "excalidraw", "revision": 0,
			"snapshot":   map[string]any{"pad": strings.Repeat("a", 9<<20)},
			"shapeCount": 1, "pageCount": 1,
		})
		if err != nil {
			done <- err
			return
		}
		_, err = svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
		done <- err
	}()
	var writeErr error
	select {
	case writeErr = <-done:
	case <-ctx.Done():
		t.Fatal("hosted 9MiB drawing quota reject deadlocked on the single SQLite connection")
	}
	var appError *kernel.AppError
	if !errors.As(writeErr, &appError) || appError.Reason != kernel.ReasonQuotaExceeded {
		t.Fatalf("9MiB drawing over 8MB structured quota = %v", writeErr)
	}
	if strings.Contains(writeErr.Error(), "画板数据超过 8MB") {
		t.Fatalf("independent 8MB drawing cap still present: %v", writeErr)
	}
}

func newHostedCanvasLibraryService(t *testing.T) *Service {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "canvas-library.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	return New(repository.New(db), t.TempDir())
}

func drawingPayload(revision int64, snapshot string) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": revision,
		"snapshot": json.RawMessage(snapshot), "shapeCount": 1, "pageCount": 1,
	})
	return raw
}
