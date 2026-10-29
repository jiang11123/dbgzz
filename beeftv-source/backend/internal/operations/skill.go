package operations

import (
	"encoding/json"
	"infinite-canvas/backend/internal/skills"
	"strings"
	"unicode/utf8"
)

type SkillResources interface {
	AgentSkillVersion(string, skills.Pin) (*skills.AgentResource, error)
	AgentSkillFile(string, skills.Pin, string) (*skills.AgentFile, error)
}

// SkillCatalog lists the caller's installed skills at their current versions.
type SkillCatalog interface {
	AgentSkillCatalog(string) ([]skills.AgentCatalogItem, error)
}

// SkillCatalogLimit and SkillDescriptionLimit keep the advertised catalog
// bounded; the full instructions are loaded only on demand.
const (
	SkillCatalogLimit     = 50
	SkillDescriptionLimit = 300
)

func truncateSkillDescription(value string) string {
	if utf8.RuneCountInString(value) <= SkillDescriptionLimit {
		return value
	}
	runes := []rune(value)
	return string(runes[:SkillDescriptionLimit]) + "…"
}

func registerSkillOps(r *Registry) {
	r.Register(Op{AssistantCanvas: true, ID: "skill.catalog", Summary: "列出当前用户已安装技能的名称、说明和当前版本；不含正文", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","description":"精确技能 id"},"q":{"type":"string","description":"按名称或说明搜索"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}},"additionalProperties":false}`),
		Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
			var args struct {
				ID     string `json:"id"`
				Query  string `json:"q"`
				Offset int    `json:"offset"`
				Limit  int    `json:"limit"`
			}
			if err := decodeParams(raw, &args); err != nil {
				return nil, err
			}
			if args.Offset < 0 || args.Limit < 0 || args.Limit > SkillCatalogLimit || len(args.ID) > 80 || len(args.Query) > 300 {
				return nil, InvalidArg("invalid_skill_catalog_query", "技能查询参数无效")
			}
			if args.Limit == 0 {
				args.Limit = SkillCatalogLimit
			}
			port, ok := ctx.Domain.(SkillCatalog)
			if !ok {
				return nil, Unsupported("skill_unavailable", "当前工作区无法读取技能")
			}
			items, err := port.AgentSkillCatalog(ctx.UserID)
			if err != nil {
				return nil, mapDomainError(err)
			}
			filtered := make([]skills.AgentCatalogItem, 0, len(items))
			query := strings.ToLower(strings.TrimSpace(args.Query))
			for _, item := range items {
				if args.ID != "" && item.Pin.SkillID != args.ID {
					continue
				}
				if query != "" && !strings.Contains(strings.ToLower(item.Name+"\n"+item.Description), query) {
					continue
				}
				filtered = append(filtered, item)
			}
			total := len(filtered)
			offset := args.Offset
			if offset > total {
				offset = total
			}
			end := offset + args.Limit
			if end > total {
				end = total
			}
			items = filtered[offset:end]
			for i := range items {
				items[i].Description = truncateSkillDescription(items[i].Description)
			}
			return map[string]any{"skills": items, "total": total, "offset": offset, "limit": args.Limit}, nil
		}})
	for _, id := range []string{"skill.get", "skill.file"} {
		operation := id
		r.Register(Op{AssistantCanvas: true, ID: operation, Summary: "读取当前对话选定技能的固定版本正文或包内辅助文本；不执行脚本", ReadOnly: true, Scope: ScopeCanvas,
			Params: json.RawMessage(`{"type":"object","properties":{"skillId":{"type":"string"},"versionId":{"type":"string"},"contentHash":{"type":"string"},"path":{"type":"string"}},"required":["skillId","versionId","contentHash"]}`),
			Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
				var args struct {
					skills.Pin
					Path string `json:"path"`
				}
				if err := decodeParams(raw, &args); err != nil {
					return nil, err
				}
				port, ok := ctx.Domain.(SkillResources)
				if !ok {
					return nil, Unsupported("skill_unavailable", "当前工作区无法读取技能")
				}
				if operation == "skill.get" {
					if args.Path != "" {
						return nil, InvalidArg("unexpected_path", "正文读取不接收文件路径")
					}
					result, err := port.AgentSkillVersion(ctx.UserID, args.Pin)
					return result, mapDomainError(err)
				}
				if args.Path == "" {
					return nil, InvalidArg("skill_path_required", "辅助文件读取需要包内路径")
				}
				result, err := port.AgentSkillFile(ctx.UserID, args.Pin, args.Path)
				return result, mapDomainError(err)
			}})
	}
}
