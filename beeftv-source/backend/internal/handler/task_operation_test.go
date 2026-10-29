package handler

import (
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestTaskOperationReceiptIsReadOnlyAndScoped(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	operation := "canvas:lost-response"
	task := model.Task{ID: "accepted-original", UserID: owner.ID, ProjectID: "canvas-original", Type: "canvas_video", Prompt: "test", Status: model.TaskStatusQueued, ClientOperationID: &operation, InputJSON: `{"config":{"apiKey":"must-not-expose"},"metadata":{"nodeId":"target"}}`}
	if err := h.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	foreignKey := "canvas:another-owner"
	foreign := model.Task{ID: "foreign", UserID: "another-owner", ProjectID: "canvas-original", Type: "canvas_video", ClientOperationID: &foreignKey}
	if err := h.db.Create(&foreign).Error; err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path   string
		status int
	}{
		{"/api/tasks/by-operation/canvas:lost-response?projectId=canvas-original", 200},
		{"/api/tasks/by-operation/canvas:lost-response?projectId=other-canvas", 404},
		{"/api/tasks/by-operation/canvas:another-owner?projectId=canvas-original", 404},
		{"/api/tasks/by-operation/canvas:absent?projectId=canvas-original", 404},
		{"/api/tasks/by-operation/canvas:lost-response", 400},
		{"/api/tasks/by-operation/short?projectId=canvas-original", 400},
	} {
		response := h.do(t, http.MethodGet, tc.path, nil)
		if response.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.path, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), "must-not-expose") {
			t.Fatal("receipt exposed credentials")
		}
		if tc.status == 200 && !strings.Contains(response.Body.String(), task.ID) {
			t.Fatal("did not recover original task")
		}
	}
	var count int64
	h.db.Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatalf("receipt lookup mutated tasks: %d", count)
	}
}
