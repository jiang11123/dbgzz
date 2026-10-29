package operations

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/canvas/capability"
)

// RegisterDefaultOps 注册全部对外操作（手工 UI、CLI、MCP 与内置助手共用）。
// 付费生成只经 canvas.generation.propose 提议、由界面确认后执行；
// 未经参数与费用风险验收的能力明确不注册，而不是提供 stub 伪成功。
func RegisterDefaultOps(r *Registry) {
	registerCanvasEditOps(r)
	registerCanvasNodeBindAsset(r)
	registerModelCatalogOp(r)
	registerMediaOps(r)
	registerSkillOps(r)
	registerSkillMarketOps(r)
	registerSkillPublishingOps(r)
	registerProjectSearchOps(r)
	registerCanvasTimelineOps(r)
	registerCanvasRenderOps(r)
	registerCanvasNodeConfigureOps(r)
	registerStoryboardPreparation(r)
	registerGenerationSubmit(r)
	registerCanvasProjectExportOps(r)
	r.Register(Op{AssistantCanvas: true, ID: "canvas.get", Summary: "读取指定画布的完整内容（节点与连线）", ReadOnly: true, Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"}},"required":["canvasId"]}`),
		Handler: opCanvasGet})
	r.Register(Op{ID: "canvas.search", Summary: "按关键字分页搜索工作区内的画布", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"page":{"type":"integer"},"pageSize":{"type":"integer"},"query":{"type":"string"},"canvasId":{"type":"string"},"sort":{"type":"string"}}}`),
		Handler: opCanvasSearch})
	r.Register(Op{ID: "asset.list", Summary: "分页列出用户素材库中的素材", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"page":{"type":"integer"},"pageSize":{"type":"integer"},"query":{"type":"string"},"kind":{"type":"string"},"category":{"type":"string"},"favorite":{"type":"boolean"},"recent":{"type":"boolean"},"project":{"type":"string"},"generated":{"type":"boolean"}}}`),
		Handler: opAssetList})
	r.Register(assetGetOperation())
	r.Register(Op{AssistantCanvas: true, ID: "task.get", Summary: "按 ID 查询任务状态与产物引用", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"]}`),
		Handler: opTaskGet})
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.node.update", Summary: "局部修改一个节点（只提交目标字段，其余数据保持原样，带 revision CAS）", Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"nodeId":{"type":"string"},"expectedRevision":{"type":"integer"},"patch":{"type":"object","properties":{"title":{"type":"string"},"prompt":{"type":"string"},"content":{"type":"string"},"mode":{"type":"string","enum":["chat","image","video"],"description":"仅豆包账号节点：任务类型"},"accountId":{"type":"integer","description":"仅豆包账号节点：豆包账号编号"},"ratio":{"type":"string","description":"仅豆包账号节点：画幅比例，如 16:9"},"duration":{"type":"number","description":"仅豆包账号节点：视频时长（秒）"},"videoModel":{"type":"string","description":"仅豆包账号节点：视频模型"}}}},"required":["canvasId","nodeId","patch","expectedRevision"]}`),
		Handler: opCanvasNodeUpdate})
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.nodes.create", Summary: "在画布上批量创建节点（整批校验，带 revision CAS）", Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"expectedRevision":{"type":"integer"},"nodes":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"type":{"type":"string"},"prompt":{"type":"string"}},"required":["title","type"]}}},"required":["canvasId","nodes","expectedRevision"]}`),
		Handler: opCanvasNodesCreate})
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.edge.create", Summary: "连接两个节点（重复连接幂等返回）", Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"fromNodeId":{"type":"string"},"toNodeId":{"type":"string"},"expectedRevision":{"type":"integer"}},"required":["canvasId","fromNodeId","toNodeId","expectedRevision"]}`),
		Handler: opCanvasEdgeCreate})
	// 分镜脚本节点的行级写入：行 ID 与镜号由服务端分配，字段白名单见 canvas.StoryboardRowDraft。
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.script.rows.append", Summary: "向分镜脚本节点批量追加分镜行（行 ID 与镜号由服务端分配，行结构对齐界面默认值）", Scope: ScopeCanvas,
		Params:  storyboardRowsAppendSchema(),
		Handler: opStoryboardRowsAppend})
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.script.row.update", Summary: "按行 ID 批量局部更新分镜行（只覆盖给出的字段，未知行整批拒绝）", Scope: ScopeCanvas,
		Params:  storyboardRowUpdateSchema(),
		Handler: opStoryboardRowUpdate})
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.script.row.remove", Summary: "按行 ID 批量删除分镜行并重排镜号（未知行整批拒绝）", Scope: ScopeCanvas,
		Params:  storyboardRowRemoveSchema(),
		Handler: opStoryboardRowRemove})
	r.Register(Op{ReplaySafe: true, ID: "canvas.document.commit", Summary: "按已知服务端 revision 提交整份画布文档（保留未触及字段，带 CAS）", Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"expectedRevision":{"type":"integer"},"document":{"type":"object"}},"required":["canvasId","expectedRevision","document"]}`),
		Handler: opCanvasDocumentCommit})
	// 付费生成只提议不执行：这里校验目标并给出用户要确认的模型，真正的生成由界面在用户确认后发起。
	r.Register(Op{AssistantProposal: true, AssistantCanvas: true, ID: "canvas.generation.propose", Summary: "提议对选中节点做付费图片/视频生成（只登记提议，不生成、不扣费）", ReadOnly: true, Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"nodeIds":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":8},"kind":{"type":"string","enum":["image","video","audio"]},"productionNodeIds":{"type":"array","items":{"type":"string"},"maxItems":24,"description":"完整制作时，先准备所有首帧、视频和旁白草稿，将全部计划生成的节点列在这里，一次确认后后台继续；nodeIds仍只列当前依赖已就绪的首批"},"note":{"type":"string"}},"required":["canvasId","nodeIds","kind"]}`),
		Handler: opCanvasGenerationPropose})
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.task.bind", Summary: "把已交付任务产物绑定到原节点；同画布本地时间线成片可绑定到空 video 节点，绑定后用 nodeId 检查成片（校验归属、就绪资源与版本，幂等回执）", Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"taskId":{"type":"string"},"nodeId":{"type":"string"},"outputIndex":{"type":"integer"}},"required":["canvasId","taskId","nodeId"]}`),
		Handler: opCanvasTaskBind, ProjectReplay: projectCanvasTaskBindReplay})
	r.Register(Op{ID: "conversation.message.attach", Summary: "把已交付的任务产物绑定到原对话消息（校验归属与就绪资源，带 revision CAS，幂等回执）", Scope: ScopeConversation,
		Params:  json.RawMessage(`{"type":"object","properties":{"conversationId":{"type":"string"},"taskId":{"type":"string"},"messageId":{"type":"string"},"outputIndex":{"type":"integer"}},"required":["conversationId","taskId","messageId"]}`),
		Handler: opConversationMessageAttach, ProjectReplay: projectConversationMessageAttachReplay})
}

func opCanvasGenerationPropose(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID          string   `json:"canvasId"`
		NodeIDs           []string `json:"nodeIds"`
		Kind              string   `json:"kind"`
		Note              string   `json:"note"`
		ProductionNodeIDs []string `json:"productionNodeIds"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 必填")
	}
	if args.Kind != "image" && args.Kind != "video" && args.Kind != "audio" {
		return nil, InvalidArg("invalid_kind", "kind 只能是 image、video 或 audio")
	}
	if len(args.NodeIDs) == 0 || len(args.NodeIDs) > 8 {
		return nil, InvalidArg("invalid_batch", "nodeIds 必须是 1..8 项的数组")
	}
	raw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, AsError(err)
	}
	owned := map[string]map[string]any{}
	for _, rawNode := range canvasNodes(doc) {
		if node, ok := rawNode.(map[string]any); ok {
			if id, _ := node["id"].(string); id != "" {
				owned[id] = node
			}
		}
	}
	seen := make(map[string]bool, len(args.NodeIDs))
	nodeIDs := make([]string, 0, len(args.NodeIDs))
	for _, id := range args.NodeIDs {
		if _, exists := owned[id]; !exists {
			return nil, InvalidArg("node_not_in_canvas", "节点不属于当前画布: "+id)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		nodeIDs = append(nodeIDs, id)
	}
	var resolved AssistantGenerationModel
	for _, id := range nodeIDs {
		node := owned[id]
		if err := validateProposalNodeKind(node, args.Kind); err != nil {
			return nil, err
		}
		choice, err := ctx.Domain.ResolveAssistantGenerationModel(args.Kind, nodeSelectedModel(node))
		if err != nil {
			return nil, AsError(err)
		}
		if choice.KindMismatch {
			return nil, InvalidArg("generation_model_kind_mismatch", "这个节点当前的模型不能用来生成"+generationKindLabel(args.Kind))
		}
		if choice.Display == "" || choice.ModelKey == "" {
			if nodeSelectedModel(node) != "" {
				return nil, PreconditionFailed("generation_model_unavailable", "当前节点的模型暂不可用，请重新选择模型后再生成", nil)
			}
			return nil, PreconditionFailed("generation_model_not_configured", "还没有设置默认的"+generationKindLabel(args.Kind)+"模型", nil)
		}
		if resolved.ModelKey == "" {
			resolved = choice
			continue
		}
		if choice.Revision != resolved.Revision {
			return nil, PreconditionFailed("generation_config_changed", "模型配置刚刚有变动，请再提出一次生成", nil)
		}
		if choice.ModelKey != resolved.ModelKey {
			return nil, InvalidArg("mixed_generation_models", "这些节点当前选用了不同的模型，请按模型分开提出生成")
		}
	}
	if err := validateGenerationDependencies(doc, owned, nodeIDs, args.Kind); err != nil {
		return nil, err
	}
	result := map[string]any{
		"proposalId": newProposalID(), "kind": args.Kind, "nodeIds": nodeIDs,
		"model": resolved.Display, "modelKey": resolved.ModelKey, "note": strings.TrimSpace(args.Note),
		"source": map[string]any{"canvasId": args.CanvasID, "canvasRevision": doc["revision"], "modelConfigRevision": resolved.Revision},
	}
	if len(args.ProductionNodeIDs) > 0 {
		targets, err := GenerationTargets(ctx.Domain, doc, args.ProductionNodeIDs)
		if err != nil {
			return nil, err
		}
		included := map[string]bool{}
		for _, target := range targets {
			included[target.NodeID] = true
		}
		for _, id := range nodeIDs {
			if !included[id] {
				return nil, InvalidArg("production_target_missing", "首批素材必须包含在整片制作计划中")
			}
		}
		result["production"] = map[string]any{"targets": targets}
	}
	return result, nil
}

func generationKindLabel(kind string) string {
	if kind == "video" {
		return "视频"
	}
	if kind == "audio" {
		return "音频"
	}
	return "图片"
}

func nodeSelectedModel(node map[string]any) string {
	metadata, _ := node["metadata"].(map[string]any)
	if metadata == nil {
		return ""
	}
	model, _ := metadata["model"].(string)
	return strings.TrimSpace(model)
}

func nodeGenerationKind(node map[string]any) string {
	if metadata, _ := node["metadata"].(map[string]any); metadata != nil {
		if mode, _ := metadata["generationMode"].(string); strings.TrimSpace(mode) != "" {
			return strings.ToLower(strings.TrimSpace(mode))
		}
	}
	nodeType, _ := node["type"].(string)
	if descriptor, ok := capability.BuiltinRegistry().Resolve(nodeType); ok {
		return descriptor.GenerationMode
	}
	return ""
}

func validateProposalNodeKind(node map[string]any, kind string) error {
	nodeKind := nodeGenerationKind(node)
	if nodeKind != "" && nodeKind != kind {
		return InvalidArg("generation_kind_mismatch", "这个节点不能用来生成"+generationKindLabel(kind))
	}
	return nil
}

func newProposalID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("gp-%d", time.Now().UnixNano())
	}
	return "gp-" + hex.EncodeToString(buf)
}

func opCanvasGet(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID string `json:"canvasId"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 必填")
	}
	raw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, AsError(err)
	}
	return map[string]any{"canvasId": args.CanvasID, "canvas": sanitizeForClient(doc)}, nil
}

func opCanvasSearch(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		Page     int    `json:"page"`
		PageSize int    `json:"pageSize"`
		Query    string `json:"query"`
		CanvasID string `json:"canvasId"`
		Sort     string `json:"sort"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	page := args.Page
	if page <= 0 {
		page = 1
	}
	size := args.PageSize
	if size <= 0 {
		size = 20
	}
	if size > 100 {
		size = 100
	}
	result, err := ctx.Domain.UserCanvasProjectsPage(ctx.UserID, page, size, args.CanvasID, args.Query, args.Sort)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return sanitizeForClient(result), nil
}

func opAssetList(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		Page      int    `json:"page"`
		PageSize  int    `json:"pageSize"`
		Query     string `json:"query"`
		Kind      string `json:"kind"`
		Category  string `json:"category"`
		Favorite  bool   `json:"favorite"`
		Recent    bool   `json:"recent"`
		Project   string `json:"project"`
		Generated bool   `json:"generated"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	page := args.Page
	if page <= 0 {
		page = 1
	}
	size := args.PageSize
	if size <= 0 {
		size = 40
	}
	if size > 100 {
		size = 100
	}
	result, err := ctx.Domain.UserAssetsPage(ctx.UserID, page, size, canvas.UserAssetPageFilter{
		Kind: args.Kind, Category: args.Category, Query: args.Query,
		Favorite: args.Favorite, Recent: args.Recent, Project: args.Project, Generated: args.Generated,
	})
	if err != nil {
		return nil, mapDomainError(err)
	}
	return sanitizeForClient(result), nil
}

// Binding and direct reads must authorize against the same operation definition.
func assetGetOperation() Op {
	return Op{AssistantCanvas: true, ID: "asset.get", Summary: "按 ID 读取单个素材", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"assetId":{"type":"string"}},"required":["assetId"]}`),
		Handler: opAssetGet}
}

func opAssetGet(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		AssetID string `json:"assetId"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.AssetID) == "" {
		return nil, InvalidArg("invalid_params", "assetId 必填")
	}
	raw, err := ctx.Domain.UserAsset(ctx.UserID, args.AssetID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var asset any
	if err := json.Unmarshal(raw, &asset); err != nil {
		return nil, AsError(err)
	}
	return map[string]any{"assetId": args.AssetID, "asset": sanitizeForClient(asset)}, nil
}

func opTaskGet(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		TaskID string `json:"taskId"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, InvalidArg("invalid_params", "taskId 必填")
	}
	task, err := ctx.Domain.Task(ctx.UserID, args.TaskID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if task == nil {
		return nil, NotFound("task_not_found", "任务不存在")
	}
	return map[string]any{
		"taskId": task.ID, "type": task.Type, "status": task.Status, "progress": task.Progress,
		"outputs": task.Outputs, "resultState": task.ResultState, "delivery": task.Delivery,
		"createdAt": task.CreatedAt, "updatedAt": task.UpdatedAt,
	}, nil
}

func canvasRevision(doc map[string]any) int64 {
	switch v := doc["revision"].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return n
		}
	}
	return 0
}

func canvasNodes(doc map[string]any) []any {
	if nodes, ok := doc["nodes"].([]any); ok {
		return nodes
	}
	return []any{}
}

func opCanvasNodeUpdate(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string `json:"canvasId"`
		NodeID           string `json:"nodeId"`
		ExpectedRevision int64  `json:"expectedRevision"`
		Patch            struct {
			Title   *string `json:"title"`
			Prompt  *string `json:"prompt"`
			Content *string `json:"content"`
			// 以下只对声明了对应补丁字段的节点类型（豆包账号节点）生效，其余类型由描述符拒绝。
			Mode       *string  `json:"mode"`
			AccountID  *float64 `json:"accountId"`
			Ratio      *string  `json:"ratio"`
			Duration   *float64 `json:"duration"`
			VideoModel *string  `json:"videoModel"`
		} `json:"patch"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.NodeID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 与 nodeId 必填")
	}
	patch := map[string]any{}
	if args.Patch.Title != nil {
		patch["title"] = *args.Patch.Title
	}
	if args.Patch.Prompt != nil {
		patch["prompt"] = *args.Patch.Prompt
	}
	if args.Patch.Content != nil {
		patch["content"] = *args.Patch.Content
	}
	if args.Patch.Mode != nil {
		patch["mode"] = *args.Patch.Mode
	}
	if args.Patch.AccountID != nil {
		patch["accountId"] = *args.Patch.AccountID
	}
	if args.Patch.Ratio != nil {
		patch["ratio"] = *args.Patch.Ratio
	}
	if args.Patch.Duration != nil {
		patch["duration"] = *args.Patch.Duration
	}
	if args.Patch.VideoModel != nil {
		patch["videoModel"] = *args.Patch.VideoModel
	}
	if len(patch) == 0 {
		return nil, InvalidArg("empty_patch", "patch 至少要有一个字段")
	}
	if _, err := ctx.Domain.UpdateUserCanvasNodeFields(ctx.UserID, args.CanvasID, args.NodeID, patch, args.ExpectedRevision); err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "node": findDocNode(doc, args.NodeID)}
	})
}

func opCanvasNodesCreate(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string `json:"canvasId"`
		ExpectedRevision int64  `json:"expectedRevision"`
		Nodes            []struct {
			Title  string `json:"title"`
			Type   string `json:"type"`
			Prompt string `json:"prompt"`
		} `json:"nodes"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 必填")
	}
	if len(args.Nodes) == 0 || len(args.Nodes) > 8 {
		return nil, InvalidArg("invalid_batch", "nodes 必须是 1..8 项的数组")
	}
	drafts := make([]canvas.NodeDraft, 0, len(args.Nodes))
	for _, node := range args.Nodes {
		drafts = append(drafts, canvas.NodeDraft{Title: node.Title, Type: node.Type, Prompt: node.Prompt})
	}
	_, createdNodes, err := ctx.Domain.CreateUserCanvasNodes(ctx.UserID, args.CanvasID, drafts, args.ExpectedRevision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		created := make([]map[string]any, 0, len(createdNodes))
		for _, node := range createdNodes {
			created = append(created, map[string]any{"id": node.ID, "title": node.Title, "type": node.Type})
		}
		return map[string]any{"canvasId": args.CanvasID, "created": created}
	})
}

func opCanvasDocumentCommit(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string          `json:"canvasId"`
		ExpectedRevision *int64          `json:"expectedRevision"`
		Document         json.RawMessage `json:"document"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 必填")
	}
	if args.ExpectedRevision == nil {
		return nil, InvalidArg("invalid_params", "expectedRevision 必填")
	}
	if *args.ExpectedRevision < 0 {
		return nil, InvalidArg("invalid_params", "expectedRevision 无效")
	}
	if len(args.Document) == 0 || strings.TrimSpace(string(args.Document)) == "null" {
		return nil, InvalidArg("invalid_params", "document 必填")
	}
	summary, _, err := ctx.Domain.CommitUserCanvasDocument(ctx.UserID, args.CanvasID, *args.ExpectedRevision, args.Document)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{
		"canvasId":  args.CanvasID,
		"revision":  summary.Revision,
		"title":     summary.Title,
		"updatedAt": summary.UpdatedAt,
	}, nil
}

func opCanvasEdgeCreate(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string `json:"canvasId"`
		FromNodeID       string `json:"fromNodeId"`
		ToNodeID         string `json:"toNodeId"`
		ExpectedRevision int64  `json:"expectedRevision"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.FromNodeID) == "" || strings.TrimSpace(args.ToNodeID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId、fromNodeId、toNodeId 必填")
	}
	if args.FromNodeID == args.ToNodeID {
		return nil, InvalidArg("self_loop", "不能把节点连接到自身")
	}
	summary, err := ctx.Domain.ConnectUserCanvasNodesAtRevision(ctx.UserID, args.CanvasID, args.FromNodeID, args.ToNodeID, args.ExpectedRevision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	created := summary.Revision != args.ExpectedRevision
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		return map[string]any{"canvasId": args.CanvasID, "duplicate": !created, "revision": summary.Revision,
			"edgeId": findDocEdgeID(doc, args.FromNodeID, args.ToNodeID), "created": created}
	})
}

func canvasWriteResult(ctx *Context, canvasID string, build func(doc map[string]any) map[string]any) (any, error) {
	after, err := ctx.Domain.UserCanvasProject(ctx.UserID, canvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(after, &doc); err != nil {
		return nil, AsError(err)
	}
	payload := build(doc)
	payload["revision"] = canvasRevision(doc)
	return payload, nil
}

func findDocNode(doc map[string]any, nodeID string) map[string]any {
	if nodes, ok := doc["nodes"].([]any); ok {
		for _, rawNode := range nodes {
			if node, ok := rawNode.(map[string]any); ok {
				if id, _ := node["id"].(string); id == nodeID {
					return node
				}
			}
		}
	}
	return nil
}

func findDocEdgeID(doc map[string]any, fromNodeID, toNodeID string) string {
	connections, _ := doc["connections"].([]any)
	for _, rawEdge := range connections {
		edge, ok := rawEdge.(map[string]any)
		if !ok {
			continue
		}
		from, _ := edge["fromNodeId"].(string)
		to, _ := edge["toNodeId"].(string)
		if from == fromNodeID && to == toNodeID {
			id, _ := edge["id"].(string)
			return id
		}
	}
	return ""
}
