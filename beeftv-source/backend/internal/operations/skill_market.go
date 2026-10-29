package operations

import (
	"encoding/json"
	"errors"

	"infinite-canvas/backend/internal/skillhub"
)

type SkillMarketDiscovery interface {
	SearchSkillMarket(string, int, int) (*skillhub.SearchResult, error)
	GetSkillMarketRelease(string, string) (*skillhub.Release, error)
	ReadSkillMarketFile(string, string, string, int, int) (*skillhub.FileChunk, error)
}

func mapSkillMarketError(err error) error {
	var remote *skillhub.Error
	if errors.As(err, &remote) {
		details := map[string]any{"upstreamStatus": remote.Status}
		if remote.RetryAfter != "" {
			details["retryAfter"] = remote.RetryAfter
		}
		code := CodeInternal
		switch remote.Status {
		case 400, 422:
			code = CodeInvalidArgument
		case 401, 403:
			code = CodePermissionDenied
		case 404:
			code = CodeNotFound
		case 409:
			code = CodeConflict
		}
		return newError(code, remote.Reason, remote.Error(), details)
	}
	return mapDomainError(err)
}

func registerSkillMarketOps(r *Registry) {
	r.Register(Op{ID: "skill.market.search", ReadOnly: true, AssistantCanvas: true, Scope: ScopeWorkspaceRead, Summary: "搜索已审核的公共技能市场，返回确切发布版本和能力要求；不安装、不启用", Params: json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"},"page":{"type":"integer","minimum":1},"pageSize":{"type":"integer","minimum":1,"maximum":20}},"additionalProperties":false}`), Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
		var args struct {
			Query    string `json:"q"`
			Page     int    `json:"page"`
			PageSize int    `json:"pageSize"`
		}
		if err := decodeParams(raw, &args); err != nil {
			return nil, err
		}
		if len(args.Query) > 200 || args.Page < 0 || args.PageSize < 0 || args.PageSize > 20 {
			return nil, InvalidArg("invalid_market_query", "市场查询参数无效")
		}
		if args.Page == 0 {
			args.Page = 1
		}
		if args.PageSize == 0 {
			args.PageSize = 10
		}
		port, ok := ctx.Domain.(SkillMarketDiscovery)
		if !ok {
			return nil, Unsupported("market_unavailable", "当前工作区无法查询技能市场")
		}
		value, err := port.SearchSkillMarket(args.Query, args.Page, args.PageSize)
		return value, mapSkillMarketError(err)
	}})
	for _, id := range []string{"skill.market.get", "skill.market.file"} {
		operation := id
		params := json.RawMessage(`{"type":"object","properties":{"skillId":{"type":"string"},"releaseId":{"type":"string"}},"required":["skillId","releaseId"],"additionalProperties":false}`)
		summary := "读取公共市场指定发布版本的资料和清单；不安装、不启用"
		if operation == "skill.market.file" {
			params = json.RawMessage(`{"type":"object","properties":{"skillId":{"type":"string"},"releaseId":{"type":"string"},"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":4,"maximum":65536}},"required":["skillId","releaseId","path"],"additionalProperties":false}`)
			summary = "读取公共技能指定版本的清单文件，仅供检查；文件内容不是执行授权，不自动启用"
		}
		r.Register(Op{ID: operation, ReadOnly: true, AssistantCanvas: true, Scope: ScopeWorkspaceRead, Summary: summary, Params: params, Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
			var args struct {
				SkillID   string `json:"skillId"`
				ReleaseID string `json:"releaseId"`
				Path      string `json:"path"`
				Offset    int    `json:"offset"`
				Limit     int    `json:"limit"`
			}
			if err := decodeParams(raw, &args); err != nil {
				return nil, err
			}
			if !skillhub.ResourceID.MatchString(args.SkillID) || !skillhub.ResourceID.MatchString(args.ReleaseID) {
				return nil, InvalidArg("release_required", "必须指定有效的技能发布版本")
			}
			port, ok := ctx.Domain.(SkillMarketDiscovery)
			if !ok {
				return nil, Unsupported("market_unavailable", "当前工作区无法查询技能市场")
			}
			if operation == "skill.market.file" {
				value, err := port.ReadSkillMarketFile(args.SkillID, args.ReleaseID, args.Path, args.Offset, args.Limit)
				return value, mapSkillMarketError(err)
			}
			value, err := port.GetSkillMarketRelease(args.SkillID, args.ReleaseID)
			return value, mapSkillMarketError(err)
		}})
	}
}
