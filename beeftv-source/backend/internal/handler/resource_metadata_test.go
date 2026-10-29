package handler

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func metadataRouteFixture(t *testing.T) (*gin.Engine, *gorm.DB, *model.Resource) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "meta.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.NewLocal(repository.New(db), dir)
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	var wave bytes.Buffer
	wave.WriteString("RIFF")
	_ = binary.Write(&wave, binary.LittleEndian, uint32(16036))
	wave.WriteString("WAVEfmt ")
	for _, value := range []any{uint32(16), uint16(1), uint16(1), uint32(8000), uint32(16000), uint16(2), uint16(16)} {
		_ = binary.Write(&wave, binary.LittleEndian, value)
	}
	wave.WriteString("data")
	_ = binary.Write(&wave, binary.LittleEndian, uint32(16000))
	wave.Write(make([]byte, 16000))
	if err := os.MkdirAll(filepath.Join(dir, "resources"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "resources", "voice.wav"), wave.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{ID: "legacy-audio", UserID: owner.ID, Kind: "audio", MimeType: "audio/wav", Provider: "local", ObjectKey: "voice.wav", Status: model.ResourceStatusReady, Size: int64(wave.Len())}
	if err := db.Create(resource).Error; err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	RegisterUserDataRoutes(router.Group("/api"), svc)
	return router, db, resource
}

func TestEnsureMetadataRouteCancellationDoesNotMarkResourceFailed(t *testing.T) {
	router, db, resource := metadataRouteFixture(t)
	t.Setenv(mediatools.FFprobePathEnv, filepath.Join(t.TempDir(), "must-not-start"))
	for _, tc := range []struct {
		name     string
		status   int
		deadline bool
	}{{"cancel", 499, false}, {"deadline", 408, true}} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			if tc.deadline {
				cancel()
				ctx, cancel = context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
			}
			cancel()
			request := httptest.NewRequest(http.MethodGet, "/api/resources/legacy-audio?metadata=ensure", nil).WithContext(ctx)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != tc.status {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			var persisted model.Resource
			if err := db.First(&persisted, "id = ?", resource.ID).Error; err != nil {
				t.Fatal(err)
			}
			if persisted.Status != model.ResourceStatusReady || persisted.DurationMs != 0 || persisted.Error != "" {
				t.Fatalf("cancel mutated resource: %+v", persisted)
			}
		})
	}
}

func TestEnsureMetadataRouteProbesOwnedWAVOnly(t *testing.T) {
	if _, err := mediatools.ResolveFFprobe(); err != nil {
		t.Skip(err)
	}
	router, db, resource := metadataRouteFixture(t)
	foreign := *resource
	foreign.ID, foreign.UserID = "foreign-audio", "other-owner"
	if err := db.Create(&foreign).Error; err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		id     string
		status int
	}{{foreign.ID, 404}, {resource.ID, 200}} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/resources/"+tc.id+"?metadata=ensure", nil))
		if response.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.id, response.Code, response.Body.String())
		}
		if tc.status == 200 {
			var envelope struct {
				Data struct {
					Resource model.Resource `json:"resource"`
				} `json:"data"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Data.Resource.DurationMs != 1000 {
				t.Fatalf("metadata = %s, %v", response.Body.String(), err)
			}
		}
	}
	var owned, untouched model.Resource
	if err := db.First(&owned, "id = ?", resource.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&untouched, "id = ?", foreign.ID).Error; err != nil {
		t.Fatal(err)
	}
	if owned.DurationMs != 1000 || untouched.DurationMs != 0 {
		t.Fatalf("owned=%d foreign=%d", owned.DurationMs, untouched.DurationMs)
	}
}
