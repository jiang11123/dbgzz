package diagnostics

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestZIPIncludesPersistedExecutionAndOwnedNodeBindingEvidence(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.ApiCallLog{}, &model.CanvasProject{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	operationID := "canvas:" + strings.Repeat("a", 110)
	for _, task := range []model.Task{
		{ID: "paid-video", UserID: "owner", ProjectID: "canvas-a", Type: "canvas_video", ClientOperationID: &operationID, Status: model.TaskStatusSucceeded,
			InputJSON:          `{"metadata":{"nodeId":"video-node"},"prompt":"never-export-prompt","apiKey":"never-export-key"}`,
			FailureDiagnostics: &model.TaskFailureDiagnostics{ExecutionResult: "completed", Source: "upstream_http", Requests: []model.TaskRequestEvidence{{Operation: "query_or_download", HTTPStatus: 200, ReceivedBytes: 9061231}}},
			CreatedAt:          now, UpdatedAt: now},
		{ID: "image-batch", UserID: "owner", ProjectID: "canvas-a", Type: "canvas_image", InputJSON: `{"metadata":{"nodeId":"first","outputNodeIds":["first","second"]}}`, CreatedAt: now, UpdatedAt: now},
		{ID: "foreign-canvas-task", UserID: "owner", ProjectID: "foreign-canvas", Type: "canvas_video", InputJSON: `{"metadata":{"nodeId":"foreign-node"}}`, CreatedAt: now, UpdatedAt: now},
	} {
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, project := range []model.CanvasProject{
		{ID: "canvas-a", UserID: "owner", Revision: 42, PayloadJSON: `{"title":"never-export-title","nodes":[{"id":"video-node","type":"video","metadata":{"taskId":"newer-task","taskClientOperationId":"canvas:newer","status":"loading","prompt":"never-export-node-prompt","content":"https://secret.example/video?token=never-export-url"}},{"id":"first","type":"image","metadata":{"taskId":"image-batch"}}]}`},
		{ID: "foreign-canvas", UserID: "other-owner", Revision: 99, PayloadJSON: `{"nodes":[{"id":"foreign-node","metadata":{"taskId":"never-export-foreign-task"}}]}`},
	} {
		if err := db.Create(&project).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := New(Dependencies{Store: repository.New(db)})
	bundle, err := svc.Export("owner", ExportRequest{})
	if err != nil {
		t.Fatal(err)
	}
	files := readTestZIP(t, bundle.Data)
	for name, contents := range files {
		for _, secret := range []string{"never-export", "secret.example"} {
			if strings.Contains(contents, secret) {
				t.Fatalf("%s leaked %s: %s", name, secret, contents)
			}
		}
	}
	if !strings.Contains(files["backend/tasks.jsonl"], `"receivedBytes":9061231`) || !strings.Contains(files["backend/tasks.jsonl"], operationID) {
		t.Fatal("persisted request evidence or admission identity missing")
	}
	var rows []canvasBindingRecord
	for _, line := range strings.Split(strings.TrimSpace(files["backend/canvas-bindings.jsonl"]), "\n") {
		var row canvasBindingRecord
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal(err)
		}
		rows = append(rows, row)
	}
	if len(rows) != 4 {
		t.Fatalf("bindings = %+v", rows)
	}
	var video, absent, foreign canvasBindingRecord
	for _, row := range rows {
		if row.TaskID == "paid-video" {
			video = row
		}
		if row.NodeID == "second" {
			absent = row
		}
		if row.TaskID == "foreign-canvas-task" {
			foreign = row
		}
	}
	if video.NodeTaskID != "newer-task" || video.Revision != 42 || video.NodeHasMedia == nil || !*video.NodeHasMedia || video.ClientOperationID != operationID {
		t.Fatalf("video = %+v", video)
	}
	if absent.CanvasStatus != "available" || absent.NodePresent == nil || *absent.NodePresent || absent.OutputIndex == nil || *absent.OutputIndex != 1 {
		t.Fatalf("absent = %+v", absent)
	}
	if foreign.CanvasStatus != "missing" || foreign.NodePresent != nil {
		t.Fatalf("foreign = %+v", foreign)
	}
	if !strings.Contains(files["manifest.json"], `"schemaVersion": 3`) || !strings.Contains(files["manifest.json"], `"canvasBindings": 4`) {
		t.Fatal("manifest missing binding schema/count")
	}
}
