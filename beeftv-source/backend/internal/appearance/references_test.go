package appearance

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestReferencedIDsFailClosedOnInvalidJSON(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:appearance-refs-invalid?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.SystemSetting{Key: SettingKey, ValueJSON: "{not-json", UpdatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	svc := New(Dependencies{Settings: repository.New(db)})
	got := svc.ReferencedIDs([]string{"logo-1", "video-1", "unrelated"})
	if len(got) != 3 {
		t.Fatalf("invalid JSON referenced = %#v, want fail-closed on every candidate", got)
	}
	for _, id := range []string{"logo-1", "video-1", "unrelated"} {
		if _, exists := got[id]; !exists {
			t.Fatalf("missing fail-closed id %q in %#v", id, got)
		}
	}
}

func TestReferencedIDsOnlyMatchBoundAssets(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:appearance-refs-bound?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	value := DefaultSetting()
	value.LogoResourceID = "logo-1"
	value.AuthVideoResourceID = "video-1"
	encoded, err := jsonMarshalSetting(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.SystemSetting{Key: SettingKey, ValueJSON: encoded, UpdatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	svc := New(Dependencies{Settings: repository.New(db)})
	got := svc.ReferencedIDs([]string{"logo-1", "video-1", "unrelated"})
	if len(got) != 2 {
		t.Fatalf("bound referenced = %#v", got)
	}
	if _, exists := got["unrelated"]; exists {
		t.Fatalf("unrelated resource treated as referenced: %#v", got)
	}
}

func TestIdentityFallsBackWhenDocumentIsInvalid(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:appearance-identity-invalid?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.SystemSetting{Key: SettingKey, ValueJSON: "{bad", UpdatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	name, slug := New(Dependencies{Settings: repository.New(db)}).Identity()
	if name != DefaultBrandName || slug != DefaultBrandSlug {
		t.Fatalf("identity = %q %q", name, slug)
	}
}

func TestPublicRejectsInvalidJSON(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:appearance-public-invalid?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.SystemSetting{Key: SettingKey, ValueJSON: "{bad", UpdatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	_, err = New(Dependencies{Settings: repository.New(db)}).Public()
	if err == nil || err.Error() != "外观配置格式无效" {
		t.Fatalf("Public() error = %v", err)
	}
}
