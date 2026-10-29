package operations

import (
	"context"
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

type CanvasProjectExporter interface {
	ExportCanvasProjectArchive(context.Context, string, string, json.RawMessage) (*model.Resource, error)
}

func registerCanvasProjectExportOps(r *Registry) {
	r.Register(Op{ID: "canvas.project.export", Summary: "免费导出已保存画布与素材为 BeefTV 可编辑工程 ZIP；返回可下载资源", Scope: ScopeCanvas, AssistantCanvas: true, ReplaySafe: true,
		Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"expectedRevision":{"type":"integer","minimum":0}},"required":["canvasId","expectedRevision"]}`), Handler: opCanvasProjectExport})
}

func opCanvasProjectExport(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string `json:"canvasId"`
		ExpectedRevision *int64 `json:"expectedRevision"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || args.ExpectedRevision == nil || *args.ExpectedRevision < 0 || strings.TrimSpace(ctx.OperationID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId、expectedRevision 和稳定操作标识必填")
	}
	exporter, ok := ctx.Domain.(CanvasProjectExporter)
	if !ok {
		return nil, Unsupported("project_export_unavailable", "当前工作区无法导出工程")
	}
	document, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(document, &doc); err != nil {
		return nil, AsError(err)
	}
	if revision := canvasRevision(doc); revision != *args.ExpectedRevision {
		return nil, Conflict("revision_conflict", "画布已变化，请重新读取", map[string]any{"currentRevision": revision})
	}
	resource, err := exporter.ExportCanvasProjectArchive(ctx.Context, ctx.UserID, ctx.OperationID, document)
	if err != nil {
		return nil, mapDomainError(err)
	}
	name, _ := doc["title"].(string)
	name = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) || r < 32 {
			return '_'
		}
		return r
	}, strings.TrimSpace(name))
	if name == "" {
		name = "BeefTV工程"
	}
	return map[string]any{"canvasId": args.CanvasID, "sourceRevision": *args.ExpectedRevision, "resourceId": resource.ID, "storageKey": "resource:" + resource.ID, "fileName": name + ".zip", "mimeType": resource.MimeType, "bytes": resource.Size, "local": true, "charged": false, "editable": true}, nil
}
