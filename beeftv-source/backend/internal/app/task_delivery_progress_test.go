package app

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
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

// TestGenerationDeliveryProgressIsProjectedWhileDownloading drives a slow
// artifact download and checks the task projection exposes live delivery
// progress, then drops it once delivery finishes.
func TestGenerationDeliveryProgressIsProjectedWhileDownloading(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")

	const chunkSize = 1000
	const chunks = 60
	payload := make([]byte, chunkSize*chunks)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	var mu sync.Mutex
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		w.WriteHeader(http.StatusOK)
		for offset := 0; offset < len(payload); offset += chunkSize {
			end := offset + chunkSize
			if end > len(payload) {
				end = len(payload)
			}
			_, _ = w.Write(payload[offset:end])
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			time.Sleep(30 * time.Millisecond)
		}
	}))
	defer server.Close()

	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "delivery-progress.db")),
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

	now := time.Now()
	task := model.Task{
		ID: "task-progress", UserID: "local", Type: "canvas_image",
		Status:     model.TaskStatusSucceeded,
		ResultJSON: fmt.Sprintf(`{"images":[{"url":%q}]}`, server.URL+"/artifact.png"),
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() { done <- svc.DeliverSucceededTask(task) }()

	samples := []int64{}
	totals := []int64{}
	deadline := time.Now().Add(10 * time.Second)
	for {
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("DeliverSucceededTask() error = %v", err)
			}
		default:
			if time.Now().After(deadline) {
				t.Fatal("artifact download did not finish")
			}
			got, err := svc.Task("local", task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Delivery != nil && len(got.Delivery.Outputs) > 0 {
				output := got.Delivery.Outputs[0]
				if output.OutputIndex != 0 {
					t.Fatalf("outputIndex = %d, want 0", output.OutputIndex)
				}
				if output.State != "downloading" {
					t.Fatalf("state = %q, want downloading", output.State)
				}
				samples = append(samples, output.DownloadedBytes)
				totals = append(totals, output.TotalBytes)
			}
			time.Sleep(20 * time.Millisecond)
			continue
		}
		break
	}

	if len(samples) < 2 {
		t.Fatalf("delivery progress samples = %v, want at least two while downloading", samples)
	}
	for index := 1; index < len(samples); index++ {
		if samples[index] < samples[index-1] {
			t.Fatalf("downloaded bytes decreased: %v", samples)
		}
	}
	if samples[len(samples)-1]-samples[0] < chunkSize {
		t.Fatalf("downloaded bytes did not grow: %v", samples)
	}
	if samples[len(samples)-1] > int64(len(payload)) {
		t.Fatalf("downloaded bytes = %d exceed payload %d", samples[len(samples)-1], len(payload))
	}
	sawTotal := false
	for _, total := range totals {
		if total == int64(len(payload)) {
			sawTotal = true
			continue
		}
		if total != -1 {
			t.Fatalf("unexpected total %d in %v", total, totals)
		}
	}
	if !sawTotal {
		t.Fatalf("never reported the known total %d in %v", len(payload), totals)
	}

	got, err := svc.Task("local", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Delivery != nil {
		t.Fatalf("delivery still projected after completion: %+v", got.Delivery)
	}
	if len(got.Outputs) != 1 || got.Outputs[0].MaterializedAssetID == "" {
		t.Fatalf("delivered output = %#v", got.Outputs)
	}
}
