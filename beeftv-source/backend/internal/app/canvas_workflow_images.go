package app

import (
	"context"
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

const workflowDescribePrompt = "请根据参考图片反推一段适合用于 AI 生图的提示词。只输出提示词正文，不要解释。覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。"

// Text task execution is separate from canvas media-generation capabilities.
// An absent vision declaration is left to the configured model, as on the main canvas.
func workflowDescribeModels(snapshot map[string]any) []modelcatalog.LocalChannelModel {
	raw, _ := json.Marshal(snapshot)
	out := []modelcatalog.LocalChannelModel{}
	for _, candidate := range modelcatalog.ParseLocalChannelModels(raw) {
		if !candidate.Enabled || candidate.Capability != "text" || candidate.Protocol == "" {
			continue
		}
		if candidate.CapabilityConfig != nil {
			b, _ := json.Marshal(candidate.CapabilityConfig)
			profile, err := modelcatalog.DecodeModelCapabilityConfig(string(b))
			if err != nil || profile == nil || profile.Text == nil || profile.Text.References.MaxImages < 1 {
				continue
			}
		}
		out = append(out, candidate)
	}
	preferred := stringValue(snapshot["textModel"])
	for i, item := range out {
		if item.ChannelID+"::"+item.Model == preferred {
			out[0], out[i] = out[i], out[0]
			break
		}
	}
	return out
}

func (s *Service) workflowDescribeRequest(n cw.Node, resource, operation string) (CreateTaskRequest, error) {
	option, _ := n.Config["modelOption"].(string)
	snapshot, err := s.canvasWorkflowProviderConfig()
	if err != nil {
		return CreateTaskRequest{}, err
	}
	for _, candidate := range workflowDescribeModels(snapshot) {
		if !candidate.Enabled || candidate.Capability != "text" || candidate.ChannelID+"::"+candidate.Model != option || candidate.Protocol == "" {
			continue
		}
		config := map[string]any{"model": candidate.Model, "interfaceType": candidate.Protocol, "baseUrl": candidate.BaseURL, "capabilityConfig": candidate.CapabilityConfig}
		input := map[string]any{"mode": "text", "config": config}
		channelID := candidate.ChannelID
		if beefapi.IsManagedChannel(candidate.ChannelID, "", candidate.BaseURL) {
			channelID = "@beefapi"
		}
		if err := s.refreshCanvasWorkflowCredentials(input, channelID); err != nil {
			return CreateTaskRequest{}, err
		}
		prompt, _ := n.Config["prompt"].(string)
		if strings.TrimSpace(prompt) == "" {
			prompt = workflowDescribePrompt
		}
		input["prompt"] = prompt
		if resource != "" {
			input["referenceImages"] = []any{map[string]any{"storageKey": "resource:" + resource}}
		}
		input["metadata"] = map[string]any{"clientOperationId": operation, "nodeId": n.ID, "source": "canvas-workflow"}
		return CreateTaskRequest{Type: "canvas_text", Prompt: prompt, Model: candidate.Model, Input: input}, nil
	}
	return CreateTaskRequest{}, workflowBad("请选择已启用、支持识图的文本模型")
}

func workflowImageCandidates(n cw.Node, d cw.Definition, steps map[string]*cw.Step) []cw.Value {
	values := []cw.Value{}
	seen := map[string]bool{}
	for _, edge := range d.Edges {
		if edge.To != n.ID {
			continue
		}
		source := steps[edge.From]
		if source == nil {
			continue
		}
		candidates := source.Candidates
		if source.ResourceID != "" {
			candidates = []cw.Value{{ResourceID: source.ResourceID}}
		}
		for _, value := range candidates {
			if value.ResourceID != "" && !seen[value.ResourceID] {
				values = append(values, value)
				seen[value.ResourceID] = true
			}
		}
	}
	return values
}

// Selection is a durable checkpoint; choosing twice never submits downstream work twice.
func (s *Service) SelectCanvasWorkflowImage(user, id, node, resource string) (cw.Run, error) {
	s.canvasWorkflowMu.Lock()
	defer s.canvasWorkflowMu.Unlock()
	var row model.CanvasWorkflowRun
	if err := s.repo.DB().Where("id = ? AND user_id = ?", id, user).First(&row).Error; err != nil {
		return cw.Run{}, workflowNotFound()
	}
	run, err := workflowRun(row)
	if err != nil {
		return run, err
	}
	if run.Status != "running" {
		return run, workflowBad("当前工作流不在等待选择")
	}
	for i := range run.Steps {
		step := &run.Steps[i]
		if step.NodeID != node {
			continue
		}
		if step.Status == "succeeded" && step.ResourceID == resource {
			return run, nil
		}
		if step.Status != "waiting_selection" {
			return run, workflowBad("此步骤不在等待选图")
		}
		for _, candidate := range step.Candidates {
			if candidate.ResourceID != resource {
				continue
			}
			if _, err := s.workflowResource(user, resource, "image"); err != nil {
				return run, err
			}
			step.ResourceID, step.Status = resource, "succeeded"
			if err := s.saveCanvasWorkflowRun(&row, run); err != nil {
				return run, err
			}
			return workflowRun(row)
		}
		return run, workflowBad("请选择本轮生成的候选图片")
	}
	return run, workflowBad("选择步骤不存在")
}

func (s *Service) executeWorkflowUpscale(user, operation string, n cw.Node, resource string) (*model.Task, error) {
	request, err := cw.UpscaleRequest(n)
	if err != nil {
		return nil, err
	}
	request.ResourceID, request.ClientOperationID, request.NodeID = resource, operation, n.ID
	return s.CreateMediaUpscale(context.Background(), user, request)
}
