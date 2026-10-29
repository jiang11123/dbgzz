package operations

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// TimelineRenderAdmission must use the operation's transaction for admission.
type TimelineRenderAdmission interface {
	CreateCanvasTimelineRender(userID string, req localtask.TimelineRenderCreateRequest) (*model.Task, error)
}

func registerCanvasRenderOps(r *Registry) {
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.timeline.render", Summary: "免费本地渲染已保存的时间线，返回任务以供查询成片；不调用付费生成", Scope: ScopeCanvas,
		Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"expectedRevision":{"type":"integer","minimum":0},"options":{"type":"object","properties":{"width":{"type":"integer"},"height":{"type":"integer"},"fps":{"type":"integer"},"sampleRate":{"type":"integer"},"burnSubtitles":{"type":"boolean"}}}},"required":["canvasId","expectedRevision"]}`), Handler: opCanvasTimelineRender})
}

func opCanvasTimelineRender(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string          `json:"canvasId"`
		ExpectedRevision *int64          `json:"expectedRevision"`
		Options          editing.Options `json:"options"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || args.ExpectedRevision == nil || *args.ExpectedRevision < 0 || strings.TrimSpace(ctx.OperationID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId、expectedRevision 和稳定操作标识必填")
	}
	admission, ok := ctx.Domain.(TimelineRenderAdmission)
	if !ok {
		return nil, Unsupported("timeline_render_unavailable", "当前工作区无法创建本地渲染任务")
	}
	canvasRaw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(canvasRaw, &doc); err != nil {
		return nil, AsError(err)
	}
	if revision := canvasRevision(doc); revision != *args.ExpectedRevision {
		return nil, Conflict("revision_conflict", "画布已变化，请重新读取", map[string]any{"currentRevision": revision})
	}
	timelineRaw, err := json.Marshal(doc["timeline"])
	if err != nil {
		return nil, AsError(err)
	}
	var timeline editing.Project
	if err = json.Unmarshal(timelineRaw, &timeline); err != nil {
		return nil, InvalidArg("invalid_timeline", "画布中没有有效时间线")
	}
	sources, err := timelineSources(ctx, doc, &timeline)
	if err != nil {
		return nil, err
	}
	if _, err = editing.Compile(timeline, sources, args.Options); err != nil {
		return nil, InvalidArg("invalid_timeline", err.Error())
	}
	task, err := admission.CreateCanvasTimelineRender(ctx.UserID, localtask.TimelineRenderCreateRequest{ProjectID: args.CanvasID, Timeline: timeline, Options: args.Options, ClientOperationID: "assistant-render:" + ctx.OperationID})
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{"canvasId": args.CanvasID, "taskId": task.ID, "status": task.Status, "local": true, "charged": false, "sourceRevision": *args.ExpectedRevision}, nil
}
