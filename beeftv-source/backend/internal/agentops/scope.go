package agentops

import (
	"encoding/json"
	"infinite-canvas/backend/internal/skills"
	"strings"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/operations"
)

// AssistantScope 是内置助手的可信范围：当前画布 + 后端验证过归属的额外引用，
// 以及当前画布文档里真实关联的素材与任务。
//
// 这个范围只能由后端从回合记录构造；模型给的工具参数无法扩大它，
// 所以「提示词里说可以读」不会变成真实权限。
type AssistantScope struct {
	PermissionMode string
	CanvasID       string
	AssetIDs       map[string]bool
	CanvasIDs      map[string]bool
	TaskIDs        map[string]bool
	// SkillPins holds exact pin identities selected in this round or in an
	// earlier round of the same conversation; a loaded skill stays readable.
	SkillPins map[skills.Pin]bool
	// SkillInstalled reports whether a pin is the caller's currently installed
	// version (Go-only resolver), so the assistant can load an advertised skill.
	SkillInstalled   func(skills.Pin) bool
	ProjectReference func(kind, id string) error // Go-only DB resolver, never model supplied.
}

// Visible uses the same operation policy published to the official Pi host.
func (s *AssistantScope) Visible(op *operations.Op) bool {
	if s == nil {
		return true
	}
	return op != nil && op.AssistantVisible(assistantturns.Mode(s.PermissionMode))
}

func (s *AssistantScope) Allows(op *operations.Op, params json.RawMessage) error {
	if s == nil {
		return nil
	}
	if strings.TrimSpace(s.CanvasID) == "" {
		return denied("当前会话没有绑定画布")
	}
	if !s.Visible(op) {
		return denied("本轮助手权限不允许该操作")
	}
	var args struct {
		CanvasID    string `json:"canvasId"`
		NodeID      string `json:"nodeId"`
		AssetID     string `json:"assetId"`
		TaskID      string `json:"taskId"`
		SkillID     string `json:"skillId"`
		VersionID   string `json:"versionId"`
		ContentHash string `json:"contentHash"`
	}
	if len(params) > 0 {
		_ = json.Unmarshal(params, &args)
	}
	// Broad modes rely on each shared domain handler's current ownership check.
	// Skills remain pinned rather than discovering filesystem instructions.
	if assistantturns.Mode(s.PermissionMode) != assistantturns.PermissionCanvas && op.ID != "skill.get" && op.ID != "skill.file" && op.ID != "skill.catalog" {
		return nil
	}
	if !op.ReadOnly && op.Scope == operations.ScopeCanvas {
		if args.CanvasID == s.CanvasID {
			return nil
		}
		return denied("只能修改当前画布")
	}
	switch op.ID {
	case "model.catalog":
		return nil
	case "project.media.search", "project.canvas.search":
		if args.CanvasID == s.CanvasID {
			return nil
		}
		return denied("只能搜索当前画布所属项目")
	case "skill.catalog", "skill.market.search", "skill.market.get", "skill.market.file":
		return nil
	case "skill.publish.status":
		if args.CanvasID == s.CanvasID {
			return nil
		}
		return denied("只能查看当前画布准备的投稿")
	case "skill.get", "skill.file":
		pin := skills.Pin{SkillID: args.SkillID, VersionID: args.VersionID, ContentHash: args.ContentHash}
		if s.SkillPins[pin] || (s.SkillInstalled != nil && s.SkillInstalled(pin)) {
			return nil
		}
		return denied("只能读取本对话选择或已安装的技能版本")
	case "canvas.get":
		if s.canvasAllowed(args.CanvasID) || s.projectReferenceAllowed("canvas", args.CanvasID) {
			return nil
		}
		return denied("只能读取当前画布或已在界面里引用的画布")
	case "canvas.generation.propose":
		// 写只允许落在当前画布：跨画布写即便带上合法 canvasId 也必须拒绝。
		if args.CanvasID == s.CanvasID {
			return nil
		}
		return denied("只能修改当前画布")
	case "asset.get":
		if s.AssetIDs[strings.TrimSpace(args.AssetID)] || s.projectReferenceAllowed("asset", args.AssetID) {
			return nil
		}
		return denied("这个素材与当前画布无关，也没有被本次对话引用")
	case "media.overview", "media.inspect", "media.check", "media.review":
		if args.CanvasID != s.CanvasID {
			return denied("只能检查当前画布关联的媒体")
		}
		if args.NodeID != "" && args.AssetID == "" {
			return nil
		}
		if args.AssetID != "" && args.NodeID == "" && (s.AssetIDs[args.AssetID] || s.projectReferenceAllowed("asset", args.AssetID)) {
			return nil
		}
		return denied("这个媒体未关联到当前画布或本次对话")
	case "task.get":
		if s.TaskIDs[strings.TrimSpace(args.TaskID)] {
			return nil
		}
		return denied("这个任务与当前画布无关")
	default:
		return denied("内置助手不能调用该操作")
	}
}

func (s *AssistantScope) canvasAllowed(canvasID string) bool {
	trimmed := strings.TrimSpace(canvasID)
	if trimmed == "" {
		return false
	}
	return trimmed == s.CanvasID || s.CanvasIDs[trimmed]
}

func (s *AssistantScope) projectReferenceAllowed(kind, id string) bool {
	return id != "" && s.ProjectReference != nil && s.ProjectReference(kind, id) == nil
}

func denied(message string) *Error {
	return operations.PermissionDenied("scope_denied", message)
}

var _ operations.Authorizer = (*AssistantScope)(nil)
