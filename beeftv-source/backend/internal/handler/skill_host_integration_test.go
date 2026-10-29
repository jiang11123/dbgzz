package handler

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/skills"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestSelectedSkillsActualHostBusinessFlows(t *testing.T) {
	cases := []struct {
		name, instruction, path, reference string
		titles                             []string
		script                             bool
	}{
		{"coffee", "读取 references/shots.md，为三个段落创建草稿，不生成。", "references/shots.md", "磨豆；手冲；甜点", []string{"磨豆", "手冲", "甜点"}, false},
		{"interview", "读取 references/interview.md，使用原话创建保留区间草稿。", "references/interview.md", "00:02-00:06 主人公说：每天练习。", []string{"00:02-00:06 每天练习"}, false},
		{"audio", "读取 scripts/listen.py，检查执行工具，没有则说明未执行。", "scripts/listen.py", "print('requires audio runtime')", nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newAssistantTestEnv(t, nil)
			const turnID = "112233aabbccdd44"
			owner, e := env.service.LocalWorkspaceOwner()
			if e != nil {
				t.Fatal(e)
			}
			var archive bytes.Buffer
			zw := zip.NewWriter(&archive)
			for name, content := range map[string]string{"SKILL.md": "---\nname: " + tc.name + "\ndescription: 上传创作流程\n---\n" + tc.instruction, tc.path: tc.reference} {
				f, e := zw.Create(name)
				if e != nil {
					t.Fatal(e)
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
			if e := req.ParseMultipartForm(20 << 20); e != nil {
				t.Fatal(e)
			}
			defer req.MultipartForm.RemoveAll()
			installed, e := env.service.InstallSkillUpload(owner.ID, "zip", req.MultipartForm.File["file"][0], app.SkillInstallRequest{IsPrivate: true})
			if e != nil {
				t.Fatal(e)
			}
			pin := skills.Pin{SkillID: installed.SkillID, VersionID: installed.VersionID, ContentHash: installed.ContentHash}
			env.beginTurn(t, turnID, app.AssistantTurnInput{SkillPins: []skills.Pin{pin}})
			const continueTurnID = "112233aabbccdd45"
			const reselectTurnID = "112233aabbccdd46"
			const freshTurnID = "112233aabbccdd47"
			env.beginTurn(t, continueTurnID, app.AssistantTurnInput{})
			env.beginTurn(t, reselectTurnID, app.AssistantTurnInput{SkillPins: []skills.Pin{pin}})
			env.beginTurn(t, freshTurnID, app.AssistantTurnInput{})
			backend := httptest.NewServer(env.router)
			defer backend.Close()
			root, err := filepath.Abs("../../..")
			if err != nil {
				t.Fatal(err)
			}
			directory := t.TempDir()
			config, err := json.Marshal(map[string]any{"root": root, "directory": directory, "backend": backend.URL + "/api", "canvasId": env.canvasID, "turnId": turnID, "continueTurnId": continueTurnID, "reselectTurnId": reselectTurnID, "freshTurnId": freshTurnID, "hostToken": assistantTestHostToken, "pin": pin, "instruction": tc.instruction, "path": tc.path, "reference": tc.reference, "titles": tc.titles, "script": tc.script})
			if err != nil {
				t.Fatal(err)
			}
			configPath := filepath.Join(directory, "config.json")
			if err := os.WriteFile(configPath, config, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, "node", filepath.Join(root, "agent-host/test-support/skill-business-probe.mjs"), configPath)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("real Durable host/Go probe failed: %v\n%s", err, output)
			}
			raw, e := env.service.UserCanvasProject(owner.ID, env.canvasID)
			if e != nil {
				t.Fatal(e)
			}
			var doc struct {
				Nodes []struct {
					Title    string `json:"title"`
					Metadata struct {
						Prompt string `json:"prompt"`
					} `json:"metadata"`
				} `json:"nodes"`
			}
			if e := json.Unmarshal(raw, &doc); e != nil {
				t.Fatal(e)
			}
			if len(doc.Nodes) != 1+len(tc.titles) {
				t.Fatalf("unexpected mutations %s", raw)
			}
			for _, title := range tc.titles {
				found := false
				for _, node := range doc.Nodes {
					if node.Title == title && node.Metadata.Prompt == tc.reference {
						found = true
					}
				}
				if !found {
					t.Fatalf("missing task draft %s", raw)
				}
			}
		})
	}
}
