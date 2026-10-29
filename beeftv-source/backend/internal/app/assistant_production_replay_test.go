package app

import (
	"encoding/json"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestAssistantProductionConfirmationReplayAfterClaim(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, err := svc.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	doc["nodes"] = []any{map[string]any{"id": "image", "type": "image", "metadata": map[string]any{"prompt": "雨后的花店", "size": "9:16", "count": 1}}}
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err = svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	const source = "ccddeeff11229900"
	if _, err = svc.BeginAssistantTurn("local", canvasID, source, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err = svc.BindAssistantDurableSession("local", source, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err = svc.FinalizeAssistantTurn(source); err != nil {
		t.Fatal(err)
	}
	raw, _ = svc.UserCanvasProject("local", canvasID)
	_ = json.Unmarshal(raw, &doc)
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"image"})
	if err != nil {
		t.Fatal(err)
	}
	request := AssistantProductionConfirmation{CanvasID: canvasID, ProposalID: "gp-confirmation-replay", Kind: "image", NodeIDs: []string{"image"}, Targets: targets}
	first, err := svc.ConfirmAssistantProduction("local", source, request)
	if err != nil {
		t.Fatal(err)
	}
	accepted := first.(map[string]any)
	taskIDs := accepted["taskIds"].([]string)
	continuationID := accepted["continuationId"].(string)
	if err = svc.Database().Model(&model.Task{}).Where("id = ?", taskIDs[0]).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = svc.ClaimAssistantContinuation("local", continuationID); err != nil {
		t.Fatal(err)
	}
	manifest := assistantturns.ContinuationManifest{SourceNodeID: "image", Submissions: []assistantturns.ContinuationSubmission{{OperationID: "proposal:gp-confirmation-replay:image", OutputNodeIDs: []string{"image"}}}}
	for _, state := range []string{"claimed", "running", "done"} {
		t.Run(state, func(t *testing.T) {
			if err := svc.Database().Model(&model.AssistantContinuation{}).Where("id = ?", continuationID).Update("state", state).Error; err != nil {
				t.Fatal(err)
			}
			var before model.AssistantContinuation
			if err := svc.Database().First(&before, "id = ?", continuationID).Error; err != nil {
				t.Fatal(err)
			}
			replay, err := svc.ConfirmAssistantProduction("local", source, request)
			if err != nil {
				t.Fatal("accepted confirmation could not recover its original receipt", err)
			}
			result := replay.(map[string]any)
			if !reflect.DeepEqual(result["taskIds"], taskIDs) || result["continuationId"] != continuationID {
				t.Fatal("confirmation replay replaced accepted identities", result)
			}
			var count int64
			if err := svc.Database().Model(&model.Task{}).Count(&count).Error; err != nil || count != 1 {
				t.Fatal("confirmation replay duplicated paid tasks", count, err)
			}
			changed := manifest
			changed.Submissions = []assistantturns.ContinuationSubmission{{OperationID: manifest.Submissions[0].OperationID, OutputNodeIDs: []string{"another-node"}}}
			if err := svc.RegisterAssistantContinuationManifest("local", continuationID, changed); err == nil {
				t.Fatal("claimed manifest was changed")
			}
			var after model.AssistantContinuation
			if err := svc.Database().First(&after, "id = ?", continuationID).Error; err != nil {
				t.Fatal(err)
			}
			if before.State != after.State || before.Revision != after.Revision || before.ManifestJSON != after.ManifestJSON {
				t.Fatal("receipt replay mutated the running continuation")
			}
		})
	}
	if err := svc.CancelAssistantContinuations("local", canvasID, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmAssistantProduction("local", source, request); err == nil {
		t.Fatal("stopped confirmation was revived")
	}
}
