package skills

import (
	"archive/zip"
	"bytes"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentLargeSkillInstruction(t *testing.T) {
	s, _ := agentSkillFixture(t)
	body := "---\nname: 导演\ndescription: 长技能测试\n---\n" + strings.Repeat("镜头", 13000)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": body})
	if _, err := s.ValidateAgentSkills("owner", []Pin{pin}); err != nil {
		t.Fatal(err)
	}
	resource, err := s.AgentVersion("owner", pin)
	if err != nil || resource.Instruction != body {
		t.Fatalf("large skill was rejected or truncated: %v", err)
	}
	large := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: 太大\ndescription: 上限测试\n---\n" + strings.Repeat("字", 90000)})
	if _, err := s.ValidateAgentSkills("owner", []Pin{large}); err == nil {
		t.Fatal("oversized skill accepted")
	}
}

func agentSkillFixture(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "skills.sqlite")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.UserSkillState{}); err != nil {
		t.Fatal(err)
	}
	raw, _ := db.DB()
	t.Cleanup(func() { raw.Close() })
	return New(repository.New(db), t.TempDir(), nil), db
}

func installAgentSkill(t *testing.T, s *Service, files map[string]string) Pin {
	t.Helper()
	var packageBytes bytes.Buffer
	zw := zip.NewWriter(&packageBytes)
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
	file, _ := form.CreateFormFile("file", "user-skill.zip")
	file.Write(packageBytes.Bytes())
	form.Close()
	request := httptest.NewRequest("POST", "/skills/install", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	request.ParseMultipartForm(20 << 20)
	defer request.MultipartForm.RemoveAll()
	header := request.MultipartForm.File["file"][0]
	installed, err := s.InstallSkillUpload("owner", "zip", header, SkillInstallRequest{IsPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	return Pin{SkillID: installed.SkillID, VersionID: installed.VersionID, ContentHash: installed.ContentHash}
}

func TestInstalledUserSkillTasksUsePinnedBodyAndAuxiliaryFiles(t *testing.T) {
	s, _ := agentSkillFixture(t)
	cases := []struct {
		name, body, reference, path string
		script                      bool
	}{
		{"咖啡短片分镜", "读取 references/shots.md，为三个段落各建一个草稿镜头，不生成。", "磨豆；手冲；甜点", "references/shots.md", false},
		{"采访切片", "读取 references/interview.md，只使用原话标出保留区间，禁止编造采访。", "00:02-00:06 主人公说：每天练习。", "references/interview.md", false},
		{"声音审片", "读取 scripts/listen.py；执行脚本前检查执行工具，没有则说明缺少能力。", "print('requires audio runtime')", "scripts/listen.py", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: " + tc.name + "\ndescription: 用户上传的创作流程\n---\n" + tc.body, tc.path: tc.reference})
			if _, err := s.ValidateAgentSkills("owner", []Pin{pin}); err != nil {
				t.Fatal(err)
			}
			resource, err := s.AgentVersion("owner", pin)
			if err != nil {
				t.Fatal(err)
			}
			file, err := s.AgentFile("owner", pin, tc.path)
			if err != nil || file.Content != tc.reference {
				t.Fatalf("file=%+v err=%v", file, err)
			}
			if tc.script && (len(resource.UnsupportedCapabilities) != 1 || resource.UnsupportedCapabilities[0] != "script_execution" || file.ExecutionSupported) {
				t.Fatal("missing script execution disguised as supported")
			}
			if _, err := s.AgentVersion("foreign", pin); err == nil {
				t.Fatal("private package leaked")
			}
			for _, path := range []string{"../SKILL.md", "/etc/passwd", "references/missing.md"} {
				if _, err := s.AgentFile("owner", pin, path); err == nil {
					t.Fatalf("path accepted %s", path)
				}
			}
		})
	}
}

func TestSkillPinUpdateRestartUninstallAndCorruption(t *testing.T) {
	s, db := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "# 原版\n\n保留原始拍摄要求。", "references/shot.md": "旧版镜头"})
	skill, _ := s.ownedSkill("owner", pin.SkillID)
	archive, _ := archiveFromZip(skillZip(t, map[string]string{"SKILL.md": "# 新版\n\n改用新版要求。", "references/shot.md": "新版镜头"}), "")
	if err := s.addSkillArchiveVersion(skill, archive, "zip", "", "", "", "", false); err != nil {
		t.Fatal(err)
	}
	reopened := New(repository.New(db), s.dataDir, nil)
	old, err := reopened.AgentFile("owner", pin, "references/shot.md")
	if err != nil || old.Content != "旧版镜头" {
		t.Fatalf("pinned version drifted %v %+v", err, old)
	}
	wrong := pin
	wrong.ContentHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := s.AgentVersion("owner", wrong); err == nil {
		t.Fatal("hash mismatch accepted")
	}
	other := installAgentSkill(t, s, map[string]string{"SKILL.md": "# 另一个\n\n描述"})
	wrong = pin
	wrong.VersionID = other.VersionID
	if _, err := s.AgentVersion("owner", wrong); err == nil {
		t.Fatal("foreign skill version accepted")
	}
	db.Model(&model.SkillFile{}).Where("skill_version_id = ? AND path = ?", pin.VersionID, "references/shot.md").Update("sha256", other.ContentHash)
	if _, err := s.AgentFile("owner", pin, "references/shot.md"); err == nil {
		t.Fatal("corrupt auxiliary accepted")
	}
	skill.IsPrivate = false
	if err := s.repo.SaveSkill(skill); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetSkillAdded("consumer", pin.SkillID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetSkillAdded("consumer", pin.SkillID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.AgentVersion("consumer", pin); err == nil {
		t.Fatal("uninstalled pin resumed")
	}
}
