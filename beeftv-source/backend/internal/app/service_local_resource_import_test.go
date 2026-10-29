package app

import (
	"testing"

	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestLocalServiceRejectsRemoteResourceImport(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())

	_, err = svc.ImportResourceURL("local", "https://example.invalid/image.png", "image", 0, 0, 0)
	if err == nil || err.Error() != "本地工作区不支持通过 URL 导入素材，请先下载到本机后上传" {
		t.Fatalf("ImportResourceURL() error = %v", err)
	}
}
