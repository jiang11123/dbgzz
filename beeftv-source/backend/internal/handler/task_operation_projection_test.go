package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestTaskOperationReceiptKeepsOriginalTargetWithoutCredentials(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	operation := "canvas:public-recovery-target"
	task := model.Task{ID: "original-target-receipt", UserID: owner.ID, ProjectID: "original-canvas", Type: "canvas_video", Status: model.TaskStatusRunning, ClientOperationID: &operation,
		InputJSON: `{"mode":"video","config":{"apiKey":"must-not-expose","baseUrl":"https://private.example"},"referenceImages":[{"url":"https://private.example/image"}],"metadata":{"nodeId":"original-target","sourceNodeId":"original-source","clientOperationId":"canvas:public-recovery-target"}}`}
	if err := h.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	response := h.do(t, http.MethodGet, "/api/tasks/by-operation/"+operation+"?projectId=original-canvas", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("receipt: %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "must-not-expose") || strings.Contains(response.Body.String(), "private.example") {
		t.Fatal("receipt exposed private input")
	}
	var envelope struct {
		Data struct {
			ID                string `json:"id"`
			ProjectID         string `json:"projectId"`
			ClientOperationID string `json:"clientOperationId"`
			InputJSON         string `json:"inputJson"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.ID != task.ID || envelope.Data.ProjectID != task.ProjectID || envelope.Data.ClientOperationID != operation {
		t.Fatalf("wrong receipt identity: %+v", envelope.Data)
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(envelope.Data.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	metadata, _ := input["metadata"].(map[string]any)
	if metadata["nodeId"] != "original-target" || metadata["sourceNodeId"] != "original-source" || input["mode"] != "video" {
		t.Fatalf("receipt lost original target: %#v", input)
	}
	if _, exists := input["config"]; exists {
		t.Fatal("receipt kept provider config")
	}
	if _, exists := input["referenceImages"]; exists {
		t.Fatal("receipt kept binary/reference transport input")
	}
}
