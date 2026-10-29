package handler

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/skills"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

const (
	skillSessionOne = "durable:11111111-2222-3333-4444-555555555555"
	skillSessionTwo = "durable:66666666-7777-8888-9999-000000000000"
)

func installTestSkill(t *testing.T, env *assistantTestEnv, userID string, files map[string]string) skills.Pin {
	t.Helper()
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	for name, content := range files {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(f, content)
	}
	zw.Close()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	f, _ := form.CreateFormFile("file", "skill.zip")
	f.Write(archive.Bytes())
	form.Close()
	req := httptest.NewRequest("POST", "/skills/install", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	if err := req.ParseMultipartForm(20 << 20); err != nil {
		t.Fatal(err)
	}
	defer req.MultipartForm.RemoveAll()
	installed, err := env.service.InstallSkillUpload(userID, "zip", req.MultipartForm.File["file"][0], app.SkillInstallRequest{IsPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	return skills.Pin{SkillID: installed.SkillID, VersionID: installed.VersionID, ContentHash: installed.ContentHash}
}

func skillScopeOp(t *testing.T, id string) *operations.Op {
	t.Helper()
	registry := operations.NewRegistry(nil, nil)
	operations.RegisterDefaultOps(registry)
	descriptor, ok := registry.Descriptor(id)
	if !ok {
		t.Fatalf("unregistered operation %s", id)
	}
	return &operations.Op{ID: id, ReadOnly: descriptor.ReadOnly, Scope: descriptor.Scope, AssistantCanvas: true}
}

func hostScopeForTurn(t *testing.T, env *assistantTestEnv, userID, turnID string) func(op string, pin skills.Pin) error {
	t.Helper()
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/api/ops/skill.file", nil)
	c.Request.Header.Set(assistantTurnHeader, turnID)
	scope, _, err := assistantScopeForRequest(c, env.service, userID, true)
	if err != nil || scope == nil {
		t.Fatalf("scope %v %v", scope, err)
	}
	return func(op string, pin skills.Pin) error {
		raw, _ := json.Marshal(map[string]string{"skillId": pin.SkillID, "versionId": pin.VersionID, "contentHash": pin.ContentHash, "path": "references/a.md"})
		return scope.Allows(skillScopeOp(t, op), raw)
	}
}

func TestSkillScopeFollowsConversationAcrossTurns(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	// An earlier-round pin that is no longer the installed version: only the
	// conversation can authorize it.
	earlier := skills.Pin{SkillID: "earlier-skill", VersionID: "old-version", ContentHash: strings.Repeat("a", 64)}
	begin := func(turnID, sessionID string, pins []skills.Pin, finalize bool) {
		t.Helper()
		env.beginTurn(t, turnID, app.AssistantTurnInput{SkillPins: pins})
		if err := env.service.BindAssistantDurableSession(owner.ID, turnID, sessionID, false); err != nil {
			t.Fatal(err)
		}
		if finalize {
			if err := env.service.FinalizeAssistantTurn(turnID); err != nil {
				t.Fatal(err)
			}
		}
	}
	begin("cccc0000cccc0001", skillSessionOne, []skills.Pin{earlier}, true)
	begin("cccc0000cccc0002", skillSessionOne, nil, false)
	allows := hostScopeForTurn(t, env, owner.ID, "cccc0000cccc0002")
	for _, op := range []string{"skill.get", "skill.file"} {
		if err := allows(op, earlier); err != nil {
			t.Fatalf("later round of the same conversation must read %s: %v", op, err)
		}
	}
	if err := env.service.FinalizeAssistantTurn("cccc0000cccc0002"); err != nil {
		t.Fatal(err)
	}
	begin("cccc0000cccc0003", skillSessionTwo, nil, false)
	other := hostScopeForTurn(t, env, owner.ID, "cccc0000cccc0003")
	if err := other("skill.file", earlier); err == nil {
		t.Fatal("another conversation's pin must be denied")
	}
	// Installed current versions are loadable by the assistant in any round.
	installed := installTestSkill(t, env, owner.ID, map[string]string{"SKILL.md": "---\nname: 分批出图\ndescription: 先出一批再确认\n---\n第一步", "references/a.md": "参考"})
	if err := other("skill.file", installed); err != nil {
		t.Fatalf("installed version must be loadable: %v", err)
	}
	stale := installed
	stale.ContentHash = strings.Repeat("b", 64)
	if err := other("skill.get", stale); err == nil {
		t.Fatal("non-current installed version must be denied")
	}
	code, body := env.opsRaw("skill.file", "", "cccc0000cccc0003", `{"skillId":"`+installed.SkillID+`","versionId":"`+installed.VersionID+`","contentHash":"`+installed.ContentHash+`","path":"references/a.md"}`)
	if code != http.StatusOK || !strings.Contains(body, "参考") {
		t.Fatalf("skill_file on a later round failed: %d %s", code, body)
	}
	code, body = env.opsRaw("skill.catalog", "", "cccc0000cccc0003", `{}`)
	if code != http.StatusOK || !strings.Contains(body, installed.SkillID) || !strings.Contains(body, "先出一批再确认") || strings.Contains(body, "第一步") {
		t.Fatalf("catalog must list installed skills without bodies: %d %s", code, body)
	}
	foreign, err := env.service.AgentSkillCatalog("another-user")
	if err != nil {
		t.Fatal(err)
	}
	if len(foreign) != 0 {
		t.Fatalf("catalog leaked another user's skills: %+v", foreign)
	}
}

func TestSkillLabelsFallBackToInstalledSkill(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	installed := installTestSkill(t, env, owner.ID, map[string]string{"SKILL.md": "---\nname: 短剧资产分批流程\ndescription: 标签\n---\n正文"})
	turn := map[string]any{
		"skills": []any{
			map[string]any{"skillId": installed.SkillID, "versionId": installed.VersionID},
			map[string]any{"skillId": "removed-skill", "versionId": "gone"},
		},
		"supplementInputs": []any{map[string]any{"skills": []any{map[string]any{"skillId": installed.SkillID, "versionId": installed.VersionID}}}},
	}
	// Older rounds stored pins without labels.
	labelAssistantSkills(turn, []skills.Pin{installed}, installedSkillLabels(env.service, owner.ID))
	list := turn["skills"].([]any)
	if got := list[0].(map[string]any)["skillName"]; got != "短剧资产分批流程" {
		t.Fatalf("installed skill must be named: %v", list[0])
	}
	if _, labeled := list[1].(map[string]any)["skillName"]; labeled {
		t.Fatalf("unresolvable pin must stay unlabeled: %v", list[1])
	}
	supplement := turn["supplementInputs"].([]any)[0].(map[string]any)["skills"].([]any)[0].(map[string]any)
	if supplement["skillName"] != "短剧资产分批流程" {
		t.Fatalf("supplement skill must be named: %v", supplement)
	}
	// A different version of an installed skill is not the same package.
	other := map[string]any{"skills": []any{map[string]any{"skillId": installed.SkillID, "versionId": "older-version"}}}
	labelAssistantSkills(other, nil, installedSkillLabels(env.service, owner.ID))
	if _, labeled := other["skills"].([]any)[0].(map[string]any)["skillName"]; labeled {
		t.Fatal("version mismatch must not borrow the installed label")
	}
	// Stored labels win over the installed fallback.
	stored := installed
	stored.SkillName = "当时的名称"
	kept := map[string]any{"skills": []any{map[string]any{"skillId": installed.SkillID, "versionId": installed.VersionID}}}
	labelAssistantSkills(kept, []skills.Pin{stored}, func() []skills.Pin { t.Fatal("installed lookup not needed"); return nil })
	if kept["skills"].([]any)[0].(map[string]any)["skillName"] != "当时的名称" {
		t.Fatal("stored label must be kept")
	}
}
