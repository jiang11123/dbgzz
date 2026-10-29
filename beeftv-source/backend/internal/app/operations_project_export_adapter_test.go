package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestCanvasProjectExportUsesSameTransactionAndReusesArchive(t *testing.T) {
	svc := newResourceTestService(t)
	db := svc.repo.DB()
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	media, err := svc.resourceDomain().StoreGenerated("owner", "image", "first.png", "image/png", int64(imageBytes.Len()), 2, 2, 0, bytes.NewReader(imageBytes.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := json.Marshal(map[string]any{"id": "portrait", "title": "雨夜旧书店", "nodes": []any{map[string]any{"metadata": map[string]any{"storageKey": "resource:" + media.ID}}}, "timeline": map[string]any{"output": map[string]any{"width": 720, "height": 1280}}})
	var first *model.Resource
	for i := 0; i < 2; i++ {
		err = db.Transaction(func(tx *gorm.DB) error {
			resource, err := svc.BindDomain(tx).(operations.CanvasProjectExporter).ExportCanvasProjectArchive(context.Background(), "owner", "stable-export", doc)
			if err != nil {
				return err
			}
			if first == nil {
				first = resource
			} else if first.ID != resource.ID {
				t.Fatal("duplicate archive")
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if first.Status != model.ResourceStatusReady || first.MimeType != "application/zip" || first.Size == 0 {
		t.Fatalf("bad archive resource %+v", first)
	}
	_, reader, err := svc.OpenResource("owner", first.ID)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(reader)
	reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	z, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	if len(z.File) != 2 {
		t.Fatalf("zip entries %d", len(z.File))
	}
	var count int64
	db.Model(&model.Resource{}).Where("user_id = ?", "owner").Count(&count)
	if count != 2 {
		t.Fatalf("resource count %d", count)
	}
	db.Model(&model.UserUploadReservation{}).Count(&count)
	if count != 0 {
		t.Fatalf("quota witness leaked: %d", count)
	}
	if _, _, err := svc.OpenResource("foreign", first.ID); err == nil {
		t.Fatal("foreign download")
	}
	// The document's reference does not confer ownership of another user's media.
	err = db.Transaction(func(tx *gorm.DB) error {
		_, err := svc.BindDomain(tx).(operations.CanvasProjectExporter).ExportCanvasProjectArchive(context.Background(), "foreign", "foreign-export", doc)
		return err
	})
	if err == nil {
		t.Fatal("exported foreign media")
	}
}
