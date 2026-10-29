package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/skills"
)

func TestBuiltInAgentPreparesPrivateDraftButCannotUploadOrSubmit(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	if e := database.ConfigurePool(env.service.Database()); e != nil {
		t.Fatal(e)
	}
	owner, e := env.service.LocalWorkspaceOwner()
	if e != nil {
		t.Fatal(e)
	}
	var writes atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			writes.Add(1)
		}
		w.WriteHeader(500)
	}))
	defer remote.Close()
	t.Setenv("BEEFTV_SKILLHUB_URL", remote.URL)
	registry := operations.NewRegistry(env.service, operations.NewStore(env.service.Database()))
	operations.RegisterDefaultOps(registry)
	scope := &agentops.AssistantScope{CanvasID: env.canvasID, PermissionMode: "canvas"}
	run := func(op, id string, args any) (operations.Result, error) {
		raw, _ := json.Marshal(args)
		return registry.Execute(operations.Request{UserID: owner.ID, Op: op, OpID: id, Params: raw, Caller: operations.AssistantCaller(scope, false)})
	}
	draftArgs := map[string]any{"canvasId": env.canvasID, "name": "Reusable story method", "description": "Organize two scenes before generating", "instruction": "Draft two shots and ask the user to confirm."}
	result, e := run("skill.draft", "draft-1", draftArgs)
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(result.Result)
	var draft skills.SkillItem
	if e = json.Unmarshal(raw, &draft); e != nil {
		t.Fatal(e)
	}
	if draft.SkillID == "" || !draft.IsPrivate {
		t.Fatalf("draft not private %+v", draft)
	}
	replay, e := run("skill.draft", "draft-1", draftArgs)
	if e != nil {
		t.Fatal(e)
	}
	replayRaw, _ := json.Marshal(replay.Result)
	if string(replayRaw) != string(raw) {
		t.Fatal("retry duplicated private draft")
	}
	prepared, e := run("skill.publish.prepare", "prepare-1", map[string]any{"canvasId": env.canvasID, "skillId": draft.SkillID, "publicationTarget": "new", "metadata": map[string]any{"license": "CC0-1.0", "requirements": []string{}}})
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(prepared.Result)
	var envelope struct {
		Plan skills.PublishPlan `json:"plan"`
	}
	if e = json.Unmarshal(b, &envelope); e != nil {
		t.Fatal(e)
	}
	if envelope.Plan.ID == "" || envelope.Plan.CanvasID != env.canvasID || envelope.Plan.Status != "awaiting_upload_confirmation" || writes.Load() != 0 {
		t.Fatalf("prepare uploaded or did not bind canvas %s writes=%d", b, writes.Load())
	}
	if _, e = run("skill.publish.prepare", "invalid-local-as-cloud", map[string]any{"canvasId": env.canvasID, "skillId": draft.SkillID, "publicationTarget": "new", "metadata": map[string]any{"skillId": draft.SkillID, "license": "CC0-1.0", "requirements": []string{}}}); e == nil {
		t.Fatal("actual model operation accepted local ID as cloud metadata")
	}
	plans, e := env.service.SkillsDomain().PublishPlans(owner.ID)
	if e != nil || len(plans) != 1 || writes.Load() != 0 {
		t.Fatal("invalid model parameters wrote a plan or reached upstream", e)
	}
	for _, op := range []string{"skill.publish.upload", "skill.publish.submit"} {
		if _, e = run(op, "forged", map[string]any{"canvasId": env.canvasID, "planId": envelope.Plan.ID, "confirmed": true}); e == nil {
			t.Fatal("model could self-confirm", op)
		}
	}
	scope.PermissionMode = "read-only"
	if _, e = run("skill.draft", "readonly", draftArgs); e == nil {
		t.Fatal("readonly model created a draft")
	}
	if _, e = env.service.SkillsDomain().PublishPlan("other-owner", envelope.Plan.ID); e == nil {
		t.Fatal("cross-owner plan read")
	}
	globalPlan, e := env.service.SkillsDomain().PublishPrepare(owner.ID, draft.SkillID, envelope.Plan.Metadata, skills.PublicationTarget{})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = run("skill.publish.status", "global-plan", map[string]any{"canvasId": env.canvasID, "planId": globalPlan.ID}); e == nil {
		t.Fatal("model read a skills-page publication unrelated to its canvas")
	}
	if writes.Load() != 0 {
		t.Fatal("model reached cloud write")
	}
}
