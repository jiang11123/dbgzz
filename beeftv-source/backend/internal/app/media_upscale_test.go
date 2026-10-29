package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func TestUpscaleAdmissionPinsOfficialCredentialAndPayload(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","baseUrl":"https://enterprise.beefapi.com","apiKey":"synthetic-disk-key","enabled":true}]}`)); err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"mode": "image", "prompt": "AI 超分", "config": map[string]any{"credentialRef": "beefapi-enterprise", "apiKey": "forged-client-key", "baseUrl": "https://untrusted.invalid", "model": "topaz-standard-v2", "interfaceType": "newapi"}, "upscale": map[string]any{"factor": 2}, "referenceImages": []any{map[string]any{"storageKey": "resource:owned-source"}}}
	resolved, err := s.resolveManagedBeefAPISecrets(input)
	if err != nil {
		t.Fatal(err)
	}
	config := resolved["config"].(map[string]any)
	if config["apiKey"] != "synthetic-disk-key" || config["baseUrl"] != "https://enterprise.beefapi.com" {
		t.Fatal("client overrode managed credential origin")
	}
	if err := (taskCatalogAdapter{s}).ValidateCapability(resolved); err != nil {
		t.Fatal(err)
	}
	if _, err := (taskCatalogAdapter{s}).Select("owner", localtask.SelectRequest{Input: resolved, Model: "topaz-standard-v2", Type: "canvas_image"}); err != nil {
		t.Fatalf("managed upscale admission rejected: %v", err)
	}
	for _, request := range []localtask.SelectRequest{
		{Input: resolved, Model: "topaz-proteus", Type: "canvas_image"},
		{Input: resolved, Model: "topaz-standard-v2", Type: "canvas_video"},
		{Input: map[string]any{"mode": "image", "config": map[string]any{"model": "topaz-standard-v2", "apiKey": "forged-key", "baseUrl": "https://untrusted.invalid"}}, Model: "topaz-standard-v2", Type: "canvas_image"},
	} {
		if _, err := (taskCatalogAdapter{s}).Select("owner", request); err == nil {
			t.Fatal("mismatched task identity or unmanaged credentials accepted")
		}
	}
	if err := s.protectTaskSecrets(resolved); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(resolved)
	if strings.Contains(string(raw), "synthetic-disk-key") || strings.Contains(string(raw), "forged-client-key") {
		t.Fatal("plaintext key persisted")
	}
	decoded, err := s.decryptTaskInputJSON(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	var prepared generation.Input
	if err := json.Unmarshal([]byte(decoded), &prepared); err != nil {
		t.Fatal(err)
	}
	if prepared.Upscale == nil || prepared.Upscale.Factor != 2 || prepared.Config.APIKey != "synthetic-disk-key" {
		t.Fatal("sealed task lost upscale request")
	}
	started := time.Now()
	if !s.shouldDeferVideoProviderTask(model.Task{Type: "canvas_image", Model: "topaz-standard-v2", ProviderRequestID: "original", StartedAt: &started}, decoded, generation.StatePendingError{TaskID: "original"}) {
		t.Fatal("accepted image upscale cannot resume in existing queue")
	}
}

func TestUpscaleConfigRequiresConnectedAccount(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if _, err := s.upscaleConfig("topaz-standard-v2"); err == nil {
		t.Fatal("missing managed credential accepted")
	}
}

func TestUpscaleRecoveryNeverResubmitsUnknownOrAcceptedWithoutReceipt(t *testing.T) {
	for _, dispatch := range []string{"", "submission_unknown", "accepted"} {
		t.Run(dispatch, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			task := model.Task{ID: "original", UserID: "user", Type: "canvas_video", Model: "topaz-proteus", Status: model.TaskStatusFailed}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if dispatch != "" {
				if err := db.Create(&model.RouteAttempt{ID: "attempt", TaskID: task.ID, DispatchState: dispatch, StartedAt: time.Now()}).Error; err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.RecoverMediaUpscale(context.Background(), "user", task.ID); err == nil {
				t.Fatal("unconfirmed submission was retried")
			}
			stored, err := s.repo.Task(task.ID)
			if err != nil || stored.Status != model.TaskStatusFailed {
				t.Fatalf("original task changed: %+v %v", stored, err)
			}
			var count int64
			db.Model(&model.Task{}).Count(&count)
			if count != 1 {
				t.Fatalf("created %d tasks", count)
			}
		})
	}
}

func TestUpscaleImageRejectionRetainsNoJobEvidence(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	rejected := generation.SubmissionRejectedError{Cause: generation.HTTPError{StatusCode: 400, Body: `{"error":{"code":"fal_billing_unavailable","message":"billing unavailable"}}`}}
	task := &model.Task{ID: "upscale-rejected", UserID: "user", Type: "canvas_image", Model: "topaz-standard-v2", RouteID: "original"}
	attempt := &model.RouteAttempt{ID: "upscale-attempt", TaskID: task.ID, RouteID: "original", DispatchState: "submission_unknown"}
	s.finishTaskRouteAttempt(attempt, task, rejected)
	if attempt.DispatchState != "rejected_no_job" || attempt.FailureCode != "upstream_400" {
		t.Fatalf("known rejection lost: %+v", attempt)
	}
	attempt.DispatchState = "submission_unknown"
	port := &taskRouteExecutionPortStub{processResults: map[string]taskRouteExecutionStubResult{"original": {err: rejected}}}
	result, err := (&taskRouteExecutor{port: port}).execute(context.Background(), task, attempt)
	if err != nil || isImageRecoveryError(result.err) || !routeFailureInfo(result.err).ExplicitRejection {
		t.Fatalf("rejection became uncertain image recovery: %v %v", result.err, err)
	}
}

func TestUpscaleFourModelsAdmitAndReplayThroughTaskDomain(t *testing.T) {
	for _, name := range []string{"topaz-standard-v2", "topaz-wonder-3.5", "topaz-proteus", "topaz-starlight-fast-2"} {
		t.Run(name, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","baseUrl":"https://enterprise.beefapi.com","apiKey":"synthetic-admission-key","enabled":true}]}`)); err != nil {
				t.Fatal(err)
			}
			kind := generation.UpscaleMediaType(name)
			mime := "image/png"
			if kind == "video" {
				mime = "video/mp4"
			}
			if err := db.Create(&model.Resource{ID: "owned-source", UserID: "user", Kind: kind, Provider: "local", Status: model.ResourceStatusReady, MimeType: mime, Size: 1024, ObjectKey: "users/user/source"}).Error; err != nil {
				t.Fatal(err)
			}
			field := "referenceImages"
			if kind == "video" {
				field = "referenceVideos"
			}
			input := map[string]any{"mode": kind, "prompt": "AI 超分", "config": map[string]any{"credentialRef": "beefapi-enterprise", "model": name, "interfaceType": "newapi"}, "upscale": map[string]any{"factor": 2}, field: []any{map[string]any{"storageKey": "resource:owned-source"}}, "metadata": map[string]any{"clientOperationId": "stable-upscale-operation"}}
			request := CreateTaskRequest{Type: "canvas_" + kind, Operation: kind, Model: name, Prompt: "AI 超分", Input: input}
			first, err := s.CreateTask("user", request)
			if err != nil {
				t.Fatal(err)
			}
			replay, err := s.CreateTask("user", request)
			if err != nil || replay.ID != first.ID {
				t.Fatalf("admission replay: %v %v", replay, err)
			}
			var count int64
			db.Model(&model.Task{}).Count(&count)
			if count != 1 {
				t.Fatalf("created %d tasks", count)
			}
			stored, err := s.repo.Task(first.ID)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(stored.InputJSON, "synthetic-admission-key") {
				t.Fatal("plaintext credential persisted")
			}
			raw, err := s.decryptTaskInputJSON(stored.InputJSON)
			if err != nil {
				t.Fatal(err)
			}
			var prepared generation.Input
			if err = json.Unmarshal([]byte(raw), &prepared); err != nil {
				t.Fatal(err)
			}
			if err = generation.ValidateUpscaleInput(prepared); err != nil {
				t.Fatalf("admitted input cannot execute: %v", err)
			}
		})
	}
}
