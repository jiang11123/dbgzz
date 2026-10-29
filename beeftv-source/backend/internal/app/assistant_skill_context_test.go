package app

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/skills"
)

func TestAssistantSkillContextReceiptSurvivesSkillRemoval(t *testing.T) {
	for _, removal := range []string{"delete", "uninstall"} {
		t.Run(removal, func(t *testing.T) {
			service, canvasID, _ := newAssistantTurnService(t)
			// Production SQLite uses one connection: validation must share the
			// context transaction instead of trying to acquire another connection.
			if err := database.ConfigurePool(service.Database()); err != nil {
				t.Fatal(err)
			}
			createPin := func(owner, name string) skills.Pin {
				t.Helper()
				item, err := service.CreateSkill(owner, SkillMutationRequest{SkillName: name, Description: "技能回执回归", Instruction: "保留当前任务，只检查已有结果。", Tag: "others"})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := service.SetSkillAdded("local", item.SkillID, true); err != nil {
					t.Fatal(err)
				}
				return skills.Pin{SkillID: item.SkillID, VersionID: item.VersionID, ContentHash: item.ContentHash}
			}
			owner := "local"
			if removal == "uninstall" {
				owner = "creator"
			}
			previous, removed := createPin("local", "先前技能"), createPin(owner, "本轮技能")
			change := assistantturns.SkillContextChange{SessionID: "durable:11111111-2222-3333-4444-555555555555", Action: "activate", RequestID: "previous", Pins: []skills.Pin{previous}}
			if _, err := service.ChangeAssistantSkillContext("local", canvasID, change); err != nil {
				t.Fatal(err)
			}
			change.RequestID, change.ExpectedRevision, change.Pins = "select:stopped", 1, []skills.Pin{removed}
			applied, err := service.ChangeAssistantSkillContext("local", canvasID, change)
			if err != nil {
				t.Fatal(err)
			}
			if applied.ActivePins[0].SkillName != "本轮技能" {
				t.Fatalf("activation lost validated display labels: %+v", applied)
			}
			if removal == "delete" {
				err = service.DeleteSkill("local", removed.SkillID)
			} else {
				_, err = service.SetSkillAdded("local", removed.SkillID, false)
			}
			if err != nil {
				t.Fatal(err)
			}
			replayed, err := service.ChangeAssistantSkillContext("local", canvasID, change)
			if err != nil || !reflect.DeepEqual(replayed, applied) {
				t.Fatalf("removed skill blocked its existing receipt: %+v, %v", replayed, err)
			}
			if _, err := service.ChangeAssistantSkillContext("foreign", canvasID, change); err == nil {
				t.Fatal("receipt replay bypassed canvas ownership")
			}
			conflict := change
			conflict.Pins = []skills.Pin{previous}
			_, err = service.ChangeAssistantSkillContext("local", canvasID, conflict)
			var contextErr *assistantturns.Error
			if !errors.As(err, &contextErr) || contextErr.Reason != "skill_context_request_conflict" {
				t.Fatalf("changed body did not conflict with receipt: %v", err)
			}
			for _, action := range []string{"activate", "new_scope", "refresh"} {
				fresh := change
				fresh.Action, fresh.RequestID, fresh.ExpectedRevision = action, "fresh:"+action, applied.Revision
				if action == "refresh" {
					fresh.Pins = nil
				}
				if _, err := service.ChangeAssistantSkillContext("local", canvasID, fresh); err == nil {
					t.Fatalf("fresh %s accepted removed skill", action)
				}
			}
			current, err := service.AssistantSkillContext("local", canvasID, change.SessionID)
			if err != nil || !reflect.DeepEqual(current, applied) {
				t.Fatalf("rejected mutation changed context: %+v, %v", current, err)
			}
			// Stop can restore the prior valid selection after replaying select.
			restore := change
			restore.RequestID, restore.ExpectedRevision, restore.Pins = "restore:stopped", applied.Revision, []skills.Pin{previous}
			restored, err := service.ChangeAssistantSkillContext("local", canvasID, restore)
			if err != nil || restored.Revision != applied.Revision+1 || restored.ActivePins[0].Identity() != previous {
				t.Fatalf("could not restore prior selection: %+v, %v", restored, err)
			}
			replayed, err = service.ChangeAssistantSkillContext("local", canvasID, change)
			if err != nil || !reflect.DeepEqual(replayed, applied) {
				t.Fatalf("receipt changed after restoration: %+v, %v", replayed, err)
			}
			current, err = service.AssistantSkillContext("local", canvasID, change.SessionID)
			if err != nil || !reflect.DeepEqual(current, restored) {
				t.Fatalf("old receipt overwrote restored pins: %+v, %v", current, err)
			}
		})
	}
}

func TestAssistantSkillContextIdentifiesOnlyUnavailablePin(t *testing.T) {
	service, canvasID, _ := newAssistantTurnService(t)
	pins := make([]skills.Pin, 0, 2)
	for _, name := range []string{"已删除", "仍可用"} {
		item, err := service.CreateSkill("local", SkillMutationRequest{SkillName: name, Description: "回滚旧选择", Instruction: "检查已有结果", Tag: "others"})
		if err != nil {
			t.Fatal(err)
		}
		pins = append(pins, skills.Pin{SkillID: item.SkillID, VersionID: item.VersionID, ContentHash: item.ContentHash})
	}
	if err := service.DeleteSkill("local", pins[0].SkillID); err != nil {
		t.Fatal(err)
	}
	change := assistantturns.SkillContextChange{SessionID: "durable:11111111-2222-3333-4444-555555555555", Action: "activate", RequestID: "restore", Pins: pins}
	_, err := service.ChangeAssistantSkillContext("local", canvasID, change)
	var unavailable *kernel.AppError
	if !errors.As(err, &unavailable) || unavailable.Reason != "skill_context_pin_unavailable" || unavailable.Details["skillId"] != pins[0].SkillID || unavailable.Message != "技能不存在或已删除" {
		t.Fatalf("expected the revoked pin and original safe message, got %#v", err)
	}
	// A rejected request did not advance CAS or commit a receipt. The valid
	// remainder can be restored without bypassing resource validation.
	change.Pins = pins[1:]
	result, err := service.ChangeAssistantSkillContext("local", canvasID, change)
	if err != nil || result.Revision != 1 || len(result.ActivePins) != 1 || result.ActivePins[0].Identity() != pins[1] {
		t.Fatalf("valid remainder could not be restored: %+v %v", result, err)
	}
}

func TestAssistantSkillContextValidationPreservesOtherErrors(t *testing.T) {
	for _, err := range []error{nil, errors.New("database unavailable"), &kernel.AppError{Status: 503, Message: "暂时不可用"}, &kernel.AppError{Status: 400, Reason: "skill_instruction_too_large"}, kernel.WrapAppError(400, "暂时读不到文件", os.ErrNotExist), kernel.NewAppError(429, "稍后重试"), kernel.NewAppError(401, "需要重新授权")} {
		if _, ok := skillContextResourceError(err); ok {
			t.Fatalf("non-resource error can remove a pin: %#v", err)
		}
	}
	service, _, _ := newAssistantTurnService(t)
	domain := service.skillDomain()
	validShape := skills.Pin{SkillID: "deleted", VersionID: "v1", ContentHash: strings.Repeat("a", 64)}
	for _, pins := range [][]skills.Pin{{validShape, {}}, {validShape, validShape}, {validShape, validShape, validShape, validShape, validShape}} {
		_, err := validateAssistantSkillContextPins(domain, "local", pins)
		var appErr *kernel.AppError
		if err == nil || (errors.As(err, &appErr) && appErr.Reason == "skill_context_pin_unavailable") {
			t.Fatalf("invalid selection mislabeled as a revoked resource: %#v", err)
		}
	}
	if pins, err := validateAssistantSkillContextPins(domain, "local", nil); err != nil || len(pins) != 0 {
		t.Fatalf("empty selection failed: %+v %v", pins, err)
	}
	sqlDB, err := service.Database().DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = validateAssistantSkillContextPins(domain, "local", []skills.Pin{validShape})
	var appErr *kernel.AppError
	if err == nil || errors.As(err, &appErr) {
		t.Fatalf("database failure was swallowed or converted: %#v", err)
	}
}

func TestAssistantSkillContextPreservesRecoverableResourceFailures(t *testing.T) {
	for _, failure := range []string{"archive-unavailable", "version-query"} {
		t.Run(failure, func(t *testing.T) {
			service, canvasID, _ := newAssistantTurnService(t)
			item, err := service.CreateSkill("local", SkillMutationRequest{SkillName: "有效技能", Description: "临时读取失败", Instruction: "只检查已有结果", Tag: "others"})
			if err != nil {
				t.Fatal(err)
			}
			pin := skills.Pin{SkillID: item.SkillID, VersionID: item.VersionID, ContentHash: item.ContentHash}
			var restore func() error
			var cause error
			if failure == "archive-unavailable" {
				archive := filepath.Join(service.dataDir, "skill-packages", pin.SkillID, pin.VersionID+".zip")
				if err := os.Rename(archive, archive+".held"); err != nil {
					t.Fatal(err)
				}
				restore = func() error { return os.Rename(archive+".held", archive) }
				cause = os.ErrNotExist
			} else {
				cause = errors.New("injected version query failure")
				if err := service.Database().Callback().Query().Before("gorm:query").Register("test:version-read-failure", func(tx *gorm.DB) {
					if tx.Statement.Table == "skill_versions" {
						tx.AddError(cause)
					}
				}); err != nil {
					t.Fatal(err)
				}
				restore = func() error { return service.Database().Callback().Query().Remove("test:version-read-failure") }
			}
			defer func() {
				if restore != nil {
					_ = restore()
				}
			}()
			change := assistantturns.SkillContextChange{SessionID: "durable:11111111-2222-3333-4444-555555555555", Action: "activate", RequestID: "retry-original", Pins: []skills.Pin{pin}}
			_, err = service.ChangeAssistantSkillContext("local", canvasID, change)
			var appErr *kernel.AppError
			if !errors.As(err, &appErr) || appErr.Reason == "skill_context_pin_unavailable" || !errors.Is(err, cause) {
				t.Fatalf("recoverable resource fault granted pin removal: %#v", err)
			}
			if err := restore(); err != nil {
				t.Fatal(err)
			}
			restore = nil
			result, err := service.ChangeAssistantSkillContext("local", canvasID, change)
			if err != nil || result.Revision != 1 || result.ActivePins[0].Identity() != pin {
				t.Fatalf("original request failed after resource recovered: %+v %v", result, err)
			}
		})
	}
}

func TestAssistantSkillContextRetainsAggregateInstructionLimit(t *testing.T) {
	service, canvasID, _ := newAssistantTurnService(t)
	pins := make([]skills.Pin, 0, 3)
	for _, name := range []string{"第一份", "第二份", "第三份"} {
		item, err := service.CreateSkill("local", SkillMutationRequest{SkillName: name, Description: "合计超限", Instruction: "---\nname: large-skill\ndescription: limit fixture\n---\n" + strings.Repeat("字", 70000), Tag: "others"})
		if err != nil {
			t.Fatal(err)
		}
		pins = append(pins, skills.Pin{SkillID: item.SkillID, VersionID: item.VersionID, ContentHash: item.ContentHash})
	}
	_, err := service.ChangeAssistantSkillContext("local", canvasID, assistantturns.SkillContextChange{SessionID: "durable:11111111-2222-3333-4444-555555555555", Action: "activate", RequestID: "too-large", Pins: pins})
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Reason != "skill_instruction_too_large" || appErr.Details["skillId"] != nil {
		t.Fatalf("aggregate limit must not revoke an individual pin: %#v", err)
	}
}
