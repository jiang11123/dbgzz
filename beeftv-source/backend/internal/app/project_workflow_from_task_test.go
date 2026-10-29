package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestRegisterTaskOutputFromTaskDecryptsEncryptedInputThenRegisters(t *testing.T) {
	service, db := newProjectWorkflowV2TestService(t)
	service.dataDir = t.TempDir()
	project, unit := seedWorkflowProject(t, db)
	if err := service.EnsureBuiltinProjectWorkflowTemplate(); err != nil {
		t.Fatal(err)
	}
	workflow, err := service.CreateUnitWorkflow("user-1", project.ID, unit.ID)
	if err != nil {
		t.Fatal(err)
	}
	var videoStep model.WorkflowStepInstance
	for _, step := range workflow.Steps {
		if step.StepKey == "video" {
			videoStep = step
		}
	}
	shot, err := service.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "人物抬头", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	resource := model.Resource{ID: "resource-decrypt-1", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 1024, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	encryptedKey, err := service.encryptSettingSecret("sk-live")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(encryptedKey, "enc:v1:") {
		t.Fatalf("encrypted key = %q", encryptedKey)
	}
	input, err := json.Marshal(map[string]any{
		"apiKey": encryptedKey,
		"metadata": map[string]any{
			"workflowStepId":  videoStep.ID,
			"domainProjectId": project.ID,
			"unitId":          unit.ID,
			"shotId":          shot.ID,
			"artifactType":    "video",
			"role":            "output",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-decrypt-1", UserID: "user-1", ProjectID: project.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		InputJSON: string(input), ResultJSON: `{"mode":"video","video":{"storageKey":"resource:resource-decrypt-1"}}`,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := service.RegisterTaskOutputFromTask(task); err != nil {
		t.Fatal(err)
	}
	var artifactCount int64
	if err := db.Table("shot_artifacts").Where("task_id = ?", task.ID).Count(&artifactCount).Error; err != nil || artifactCount != 1 {
		t.Fatalf("artifact count = %d, err = %v", artifactCount, err)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stored.InputJSON, "enc:v1:") {
		t.Fatal("stored task input lost ciphertext")
	}
}

func TestRegisterTaskOutputFromTaskStopsWhenDecryptFails(t *testing.T) {
	service, db := newProjectWorkflowV2TestService(t)
	project, unit := seedWorkflowProject(t, db)
	if err := service.EnsureBuiltinProjectWorkflowTemplate(); err != nil {
		t.Fatal(err)
	}
	workflow, err := service.CreateUnitWorkflow("user-1", project.ID, unit.ID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := model.Task{
		ID: "task-decrypt-fail", UserID: "user-1", ProjectID: project.ID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		InputJSON:  `{"apiKey":"enc:v1:not-valid","metadata":{"workflowStepId":"` + workflow.Steps[0].ID + `","domainProjectId":"` + project.ID + `","unitId":"` + unit.ID + `"}}`,
		ResultJSON: `{}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := service.RegisterTaskOutputFromTask(task); err == nil {
		t.Fatal("decrypt failure registered output")
	}
	var count int64
	if err := db.Table("workflow_step_tasks").Where("task_id = ?", task.ID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("link count = %d, err = %v", count, err)
	}
}

func TestRegisterTaskOutputFromTaskSkipsUnsuccessfulTasksWithoutDecrypt(t *testing.T) {
	service, db := newProjectWorkflowV2TestService(t)
	now := time.Now()
	task := model.Task{
		ID: "task-running", UserID: "user-1", ProjectID: "project-1", Type: "canvas_video", Status: model.TaskStatusRunning,
		InputJSON: `{"apiKey":"enc:v1:not-valid"}`, ResultJSON: `{}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := service.RegisterTaskOutputFromTask(task); err != nil {
		t.Fatal(err)
	}
}
