package app

import (
	"encoding/json"
	"errors"
	"testing"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	localtask "infinite-canvas/backend/internal/task"
)

func productionProgressFixture(t *testing.T) (*Service, string, string) {
	t.Helper()
	svc, canvasID, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","videoModel":"custom::video","audioModel":"custom::speech","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image","video","speech"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"},{"model":"video","capability":"video","protocol":"video-generations-json"},{"model":"speech","capability":"audio","protocol":"openai-audio"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{
		map[string]any{"id": "image", "type": "image", "title": "首帧", "metadata": map[string]any{"prompt": "茶杯", "size": "9:16", "count": 1}},
		map[string]any{"id": "video", "type": "video", "title": "镜头", "metadata": map[string]any{"prompt": "注入热茶", "size": "9:16", "seconds": 4, "generateAudio": false}},
		map[string]any{"id": "speech", "type": "audio", "title": "旁白", "metadata": map[string]any{"prompt": "先喝一杯热茶。", "audioVoice": "alloy"}},
	}
	doc["connections"] = []any{map[string]any{"id": "reference", "fromNodeId": "image", "toNodeId": "video"}}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	const source = "11223344aabbccdd"
	if _, err := svc.BeginAssistantTurn("local", canvasID, source, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.BindAssistantDurableSession("local", source, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.FinalizeAssistantTurn(source); err != nil {
		t.Fatal(err)
	}
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"image", "video", "speech"})
	if err != nil {
		t.Fatal(err)
	}
	if len(targets[1].ReferenceNodeIDs) != 1 || targets[1].ReferenceNodeIDs[0] != "image" {
		t.Fatal("fixture lost the real reference dependency")
	}
	result, err := svc.ConfirmAssistantProduction("local", source, AssistantProductionConfirmation{CanvasID: canvasID, ProposalID: "gp-progress", Kind: "image", NodeIDs: []string{"image"}, Targets: targets})
	if err != nil {
		t.Fatal(err)
	}
	return svc, canvasID, result.(map[string]any)["continuationId"].(string)
}

func progressTask(t *testing.T, svc *Service, nodeID string) model.Task {
	t.Helper()
	var task model.Task
	if err := svc.Database().First(&task, "client_operation_id = ?", "proposal:gp-progress:"+nodeID).Error; err != nil {
		t.Fatal(err)
	}
	return task
}

func completeProgressMaterial(t *testing.T, svc *Service, canvasID, nodeID string) {
	t.Helper()
	task := progressTask(t, svc, nodeID)
	if err := svc.Database().Model(&task).Update("status", model.TaskStatusSucceeded).Error; err != nil {
		t.Fatal(err)
	}
	kind := task.Type[len("canvas_"):]
	resourceID := "material-" + nodeID
	if err := svc.Database().Create(&model.Resource{ID: resourceID, UserID: "local", Status: model.ResourceStatusReady}).Error; err != nil {
		t.Fatal(err)
	}
	output, _ := json.Marshal(localtask.CanonicalOutput{OutputIndex: 0, MediaType: kind, ResourceID: resourceID, TargetBinding: &localtask.TargetBinding{NodeID: nodeID}})
	if err := svc.Database().Create(&model.Result{ID: "result-" + nodeID, UserID: "local", TaskID: task.ID, Kind: localtask.ResultKindGenerationOutput, Payload: string(output)}).Error; err != nil {
		t.Fatal(err)
	}
	asset, _ := json.Marshal(map[string]any{"id": "asset-" + nodeID, "title": nodeID, "kind": kind, "coverUrl": "", "tags": []any{}, "data": map[string]any{"storageKey": "resource:" + resourceID, "width": 1, "height": 1, "bytes": 1, "mimeType": "video/mp4"}})
	if _, err := svc.UpsertUserAsset("local", asset); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	for _, value := range doc["nodes"].([]any) {
		node := value.(map[string]any)
		if node["id"] == nodeID {
			meta := node["metadata"].(map[string]any)
			meta["status"], meta["taskStatus"], meta["storageKey"], meta["assetId"] = "success", "succeeded", "resource:"+resourceID, "asset-"+nodeID
		}
	}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
}

func expectProgressWaiting(t *testing.T, svc *Service, id string, taskCount int64) {
	t.Helper()
	_, err := svc.ClaimAssistantContinuation("local", id)
	var expected *assistantturns.Error
	if !errors.As(err, &expected) || expected.Reason != "continuation_waiting" {
		t.Fatalf("expected committed material preparation, got %v", err)
	}
	var count, turns int64
	svc.Database().Model(&model.Task{}).Count(&count)
	svc.Database().Model(&model.AssistantTurn{}).Count(&turns)
	if count != taskCount || turns != 1 {
		t.Fatalf("tasks=%d want=%d; model turns=%d want=1", count, taskCount, turns)
	}
}

func TestProductionProgressAdvancesOnlySavedDependenciesWithoutModelTurns(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	// Independent speech starts while the root image is still running.
	expectProgressWaiting(t, svc, id, 2)
	voice := progressTask(t, svc, "speech")
	expectProgressWaiting(t, svc, id, 2)
	if progressTask(t, svc, "speech").ID != voice.ID {
		t.Fatal("repeated scan bought another voice")
	}
	image := progressTask(t, svc, "image")
	svc.Database().Model(&image).Update("status", model.TaskStatusSucceeded)
	expectProgressWaiting(t, svc, id, 2) // upstream success alone is insufficient.
	completeProgressMaterial(t, svc, canvasID, "image")
	expectProgressWaiting(t, svc, id, 3)
	video := progressTask(t, svc, "video")
	var input struct {
		ReferenceImages []struct {
			StorageKey string `json:"storageKey"`
		} `json:"referenceImages"`
	}
	if err := json.Unmarshal([]byte(video.InputJSON), &input); err != nil || len(input.ReferenceImages) != 1 || input.ReferenceImages[0].StorageKey != "resource:material-image" {
		t.Fatal("video did not use the saved confirmed image", err)
	}
	for range 3 {
		expectProgressWaiting(t, svc, id, 3)
	}
	completeProgressMaterial(t, svc, canvasID, "video")
	completeProgressMaterial(t, svc, canvasID, "speech")
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("ready materials did not wake Pi: %v %v", claim, err)
	}
	replay, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || replay.TurnID != claim.TurnID || progressTask(t, svc, "video").ID != video.ID {
		t.Fatal("claim replay changed identities", err)
	}
}

func TestProductionProgressStopRevokesFurtherAdmissions(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	if err := svc.CancelAssistantContinuations("local", canvasID, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ClaimAssistantContinuation("local", id); err == nil {
		t.Fatal("stopped receipt was revived")
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatal("stop dispatched another paid task", count)
	}
}

func TestProductionProgressFailedTaskWakesPiWithoutRepurchase(t *testing.T) {
	svc, _, id := productionProgressFixture(t)
	image := progressTask(t, svc, "image")
	svc.Database().Model(&image).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "upstream failed"})
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("original failure not offered to Pi: %v %v", claim, err)
	}
	if _, err := svc.ClaimAssistantContinuation("local", id); err != nil {
		t.Fatal(err)
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 1 || progressTask(t, svc, "image").ID != image.ID {
		t.Fatal("failure caused another purchase", count)
	}
}

func TestProductionProgressFailureWaitsForAdmittedSibling(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	expectProgressWaiting(t, svc, id, 2)
	image := progressTask(t, svc, "image")
	svc.Database().Model(&image).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "upstream failed"})
	expectProgressWaiting(t, svc, id, 2)
	completeProgressMaterial(t, svc, canvasID, "speech")
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("settled siblings did not wake Pi: %v %v", claim, err)
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatal("failure purchased a dependent task", count)
	}
}

func TestProductionProgressFailedDependentWaitsForVoice(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	expectProgressWaiting(t, svc, id, 2)
	completeProgressMaterial(t, svc, canvasID, "image")
	expectProgressWaiting(t, svc, id, 3)
	video := progressTask(t, svc, "video")
	svc.Database().Model(&video).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "maximum concurrency"})
	expectProgressWaiting(t, svc, id, 3)
	completeProgressMaterial(t, svc, canvasID, "speech")
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("original failure did not wake after the sibling settled: %v %v", claim, err)
	}
	if progressTask(t, svc, "video").ID != video.ID {
		t.Fatal("failed dependent was replaced")
	}
}

func TestProductionProgressFailureWaitsForSuccessfulSiblingMaterialization(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	expectProgressWaiting(t, svc, id, 2)
	image, voice := progressTask(t, svc, "image"), progressTask(t, svc, "speech")
	svc.Database().Model(&image).Update("status", model.TaskStatusFailed)
	svc.Database().Model(&voice).Update("status", model.TaskStatusSucceeded)
	// The provider finished, but the canonical file and binding are absent.
	expectProgressWaiting(t, svc, id, 2)
	completeProgressMaterial(t, svc, canvasID, "speech")
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("saved sibling did not release original failure: %v %v", claim, err)
	}
	if progressTask(t, svc, "speech").ID != voice.ID {
		t.Fatal("materialization replaced the original task")
	}
}

func TestProductionProgressMaterializationFailureIsReportedWithoutRepurchase(t *testing.T) {
	svc, _, id := productionProgressFixture(t)
	expectProgressWaiting(t, svc, id, 2)
	image, voice := progressTask(t, svc, "image"), progressTask(t, svc, "speech")
	svc.Database().Model(&image).Update("status", model.TaskStatusFailed)
	svc.Database().Model(&voice).Update("status", model.TaskStatusSucceeded)
	output, _ := json.Marshal(localtask.CanonicalOutput{OutputIndex: 0, MediaType: "audio", MaterializationErrorCode: "download_failed", TargetBinding: &localtask.TargetBinding{NodeID: "speech"}})
	if err := svc.Database().Create(&model.Result{ID: "failed-voice-file", UserID: "local", TaskID: voice.ID, Kind: localtask.ResultKindGenerationOutput, Payload: string(output)}).Error; err != nil {
		t.Fatal(err)
	}
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("known materialization failure was hidden: %v %v", claim, err)
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatal("known failure caused another purchase", count)
	}
}

func TestProductionProgressChangedInputsStopFurtherAdmissions(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"].([]any)[1].(map[string]any)["metadata"].(map[string]any)["prompt"] = "different paid content"
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ClaimAssistantContinuation("local", id); err == nil {
		t.Fatal("changed paid input was accepted")
	}
	if state := backgroundReceiptState(t, svc, id); state != "cancelled" {
		t.Fatal("changed plan left a waiting receipt", state)
	}
	if _, err := svc.ClaimAssistantContinuation("local", id); err == nil {
		t.Fatal("changed intent was revived")
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatal("changed plan dispatched more tasks", count)
	}
}
