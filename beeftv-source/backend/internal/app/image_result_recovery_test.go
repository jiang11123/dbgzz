package app

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestRetryAcceptedImageUsesOriginalReceiptWithoutCreate(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, db, _, _ := creationTestService(t)
	png, _ := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
	gets := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Fatal("recovery submitted another paid generation")
		}
		gets++
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer srv.Close()
	task := model.Task{ID: "old-download-failed", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed, Error: "context deadline exceeded", InputJSON: `{"mode":"image"}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	receipt := model.ApiCallLog{ID: "original-receipt", UserID: task.UserID, TaskID: task.ID, Capability: "image", RequestKind: "create", Method: "POST", Path: "/v1/images/generations", APIFormat: "openai", Status: model.ApiCallStatusSucceeded, StatusCode: 200, ResponseBody: fmt.Sprintf(`{"data":[{"url":%q}]}`, srv.URL+"/original.png")}
	if err := db.Create(&receipt).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.RetryTask("other", task.ID); err == nil {
		t.Fatal("foreign owner recovered task")
	}
	restored, err := s.RetryTask(task.UserID, task.ID)
	if err != nil || restored.ID != task.ID || restored.Status != model.TaskStatusSucceeded || gets != 0 {
		t.Fatalf("retry did not restore original receipt: %+v err=%v gets=%d", restored, err, gets)
	}
	stored, _ := s.repo.Task(task.ID)
	if err := s.DeliverSucceededTask(*stored); err != nil {
		t.Fatal(err)
	}
	if gets != 1 {
		t.Fatalf("original download count=%d", gets)
	}
	var count int64
	if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("new task created: %d %v", count, err)
	}
}

func TestImageReceiptRecoveryRejectsAmbiguousAndFailedCreates(t *testing.T) {
	for _, tc := range []string{"failed", "unknown-later", "null-later", "accepted-201", "accepted-202", "accepted-204", "malformed", "no-data", "business-error"} {
		t.Run(tc, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			task := model.Task{ID: "task", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			receipt := model.ApiCallLog{ID: "receipt", UserID: task.UserID, TaskID: task.ID, Capability: "image", RequestKind: "create", Method: "POST", Path: "/v1/images/edits", APIFormat: "openai", Status: model.ApiCallStatusSucceeded, StatusCode: 200, ResponseBody: `{"data":[{"url":"https://8.8.8.8/image.png"}]}`}
			switch tc {
			case "failed":
				receipt.StatusCode = 500
			case "malformed":
				receipt.ResponseBody = `{"data":[`
			case "no-data":
				receipt.ResponseBody = `{"data":[]}`
			case "business-error":
				receipt.ResponseBody = `{"code":500,"data":[{"url":"https://8.8.8.8/image.png"}]}`
			case "accepted-201":
				receipt.StatusCode = 201
			case "accepted-202":
				receipt.StatusCode = 202
			case "accepted-204":
				receipt.StatusCode = 204
			}
			if err := db.Create(&receipt).Error; err != nil {
				t.Fatal(err)
			}
			if tc == "unknown-later" || tc == "null-later" {
				receipt.ID = "unknown"
				receipt.StatusCode = 0
				if err := db.Create(&receipt).Error; err != nil {
					t.Fatal(err)
				}
				if tc == "null-later" {
					if err := db.Model(&receipt).Update("status_code", nil).Error; err != nil {
						t.Fatal(err)
					}
				}
			}
			if tc == "unknown-later" || tc == "null-later" || strings.HasPrefix(tc, "accepted-") || tc == "malformed" || tc == "no-data" {
				if _, err := s.RetryTask(task.UserID, task.ID); err == nil {
					t.Fatal("uncertain receipt allowed paid retry")
				}
				stored, _ := s.repo.Task(task.ID)
				if stored.Status != model.TaskStatusFailed {
					t.Fatal("uncertain task requeued")
				}
				return
			}
			if _, handled, err := s.recoverAcceptedImage(task); handled || err != nil {
				t.Fatalf("ambiguous receipt restored: %v %v", handled, err)
			}
		})
	}
}
