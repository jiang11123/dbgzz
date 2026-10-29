package handler

import (
	"errors"
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/skills"
)

// 共享操作层上的助手身份与回合归属。
//
// 之前用「自定义 profile/canvas/references 头」描述范围，等于让任何调用方自报授权：
// 已登记的读写客户端只要知道 turnId，就能把外部写入挂到某轮助手上，撤销时被一起抹掉。
// 现在只有两个输入：内置宿主的专属凭据（后端注入，页面拿不到）+ 后端签发的 turnId。
// 范围一律从后端自己的回合记录读取，调用方无法自报。
const (
	// assistantHostTokenHeader 是内置助手宿主的专属凭据头。
	assistantHostTokenHeader = "X-Beeftv-Agent-Token"
	// assistantTurnHeader 是后端在 /assistant/chat 里签发、随转发体下发的回合标识。
	assistantTurnHeader = "X-Beeftv-Agent-Turn"
	// assistantMaxReferences 限制一次对话能带上的额外引用数量。
	assistantMaxReferences = 16
)

// assistantReference 是界面明确引用、并由后端校验归属后的资源。
type assistantReference struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// normalizeAssistantReferences 校验界面请求的额外引用确实属于当前用户。
// 对话入口用严格模式：任何一项非法都整轮拒绝，避免界面以为授权生效了却没有。
func normalizeAssistantReferences(svc *app.Service, userID string, items []assistantReference) ([]assistantReference, error) {
	if len(items) == 0 {
		return nil, nil
	}
	if len(items) > assistantMaxReferences {
		return nil, fmt.Errorf("一次对话最多引用 %d 个资源", assistantMaxReferences)
	}
	seen := map[string]bool{}
	out := make([]assistantReference, 0, len(items))
	for _, item := range items {
		kind := strings.TrimSpace(item.Kind)
		id := strings.TrimSpace(item.ID)
		if id == "" {
			return nil, errors.New("引用缺少资源 id")
		}
		key := kind + "\x00" + id
		if seen[key] {
			continue
		}
		switch kind {
		case "asset":
			if _, err := svc.UserAsset(userID, id); err != nil {
				return nil, errors.New("引用的素材不存在或不属于当前工作区")
			}
		case "canvas":
			if _, err := svc.UserCanvasProject(userID, id); err != nil {
				return nil, errors.New("引用的画布不存在或不属于当前工作区")
			}
		default:
			return nil, errors.New("不支持的引用类型: " + kind)
		}
		seen[key] = true
		out = append(out, assistantReference{Kind: kind, ID: id})
	}
	return out, nil
}

// assistantTurnInput 把已验证的引用整理成回合输入；额外画布只用于读取，不进入写范围。
func assistantTurnInput(selected []string, references []assistantReference) app.AssistantTurnInput {
	input := app.AssistantTurnInput{SelectedNodeIDs: selected}
	for _, item := range references {
		switch item.Kind {
		case "asset":
			input.AssetIDs = append(input.AssetIDs, item.ID)
		case "canvas":
			input.CanvasIDs = append(input.CanvasIDs, item.ID)
		}
	}
	return input
}

// assistantScopeForRequest 只在调用方是已鉴权内置宿主且出示了后端签发的 turnId 时
// 返回受限范围。其他调用方（已登记客户端、owner 直连）返回 nil，保持原有工作区能力不变。
func assistantScopeForRequest(c *gin.Context, svc *app.Service, userID string, hostCall bool) (*agentops.AssistantScope, string, error) {
	if !hostCall {
		if strings.TrimSpace(c.GetHeader(assistantTurnHeader)) != "" {
			return nil, "", errors.New("回合归属只能由内置助手宿主出示")
		}
		return nil, "", nil
	}
	turnID := strings.TrimSpace(c.GetHeader(assistantTurnHeader))
	if turnID == "" {
		// 宿主在回合之外（例如能力发现）没有画布范围：可见能力仍是助手集合，但执行全部拒绝。
		return &agentops.AssistantScope{PermissionMode: "full-access"}, "", nil
	}
	if !app.ValidAssistantTurnID(turnID) {
		return nil, "", errors.New("回合标识非法")
	}
	scope, ok, err := svc.AssistantTurnScopeForHost(userID, turnID)
	if err != nil {
		return nil, "", err
	}
	if !ok {
		return nil, "", errors.New("这一轮对话不存在、不属于当前工作区或已经结束")
	}
	return &agentops.AssistantScope{
		PermissionMode: scope.PermissionMode,
		CanvasID:       scope.CanvasID,
		AssetIDs:       assistantIDSet(scope.AssetIDs),
		CanvasIDs:      assistantIDSet(scope.CanvasIDs),
		TaskIDs:        assistantIDSet(scope.TaskIDs),
		SkillPins:      assistantSkillPinSet(scope.SkillPins, scope.SessionSkillPins, scope.ActiveSkillPins),
		SkillInstalled: func(pin skills.Pin) bool {
			return assistantSkillInstalled(svc, userID, pin)
		},
		ProjectReference: func(kind, id string) error {
			return svc.ValidateAgentProjectReference(userID, scope.CanvasID, kind, id)
		},
	}, turnID, nil
}

func assistantSkillPinSet(groups ...[]skills.Pin) map[skills.Pin]bool {
	result := map[skills.Pin]bool{}
	for _, pins := range groups {
		for _, pin := range pins {
			result[pin.Identity()] = true
		}
	}
	return result
}

// assistantSkillInstalled is true only for the caller's currently installed
// version of a skill, compared by exact identity.
func assistantSkillInstalled(svc *app.Service, userID string, pin skills.Pin) bool {
	catalog, err := svc.AgentSkillCatalog(userID)
	if err != nil {
		return false
	}
	for _, item := range catalog {
		if item.Pin.Identity() == pin.Identity() {
			return true
		}
	}
	return false
}

func assistantIDSet(ids []string) map[string]bool {
	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out
}

// isAssistantHostRequest 判断请求是否由已鉴权的内置助手宿主发起。
func isAssistantHostRequest(c *gin.Context, svc *app.Service) bool {
	return agentops.HostTokenMatches(svc.DataDir(), strings.TrimSpace(c.GetHeader(assistantHostTokenHeader)))
}
