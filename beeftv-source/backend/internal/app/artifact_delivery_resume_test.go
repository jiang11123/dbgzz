package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// TestGenerationDeliveryResumesCutArtifactAndBindsNode reproduces the paid
// generation failure: the upstream artifact URL drops the connection partway
// through the first read. Delivery must resume and still bind the canvas node.
func TestGenerationDeliveryResumesCutArtifactAndBindsNode(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")

	payload := make([]byte, 40000)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	var mu sync.Mutex
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		attempt := requests
		mu.Unlock()
		start := int64(0)
		if rangeHeader := r.Header.Get("Range"); rangeHeader != "" {
			spec := strings.TrimPrefix(rangeHeader, "bytes=")
			if dash := strings.Index(spec, "-"); dash >= 0 {
				if parsed, err := strconv.ParseInt(strings.TrimSpace(spec[:dash]), 10, 64); err == nil {
					start = parsed
				}
			}
		}
		body := payload[start:]
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("ETag", `"artifact-v1"`)
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		if start > 0 {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(payload)-1, len(payload)))
			w.WriteHeader(http.StatusPartialContent)
		} else {
			w.WriteHeader(http.StatusOK)
		}
		if attempt == 1 {
			cut := len(body) * 2 / 5
			_, _ = w.Write(body[:cut])
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			panic(http.ErrAbortHandler)
		}
		_, _ = w.Write(body)
	}))
	defer server.Close()

	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "delivery-resume.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	defer sqlDB.Close()
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())

	canvasID := "canvas-resume"
	nodeID := "node-resume"
	encoded, err := json.Marshal(map[string]any{
		"id": canvasID, "title": "交付画布", "revision": 0,
		"nodes": []any{
			map[string]any{
				"id": nodeID, "type": "image", "title": "镜头", "position": map[string]any{"x": 1, "y": 1},
				"width": 320, "height": 220, "metadata": map[string]any{"taskId": "task-resume", "status": "loading"},
			},
		},
		"connections": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("local", encoded); err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	task := model.Task{
		ID: "task-resume", UserID: "local", ProjectID: canvasID, Type: "canvas_image",
		Status:     model.TaskStatusSucceeded,
		InputJSON:  fmt.Sprintf(`{"metadata":{"source":"canvas","nodeId":%q}}`, nodeID),
		ResultJSON: fmt.Sprintf(`{"images":[{"url":%q}]}`, server.URL+"/artifact.png"),
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatalf("DeliverSucceededTask() error = %v", err)
	}
	got, err := svc.Task("local", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Outputs) != 1 || got.Outputs[0].MaterializedAssetID == "" || got.Outputs[0].ResourceID == "" {
		t.Fatalf("delivery output = %#v", got.Outputs)
	}

	raw, err := svc.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Nodes []struct {
			ID       string         `json:"id"`
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	var bound bool
	for _, node := range document.Nodes {
		if node.ID == nodeID && node.Metadata["status"] == "success" && node.Metadata["content"] != nil {
			bound = true
		}
	}
	if !bound {
		t.Fatalf("node was not bound after resumable delivery: %s", string(raw))
	}
}
