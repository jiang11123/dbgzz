package app

import (
	"encoding/json"
	"gorm.io/gorm"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestAssistantProductionAtomicAuthorizationAndReplay(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	sqlDB, _ := svc.Database().DB()
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","audioModel":"custom::speech","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image","speech"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"},{"model":"speech","capability":"audio","protocol":"openai-audio"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{map[string]any{"id": "image", "type": "image", "title": "首帧", "metadata": map[string]any{"prompt": "雨后的花店", "size": "9:16", "count": 1}}, map[string]any{"id": "speech", "type": "audio", "title": "旁白", "metadata": map[string]any{"prompt": "把春天，带回家。", "model": "custom::speech", "audioVoice": "alloy"}}}
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	const source = "aabbccdd11229900"
	if _, err := svc.BeginAssistantTurn("local", canvasID, source, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.BindAssistantDurableSession("local", source, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.FinalizeAssistantTurn(source); err != nil {
		t.Fatal(err)
	}
	raw, _ = svc.UserCanvasProject("local", canvasID)
	_ = json.Unmarshal(raw, &doc)
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"image", "speech"})
	if err != nil {
		t.Fatal(err)
	}
	request := AssistantProductionConfirmation{CanvasID: canvasID, ProposalID: "gp-production-test", Kind: "image", NodeIDs: []string{"image"}, Targets: targets}
	if err = svc.Database().Exec("CREATE TRIGGER fail_production_admission BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'fixture admission failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err = svc.ConfirmAssistantProduction("local", source, request); err == nil {
		t.Fatal("admission fault accepted")
	}
	var rejected model.AssistantTurn
	if err = svc.Database().First(&rejected, "turn_id = ?", source).Error; err != nil || rejected.GenerationAuthorizationJSON != "" {
		t.Fatal("failed admission left a spend authorization", err)
	}
	var rolledBack int64
	svc.Database().Model(&model.Task{}).Count(&rolledBack)
	if rolledBack != 0 {
		t.Fatal("failed admission left paid tasks", rolledBack)
	}
	svc.Database().Model(&model.AssistantContinuation{}).Count(&rolledBack)
	if rolledBack != 0 {
		t.Fatal("failed admission left a continuation", rolledBack)
	}
	if err = svc.Database().Exec("DROP TRIGGER fail_production_admission").Error; err != nil {
		t.Fatal(err)
	}
	var stale model.AssistantTurn
	if err := svc.Database().First(&stale, "turn_id = ?", source).Error; err != nil {
		t.Fatal(err)
	}
	first, err := svc.ConfirmAssistantProduction("local", source, request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.ConfirmAssistantProduction("local", source, request)
	if err != nil {
		t.Fatal(err)
	}
	if first.(map[string]any)["taskIds"].([]string)[0] != second.(map[string]any)["taskIds"].([]string)[0] {
		t.Fatal("confirmation replay purchased another task")
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatal("expected exactly one accepted task", count)
	}
	var origin model.AssistantTurn
	svc.Database().First(&origin, "turn_id = ?", source)
	if origin.GenerationAuthorizationJSON == "" {
		t.Fatal("authorization not persisted")
	}
	if err := svc.repo.SaveAssistantTurn(nil, &stale); err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().First(&origin, "turn_id = ?", source).Error; err != nil || origin.GenerationAuthorizationJSON == "" {
		t.Fatal("delayed settlement erased production authorization", err)
	}
	if first.(map[string]any)["revision"] != second.(map[string]any)["revision"] {
		t.Fatal("same confirmation changed canvas revision")
	}
	// The next official round receives the same finite grant, never a transcript-derived permission.
	const next = "bbccddaa11229900"
	if _, err = svc.BeginAssistantTurn("local", canvasID, next, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err = svc.BindAssistantDurableSession("local", next, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	svc.Database().Model(&model.AssistantTurn{}).Where("turn_id = ?", next).Update("generation_authorization_json", origin.GenerationAuthorizationJSON)
	err = svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", next, canvasID, targets[1:])
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatal("next approved stage not admitted", count)
	}
	imageTask := first.(map[string]any)["taskIds"].([]string)[0]
	if err = svc.Database().Model(&model.Task{}).Where("id = ?", imageTask).Updates(map[string]any{"status": "failed", "error": "fixture local preflight failure"}).Error; err != nil {
		t.Fatal(err)
	}
	err = svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", next, canvasID, targets[:1])
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	failedDoc, _ := svc.UserCanvasProject("local", canvasID)
	var failed map[string]any
	_ = json.Unmarshal(failedDoc, &failed)
	failedMeta := failed["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)
	if failedMeta["status"] != "error" || failedMeta["taskStatus"] != "failed" || failedMeta["error"] != "fixture local preflight failure" {
		t.Fatal("original failed task disguised as generating", failedMeta)
	}
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatal("recovering failed receipt created another purchase", count)
	}
	changed := targets[1]
	changed.Prompt = "新增一段未确认的旁白"
	err = svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", next, canvasID, []operations.GenerationTarget{changed})
		return e
	})
	if err == nil {
		t.Fatal("changed paid input accepted")
	}
	if err = svc.CancelAssistantContinuations("local", canvasID, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	err = svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", next, canvasID, targets[1:])
		return e
	})
	if err == nil {
		t.Fatal("stopped authorization revived")
	}
}
