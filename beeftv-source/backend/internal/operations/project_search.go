package operations

import "encoding/json"

type ProjectSearch interface {
	SearchAgentProject(userID, canvasID, target, query, kind string, page, pageSize int) (any, error)
}

func registerProjectSearchOps(r *Registry) {
	for _, target := range []string{"media", "canvas"} {
		kind := target
		r.Register(Op{AssistantCanvas: true, ID: "project." + kind + ".search", Summary: "在当前画布所属项目查找媒体或画布；无项目只查当前画布关联资源", ReadOnly: true, Scope: ScopeCanvas,
			Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"query":{"type":"string"},"kind":{"type":"string","enum":["image","video","audio"]},"page":{"type":"integer"},"pageSize":{"type":"integer"}},"required":["canvasId"]}`),
			Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
				var args struct {
					CanvasID string `json:"canvasId"`
					Query    string `json:"query"`
					Kind     string `json:"kind"`
					Page     int    `json:"page"`
					PageSize int    `json:"pageSize"`
				}
				if err := decodeParams(raw, &args); err != nil {
					return nil, err
				}
				if args.CanvasID == "" || len(args.Query) > 256 || args.Page < 0 || args.Page > 10000 || args.PageSize < 0 || args.PageSize > 20 {
					return nil, InvalidArg("invalid_project_search", "搜索需要当前画布、有效页码，每页最多20条")
				}
				if args.Kind != "" && args.Kind != "image" && args.Kind != "video" && args.Kind != "audio" {
					return nil, InvalidArg("invalid_media_kind", "媒体类型无效")
				}
				if kind == "canvas" && args.Kind != "" {
					return nil, InvalidArg("unexpected_media_kind", "画布搜索不接收媒体类型")
				}
				port, ok := ctx.Domain.(ProjectSearch)
				if !ok {
					return nil, Unsupported("project_search_unavailable", "当前工作区无法搜索项目")
				}
				page, size := args.Page, args.PageSize
				if page == 0 {
					page = 1
				}
				if size == 0 {
					size = 20
				}
				result, err := port.SearchAgentProject(ctx.UserID, args.CanvasID, kind, args.Query, args.Kind, page, size)
				return sanitizeForClient(result), mapDomainError(err)
			}})
	}
}
