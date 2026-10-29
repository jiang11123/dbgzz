package app

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestAssistantOutputsValidateReceiptTaskAndCanvasOwnership(t *testing.T) {
	_, db := newTimelineTaskTestService(t)
	svc := NewLocal(repository.New(db), t.TempDir())
	if err := db.Create(&model.Workspace{ID: "owner", Name: "test"}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"outputs-canvas","revision":0,"nodes":[],"connections":[]}`)); err != nil {
		t.Fatal(err)
	}
	turnID := "1111abcd2222abcd"
	if _, err := svc.BeginAssistantTurn("owner", "outputs-canvas", turnID, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	timestamp := time.Now().UTC()
	seed := func(opID, taskID, userID, projectID, clientID, kind, admissionStatus string, taskStatus model.TaskStatus, revision any) {
		t.Helper()
		payload, _ := json.Marshal(map[string]any{"taskId": taskID, "canvasId": projectID, "sourceRevision": revision})
		if err := db.Create(&model.AgentOpRecord{UserID: "owner", TurnID: turnID, OpID: opID, Op: "canvas.timeline.render", Status: admissionStatus, ResultJSON: string(payload), CreatedAt: timestamp}).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.Task{ID: taskID, UserID: userID, ProjectID: projectID, ClientOperationID: &clientID, Type: kind, Status: taskStatus, Provider: "local"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	// Same-time receipts must preserve a deterministic first/repair order.
	seed("b-repair", "repair", "owner", "outputs-canvas", "assistant-render:b-repair", model.TaskTypeTimelineRender, "succeeded", model.TaskStatusFailed, 4)
	seed("a-first", "first", "owner", "outputs-canvas", "assistant-render:a-first", model.TaskTypeTimelineRender, "succeeded", model.TaskStatusQueued, 3)
	seed("c-foreign", "foreign", "other", "outputs-canvas", "assistant-render:c-foreign", model.TaskTypeTimelineRender, "succeeded", model.TaskStatusSucceeded, 3)
	seed("d-forged", "forged", "owner", "outputs-canvas", "external-self-reported", model.TaskTypeTimelineRender, "succeeded", model.TaskStatusSucceeded, 3)
	seed("e-kind", "wrong-kind", "owner", "outputs-canvas", "assistant-render:e-kind", "canvas_video", "succeeded", model.TaskStatusSucceeded, 3)
	seed("f-denied", "denied", "owner", "outputs-canvas", "assistant-render:f-denied", model.TaskTypeTimelineRender, "failed", model.TaskStatusSucceeded, 3)
	seed("g-canvas", "wrong-canvas", "owner", "foreign-canvas", "assistant-render:g-canvas", model.TaskTypeTimelineRender, "succeeded", model.TaskStatusSucceeded, 3)
	seed("h-project", "wrong-project", "owner", "outputs-canvas", "assistant-render:h-project", model.TaskTypeTimelineRender, "succeeded", model.TaskStatusSucceeded, 3)
	if err := db.Model(&model.Task{}).Where("id = ?", "wrong-project").Update("project_id", "another-canvas").Error; err != nil {
		t.Fatal(err)
	}
	seed("i-provider", "paid-provider", "owner", "outputs-canvas", "assistant-render:i-provider", model.TaskTypeTimelineRender, "succeeded", model.TaskStatusSucceeded, 3)
	if err := db.Model(&model.Task{}).Where("id = ?", "paid-provider").Update("provider", "paid").Error; err != nil {
		t.Fatal(err)
	}
	outputs, err := svc.AssistantTurnOutputs("owner", "outputs-canvas", turnID)
	if err != nil {
		t.Fatal(err)
	}
	if len(outputs) != 2 || outputs[0].TaskID != "first" || outputs[1].TaskID != "repair" || *outputs[0].SourceRevision != 3 || *outputs[1].SourceRevision != 4 {
		t.Fatalf("wrong trusted outputs: %#v", outputs)
	}
	// Receipt success admits a task, it does not imply a ready film: failed and
	// queued tasks stay in the list for the ordinary task API to explain.
	recreated := NewLocal(repository.New(db), t.TempDir())
	restored, err := recreated.AssistantTurnOutputs("owner", "outputs-canvas", turnID)
	if err != nil || !reflect.DeepEqual(restored, outputs) {
		t.Fatalf("app recovery: %#v %v", restored, err)
	}
	for _, identity := range [][2]string{{"other", "outputs-canvas"}, {"owner", "other-canvas"}} {
		got, err := svc.AssistantTurnOutputs(identity[0], identity[1], turnID)
		if err != nil || len(got) != 0 {
			t.Fatalf("foreign outputs: %#v %v", got, err)
		}
	}
}
