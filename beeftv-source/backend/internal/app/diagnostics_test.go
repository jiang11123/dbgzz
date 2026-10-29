package app

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestUpdateLogsExportOnlyFromLocalWorkspace(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	line := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339) + " v1.7.20 update phase=extracting\n"
	if err := os.WriteFile(filepath.Join(dir, "update.log"), []byte(line), 0600); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []serviceMode{serviceModeLocal, serviceModeHosted} {
		svc := &Service{repo: repository.New(db), dataDir: dir, mode: mode}
		bundle, err := svc.ExportDiagnosticBundle("local-user", DiagnosticExportRequest{})
		if err != nil {
			t.Fatal(err)
		}
		archive, err := zip.NewReader(bytes.NewReader(bundle.Data), int64(len(bundle.Data)))
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, file := range archive.File {
			if file.Name != "desktop/update.log" {
				continue
			}
			found = true
			reader, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(reader)
			reader.Close()
			if err != nil || string(body) != line {
				t.Fatalf("wrong log: %s %v", body, err)
			}
		}
		if found != (mode == serviceModeLocal) {
			t.Fatalf("mode=%s log included=%t", mode, found)
		}
	}
}

func TestExportDiagnosticBundleAdapterRejectsForeignTask(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:diagnostics-adapter-ownership?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "foreign-task", UserID: "user-2", CreatedAt: time.Now(), UpdatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	_, err = (&Service{repo: repository.New(db)}).ExportDiagnosticBundle("user-1", DiagnosticExportRequest{TaskID: "foreign-task"})
	if err == nil || !strings.Contains(err.Error(), "任务不存在或无权访问") {
		t.Fatalf("foreign task error = %v", err)
	}
}
