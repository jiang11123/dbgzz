package operations

import (
	"encoding/json"
	"infinite-canvas/backend/internal/skillhub"
	"infinite-canvas/backend/internal/skills"
)

type SkillPublishing interface {
	DraftSkill(string, skills.SkillMutationRequest) (*skills.SkillItem, error)
	PrepareSkillPublication(string, string, string, skillhub.Metadata, skills.PublicationTarget) (*skills.PublishPlan, error)
	SkillPublicationStatus(string, string) (*skills.PublishPlan, error)
}

func registerSkillPublishingOps(r *Registry) {
	r.Register(Op{ID: "skill.draft", AssistantCanvas: true, Scope: ScopeCanvas, Summary: "把当前画布的创作方法保存为私人技能草稿，不上传、不送审", Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"name":{"type":"string"},"description":{"type":"string"},"instruction":{"type":"string"}},"required":["canvasId","name","description","instruction"],"additionalProperties":false}`), Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
		var a struct {
			CanvasID    string `json:"canvasId"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Instruction string `json:"instruction"`
		}
		if e := decodeParams(raw, &a); e != nil {
			return nil, e
		}
		p, ok := ctx.Domain.(SkillPublishing)
		if !ok {
			return nil, Unsupported("skill_unavailable", "当前工作区无法保存技能草稿")
		}
		if _, e := ctx.Domain.UserCanvasProject(ctx.UserID, a.CanvasID); e != nil {
			return nil, mapDomainError(e)
		}
		v, e := p.DraftSkill(ctx.UserID, skills.SkillMutationRequest{SkillName: a.Name, Description: a.Description, Instruction: a.Instruction, Tag: "others", IsPrivate: true})
		return v, mapDomainError(e)
	}})
	r.Register(Op{ID: "skill.publish.prepare", AssistantCanvas: true, Scope: ScopeCanvas, Summary: "准备技能投稿，展示确切文件和元信息；等待用户在对话确认卡上传及送审，不执行任何云端写入", Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"skillId":{"type":"string","description":"本机技能编号，仅用于选取原文件。不是市场编号。"},"publicationTarget":{"type":"string","enum":["new","existing"],"description":"新投稿使用 new。只有用户明确要求为其已发布的市场技能更新版本才使用 existing；改写他人技能仍为 new。"},"marketSkillId":{"type":"string","description":"仅 existing 时填写用户已发布的市场技能编号；不得复制本机 skillId。new 时省略。"},"metadata":{"type":"object","properties":{"license":{"type":"string"},"name":{"type":"string"},"description":{"type":"string"},"versionLabel":{"type":"string"},"sourceUrl":{"type":"string"},"requirements":{"type":"array","description":"仅列出必需能力的明确 ID。纯文字技能使用空数组 []，不得填写 text 或模型名称；其他使用条件写入 requirementNotes。","uniqueItems":true,"items":{"type":"string","enum":["beeftv.canvas","model.image","model.video","model.audio"]}},"requirementNotes":{"type":"string","maxLength":1000,"description":"自然语言描述模型、素材和费用条件，不作为能力 ID。"},"showcase":{"type":"array","items":{"type":"object"}}},"required":["license","requirements"],"additionalProperties":false}},"required":["canvasId","skillId","publicationTarget","metadata"],"additionalProperties":false}`), Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
		var a struct {
			skills.PublicationTarget
			CanvasID string            `json:"canvasId"`
			SkillID  string            `json:"skillId"`
			Metadata skillhub.Metadata `json:"metadata"`
		}
		if e := decodeParams(raw, &a); e != nil {
			return nil, e
		}
		p, ok := ctx.Domain.(SkillPublishing)
		if !ok {
			return nil, Unsupported("skill_unavailable", "当前工作区无法准备投稿")
		}
		v, e := p.PrepareSkillPublication(ctx.UserID, a.SkillID, a.CanvasID, a.Metadata, a.PublicationTarget)
		return map[string]any{"plan": v, "actionRequired": "user_upload_confirmation"}, mapDomainError(e)
	}})
	r.Register(Op{ID: "skill.publish.status", AssistantCanvas: true, ReadOnly: true, Scope: ScopeWorkspaceRead, Summary: "读取本次技能投稿的文件预览、用户待确认动作及状态；凭据不会提供给助手", Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"planId":{"type":"string"}},"required":["canvasId","planId"],"additionalProperties":false}`), Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
		var a struct {
			CanvasID string `json:"canvasId"`
			PlanID   string `json:"planId"`
		}
		if e := decodeParams(raw, &a); e != nil {
			return nil, e
		}
		p, ok := ctx.Domain.(SkillPublishing)
		if !ok {
			return nil, Unsupported("skill_unavailable", "当前工作区无法读取投稿")
		}
		v, e := p.SkillPublicationStatus(ctx.UserID, a.PlanID)
		if e == nil && v.CanvasID != a.CanvasID {
			return nil, PermissionDenied("publication_canvas_mismatch", "这份投稿不属于当前画布")
		}
		return v, mapDomainError(e)
	}})
}
