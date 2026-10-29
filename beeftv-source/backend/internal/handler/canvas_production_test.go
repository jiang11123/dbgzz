package handler

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/model"
)

func TestCanvasProductionHTTPReadsWithoutMutationAndRegistersOnlyExactReadyOutput(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	RegisterProjectRoutes(env.router.Group("/api"), env.service)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	project, err := env.service.CreateProject(owner.ID, app.CreateProjectRequest{Name: "画布制作"})
	if err != nil {
		t.Fatal(err)
	}
	unit, err := env.service.CreateProjectUnit(owner.ID, project.ID, app.CreateProjectUnitRequest{Title: "第一章", SourceText: "两人对谈"})
	if err != nil {
		t.Fatal(err)
	}
	shot, err := env.service.CreateProjectShot(owner.ID, project.ID, app.CreateProjectShotRequest{UnitID: unit.ID, Title: "对谈镜头", Description: "人物全景"})
	if err != nil {
		t.Fatal(err)
	}
	path := "/projects/" + project.ID + "/canvases/" + env.canvasID + "/production-context"
	read := env.call(t, http.MethodGet, path+"?unitId="+unit.ID+"&shotId="+shot.ID+"&stepKey=video", "")
	data := decodeEnvelope(t, read)
	context := data["context"].(map[string]any)
	if context["linked"] != false || context["workflowAvailable"] != false || context["shotRevisionId"] != shot.CurrentRevisionID {
		t.Fatalf("read mutated records: %s", read.Body)
	}
	now := time.Now()
	resource := model.Resource{ID: "http-ready-output", UserID: owner.ID, Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", CreatedAt: now, UpdatedAt: now}
	task := model.Task{ID: "http-existing-task", UserID: owner.ID, ProjectID: env.canvasID, Type: "canvas_video", Status: model.TaskStatusSucceeded, ResultJSON: `{"video":{"storageKey":"resource:http-ready-output"}}`, CreatedAt: now, UpdatedAt: now}
	for _, row := range []any{&resource, &task} {
		if err := env.service.Database().Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	request := app.CanvasProductionTaskRequest{TaskID: task.ID, ResourceID: resource.ID, UnitID: unit.ID, ShotID: shot.ID, ShotRevisionID: shot.CurrentRevisionID, StepKey: "video"}
	body, _ := json.Marshal(request)
	for _, invalid := range []string{string(body) + `{}`, string(body[:len(body)-1]) + `,"userId":"foreign"}`} {
		response := env.call(t, http.MethodPost, path, invalid)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid JSON accepted: %d %s", response.Code, response.Body)
		}
	}
	for range 2 {
		response := env.call(t, http.MethodPost, path, string(body))
		result := decodeEnvelope(t, response)
		if result["taskId"] != task.ID || result["resourceId"] != resource.ID || result["context"].(map[string]any)["linked"] != true {
			t.Fatalf("wrong source identity: %s", response.Body)
		}
	}
	var artifacts int64
	env.service.Database().Model(&model.ShotArtifact{}).Where("task_id = ?", task.ID).Count(&artifacts)
	if artifacts != 1 {
		t.Fatalf("retry duplicated records: %d", artifacts)
	}
	request.ShotRevisionID = "outdated"
	body, _ = json.Marshal(request)
	response := env.call(t, http.MethodPost, path, string(body))
	if response.Code != http.StatusConflict || envelopeReason(t, response.Body.String()) != "production_revision_conflict" {
		t.Fatalf("stale confirmation accepted: %d %s", response.Code, response.Body)
	}
}
