package app

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/assets"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/topaz"
)

type workflowBinding struct {
	NodeID         string
	Field          string
	Index          int
	Original       string
	ReferenceLabel string
}
type workflowRecipe struct {
	OutputCount               int
	Request                   CreateTaskRequest
	Bindings                  []workflowBinding
	ChannelID                 string
	VideoDurationSourceNodeID string
}
type workflowRecipes map[string]workflowRecipe

func workflowReferenceID(v any) string {
	m, _ := v.(map[string]any)
	for _, key := range []string{"resourceId", "storageKey", "url", "dataUrl", "id"} {
		raw, _ := m[key].(string)
		if strings.HasPrefix(raw, "resource:") {
			return strings.TrimPrefix(raw, "resource:")
		}
		if id := assets.IDFromFileURL(raw); id != "" {
			return id
		}
		if key == "resourceId" && raw != "" {
			return raw
		}
	}
	return ""
}

func workflowMediaField(kind string) string {
	switch kind {
	case "image":
		return "referenceImages"
	case "video":
		return "referenceVideos"
	case "audio":
		return "referenceAudios"
	}
	return ""
}

func (s *Service) compileCanvasWorkflow(user string, d cw.Definition, existing ...model.CanvasWorkflow) (workflowRecipes, map[string]bool, error) {
	order, e := cw.Validate(d)
	if e != nil {
		return nil, nil, workflowBad(e.Error())
	}
	recipes := workflowRecipes{}
	previous := workflowRecipes{}
	previousNodes := map[string]cw.Node{}
	if len(existing) > 0 {
		var old cw.Definition
		if e = json.Unmarshal([]byte(existing[0].DefinitionJSON), &old); e != nil {
			return nil, nil, e
		}
		for _, node := range old.Nodes {
			previousNodes[node.ID] = node
		}
		plain, err := s.decryptSettingSecret(existing[0].RecipeCipher)
		if err != nil {
			return nil, nil, err
		}
		if e = json.Unmarshal([]byte(plain), &previous); e != nil {
			return nil, nil, e
		}
	}
	refs := map[string]bool{}
	nodes := map[string]cw.Node{}
	for _, n := range order {
		nodes[n.ID] = n
	}
	for _, n := range order {
		if n.ResourceID != "" {
			if _, e = s.workflowResource(user, n.ResourceID, n.MediaType); e != nil {
				return nil, nil, e
			}
			refs[n.ResourceID] = true
		}
		if n.Role == "constant" && n.MediaType != "text" && n.ResourceID == "" {
			return nil, nil, workflowBad("素材节点 " + n.Title + " 缺少持久资源，请先保存素材")
		}
		if n.Role == "depth" || n.OperationID == "video.depth" {
			for _, edge := range d.Edges {
				if edge.To == n.ID && nodes[edge.From].MediaType != "video" {
					return nil, nil, workflowBad("深度步骤需要视频输入")
				}
			}
			continue
		}
		if n.Role != "generation" && !strings.HasPrefix(n.OperationID, "generate.") {
			if n.OperationID == "image.describe" {
				if _, err := s.workflowDescribeRequest(n, "", ""); err != nil {
					return nil, nil, err
				}
			}
			if strings.HasSuffix(n.OperationID, ".ai-upscale") {
				request, err := cw.UpscaleRequest(n)
				if err != nil {
					return nil, nil, err
				}
				if _, err = s.upscaleConfig(topaz.ModelID(request.Model)); err != nil {
					return nil, nil, err
				}
			}
			continue
		}
		var task *model.Task
		var input map[string]any
		reusing := false
		if original, ok := previous[n.ID]; ok && previousNodes[n.ID].SourceTaskID == n.SourceTaskID && previousNodes[n.ID].MediaType == n.MediaType {
			reusing = true
			raw, err := json.Marshal(original.Request.Input)
			if err != nil {
				return nil, nil, err
			}
			if e = json.Unmarshal(raw, &input); e != nil {
				return nil, nil, e
			}
			task = &model.Task{Status: model.TaskStatusSucceeded, Type: original.Request.Type, Operation: original.Request.Operation, Prompt: original.Request.Prompt, Provider: original.Request.Provider, Model: original.Request.Model, LogicalModelID: original.Request.LogicalModelID}
		} else if n.SourceTaskID == "" && strings.HasPrefix(n.OperationID, "generate.") {
			input = map[string]any{"mode": n.MediaType, "config": map[string]any{}, "prompt": ""}
			task = &model.Task{Status: model.TaskStatusSucceeded, Type: "canvas_" + n.MediaType}
		} else {
			task, e = s.repo.TaskForUser(user, n.SourceTaskID)
		}
		if e != nil || task.Status != model.TaskStatusSucceeded {
			return nil, nil, workflowBad("生成步骤 " + n.Title + " 的原任务不存在或尚未成功")
		}
		outputCount := len(localtask.CanonicalOutputs(task.ResultJSON, task.Type))
		if outputCount > 1 && n.MediaType != "image" {
			return nil, nil, workflowBad("此类多结果任务暂不支持封装，请使用单结果生成任务")
		}
		if input == nil {
			input, e = s.canvasWorkflowSourceInput(task)
			if e != nil {
				return nil, nil, e
			}
		}
		mode, _ := input["mode"].(string)
		if mode != "image" && mode != "video" && mode != "audio" && mode != "text" {
			return nil, nil, workflowBad("此任务类型暂不能封装，请使用标准图片、视频、文本或音频生成节点")
		}
		if mode != n.MediaType {
			return nil, nil, workflowBad("生成步骤的输出类型与原任务不一致")
		}
		if input["agentRequests"] != nil {
			return nil, nil, workflowBad("Agent 工具请求暂不能封装为工作流")
		}
		cleanCanvasWorkflowBindings(input)
		delete(input, "clientOperationId")
		delete(input, "retryTaskId")
		// Include fixed references outside the selected subgraph, including masks
		// and provider workflow fields, in ownership and deletion protection.
		var frozenIDs map[string]bool
		frozenIDs = workflowResourceIDs(input)
		for id := range frozenIDs {
			if _, e = s.workflowResource(user, id, ""); e != nil {
				return nil, nil, e
			}
			refs[id] = true
		}
		recipe := workflowRecipe{Request: CreateTaskRequest{Type: "canvas_" + mode, Operation: task.Operation, Prompt: task.Prompt, Provider: task.Provider, Model: task.Model, LogicalModelID: task.LogicalModelID, Input: input}}
		modelEdited, modelErr := s.selectWorkflowModel(n, &recipe)
		if modelErr != nil {
			return nil, nil, modelErr
		}
		if reusing && !modelEdited {
			outputCount = max(outputCount, previous[n.ID].OutputCount)
		}
		if n.MediaType == "image" {
			var generationInput canvasGenerationInput
			encoded, _ := json.Marshal(input)
			if err := json.Unmarshal(encoded, &generationInput); err != nil {
				return nil, nil, workflowBad("图片生成配方无法读取")
			}
			count, _ := strconv.Atoi(generationInput.Config.Count)
			profile := modelcatalog.DefaultImageCapabilityConfig(generationInput.Config.InterfaceType, generationInput.Config.Model)
			if generationInput.Config.CapabilityConfig != nil && generationInput.Config.CapabilityConfig.Image != nil {
				profile = generationInput.Config.CapabilityConfig.Image
			}
			recipe.OutputCount = max(outputCount, count, profile.FixedOutputs)
			if recipe.OutputCount > 1 {
				for _, edge := range d.Edges {
					if edge.From == n.ID && nodes[edge.To].OperationID != "image.select" {
						return nil, nil, workflowBad("多张生成图片请先连接「选择图片结果」，再连接处理步骤")
					}
				}
			}
		}
		if n.VideoDurationSourceNodeID != "" {
			config, _ := input["config"].(map[string]any)
			if config["videoSeconds"] == nil {
				return nil, nil, workflowBad("节点 " + n.Title + " 的来源模型未声明时长参数，不能跟随参考视频")
			}
			recipe.VideoDurationSourceNodeID = n.VideoDurationSourceNodeID
		}
		parameterEdited := modelEdited
		promptEdited := false
		for _, key := range []string{"prompt", "size", "quality", "vquality", "videoSeconds", "seed"} {
			if value, ok := n.Config[key]; ok {
				if key == "prompt" {
					oldPrompt, _ := input["prompt"].(string)
					if oldPrompt == "" {
						oldPrompt = task.Prompt
					}
					if oldPrompt != value {
						parameterEdited = true
						promptEdited = true
					}
					input[key] = value
					recipe.Request.Prompt = value.(string)
				} else {
					config, _ := input["config"].(map[string]any)
					if config == nil {
						return nil, nil, workflowBad("生成步骤缺少模型配置")
					}
					if fmt.Sprint(config[key]) != fmt.Sprint(value) {
						parameterEdited = true
					}
					if _, ok := config[key].(string); ok {
						config[key] = fmt.Sprint(value)
					} else {
						config[key] = value
					}
				}
			}
		}
		if recipe.ChannelID == "" {
			recipe.ChannelID, e = s.canvasWorkflowChannelID(input, recipe.Request.LogicalModelID)
			if e != nil {
				return nil, nil, e
			}
		}
		for _, field := range []string{"referenceImages", "referenceVideos", "referenceAudios"} {
			items, _ := input[field].([]any)
			for index, item := range items {
				id := workflowReferenceID(item)
				if id == "" {
					// Empty slots are private placeholders created by this compiler,
					// never references supplied by an untrusted source task.
					bound := false
					if reusing {
						for _, binding := range previous[n.ID].Bindings {
							bound = bound || binding.Field == field && binding.Index == index
						}
					}
					if bound {
						continue
					}
					return nil, nil, workflowBad("原任务包含无法持久引用的素材，请重新上传保存后运行")
				}
				if _, e = s.workflowResource(user, id, ""); e != nil {
					return nil, nil, e
				}
				refs[id] = true
			}
		}
		referencesEdited := false
		for _, edge := range d.Edges {
			if edge.To != n.ID {
				continue
			}
			source := nodes[edge.From]
			if source.MediaType == "text" {
				prompt, _ := input["prompt"].(string)
				if strings.Contains(prompt, workflowNodeMentionToken(source.ID)) {
					continue // All explicit occurrences are bound below by node identity.
				}
				anchor := source.Text
				if reusing && !promptEdited {
					for _, binding := range previous[n.ID].Bindings {
						if binding.NodeID == source.ID && binding.Field == "prompt" {
							anchor = binding.Original
							break
						}
					}
				}
				// Explicit empty text inputs bind the entire prompt, without stale offsets.
				if source.Text == "" && edge.ToPort == "prompt" {
					prompt, _ := input["prompt"].(string)
					if prompt == "" {
						prompt = recipe.Request.Prompt
						input["prompt"] = prompt
					}
					recipe.Bindings = append(recipe.Bindings, workflowBinding{NodeID: source.ID, Field: "prompt", Index: 0, Original: prompt})
					continue
				}
				if strings.TrimSpace(anchor) == "" {
					return nil, nil, workflowBad("文本输入 " + source.Title + " 缺少原文，无法定位提示词")
				}
				prompt, _ = input["prompt"].(string)
				if prompt == "" {
					prompt = task.Prompt
					input["prompt"] = prompt
				}
				if strings.Count(prompt, anchor) != 1 {
					return nil, nil, workflowBad("文本 " + source.Title + " 必须在原提示词中唯一匹配，请调整连线或文本")
				}
				recipe.Bindings = append(recipe.Bindings, workflowBinding{NodeID: source.ID, Field: "prompt", Index: strings.Index(prompt, anchor), Original: anchor})
				continue
			}
			field := workflowMediaField(source.MediaType)
			items, _ := input[field].([]any)
			if edge.ToPort != "" {
				if edge.ToPort != field || edge.Order < 0 || edge.Order >= len(items)+len(d.Edges) {
					return nil, nil, workflowBad("「" + n.Title + "」的素材连接位置无效，请重新连接")
				}
				if edge.Order >= len(items) {
					// The editor can add references absent from the original run.
					// Runtime replaces every bound slot with an owned, ready resource.
					for len(items) <= edge.Order {
						items = append(items, map[string]any{"type": source.MediaType})
					}
					input[field] = items
					referencesEdited = true
				}
				recipe.Bindings = append(recipe.Bindings, workflowBinding{NodeID: source.ID, Field: field, Index: edge.Order})
				continue
			}
			matches := 0
			for index, item := range items {
				if source.ResourceID != "" && workflowReferenceID(item) == source.ResourceID {
					matches++
					recipe.Bindings = append(recipe.Bindings, workflowBinding{NodeID: source.ID, Field: field, Index: index})
				}
			}
			if matches != 1 {
				return nil, nil, workflowBad("无法将 " + source.Title + " 唯一映射到 " + n.Title + " 的原参考素材，请先用此素材手动运行目标节点")
			}
		}
		// Remove abandoned placeholders and keep provider reference numbering dense.
		// Original fixed references retain their position relative to surviving slots.
		for _, field := range []string{"referenceImages", "referenceVideos", "referenceAudios"} {
			items, _ := input[field].([]any)
			kept := make([]any, 0, len(items))
			for index, item := range items {
				bound := false
				for _, binding := range recipe.Bindings {
					bound = bound || binding.Field == field && binding.Index == index
				}
				previouslyBound := false
				if reusing {
					for _, binding := range previous[n.ID].Bindings {
						previouslyBound = previouslyBound || binding.Field == field && binding.Index == index
					}
				}
				if !bound && (workflowReferenceID(item) == "" || previouslyBound) {
					referencesEdited = true
					continue
				}
				for i := range recipe.Bindings {
					if recipe.Bindings[i].Field == field && recipe.Bindings[i].Index == index {
						recipe.Bindings[i].Index = len(kept)
					}
				}
				kept = append(kept, item)
			}
			if len(items) > 0 {
				input[field] = kept
			}
		}
		if referencesEdited || parameterEdited {
			// Check supported types/counts now; actual duration, geometry and
			// ownership are checked again when runtime inputs are materialized.
			var taskInput canvasGenerationInput
			encoded, err := json.Marshal(input)
			if err != nil || json.Unmarshal(encoded, &taskInput) != nil {
				return nil, nil, workflowBad("生成配方的素材配置无效")
			}
			if isWorkflowProviderInterface(taskInput.Config.InterfaceType) {
				if referencesEdited {
					return nil, nil, workflowBad("「" + n.Title + "」使用固定的渠道工作流，请先在画布添加素材并成功运行后重新导入")
				}
				if err := s.ValidateTaskCapability(input); err != nil {
					return nil, nil, workflowBad("「" + n.Title + "」的模型参数无效：" + err.Error())
				}
			} else {
				if referencesEdited && (taskInput.Mode != "image" && taskInput.Mode != "video" || taskInput.Mode == "image" && (len(taskInput.ReferenceVideos) > 0 || len(taskInput.ReferenceAudios) > 0)) {
					return nil, nil, workflowBad("「" + n.Title + "」不支持新增这类参考素材，请使用对应的生成步骤")
				}
				shape := taskInputFromCanvas(taskInput)
				shape.DeferReferenceMetadata = true
				validated, err := modelcatalog.ValidateConfiguredTask(shape, s.channelModelLookup())
				if err != nil {
					return nil, nil, workflowBad("「" + n.Title + "」的模型或素材配置无效：" + err.Error())
				}
				if config, ok := input["config"].(map[string]any); ok {
					config["vquality"] = validated.Config.VQuality
				}
			}
		}
		prompt, _ := input["prompt"].(string)
		if prompt == "" {
			prompt = recipe.Request.Prompt
			input["prompt"] = prompt
		}
		mentions, err := workflowNodePromptBindings(prompt, recipe.Bindings, nodes, d.Edges, n.ID)
		if err != nil {
			return nil, nil, err
		}
		recipe.Bindings = append(recipe.Bindings, mentions...)
		// Two connected nodes must never compete for the same original slot.
		bound := map[string]bool{}
		for _, b := range recipe.Bindings {
			if workflowPromptBinding(b.Field) {
				for _, other := range recipe.Bindings {
					if workflowPromptBinding(other.Field) && other.NodeID != b.NodeID && b.Index < other.Index+len(other.Original) && other.Index < b.Index+len(b.Original) {
						return nil, nil, workflowBad("文本输入片段互相重叠，请连接独立的提示词片段")
					}
				}
			}
			key := fmt.Sprintf("%s:%d:%s", b.Field, b.Index, b.Original)
			if bound[key] {
				return nil, nil, workflowBad("多个输入映射到了同一素材槽位，请移除重复连线")
			}
			bound[key] = true
		}
		recipes[n.ID] = recipe
	}
	return recipes, refs, nil
}

func workflowResourceIDs(value any) map[string]bool {
	ids := map[string]bool{}
	var visit func(any)
	visit = func(value any) {
		switch item := value.(type) {
		case map[string]any:
			if id := workflowReferenceID(item); id != "" {
				ids[id] = true
			}
			for _, child := range item {
				visit(child)
			}
		case []any:
			for _, child := range item {
				visit(child)
			}
		}
	}
	visit(value)
	return ids
}

func (s *Service) materializeCanvasWorkflowRequest(user, operation string, recipe workflowRecipe, nodes map[string]cw.Node, steps map[string]*cw.Step) (CreateTaskRequest, error) {
	var req CreateTaskRequest
	encoded, err := json.Marshal(recipe.Request)
	if err != nil {
		return req, err
	}
	if err = json.Unmarshal(encoded, &req); err != nil {
		return req, err
	}
	if req.Input == nil {
		return req, workflowBad("生成配方输入缺失")
	}
	if err = s.refreshCanvasWorkflowCredentials(req.Input, recipe.ChannelID); err != nil {
		return req, err
	}
	metadata, _ := req.Input["metadata"].(map[string]any)
	if metadata == nil {
		metadata = map[string]any{}
		req.Input["metadata"] = metadata
	}
	metadata["source"] = "canvas-workflow"
	metadata["clientOperationId"] = operation
	bindings := append([]workflowBinding(nil), recipe.Bindings...)
	// Render all substitutions against original offsets. New user text may
	// contain another variable's old text without becoming a second replacement.
	sort.SliceStable(bindings, func(i, j int) bool { return bindings[i].Index > bindings[j].Index })
	for _, binding := range bindings {
		value := steps[binding.NodeID]
		if value == nil || value.Status != "succeeded" {
			return req, workflowBad("执行步骤的输入尚未就绪")
		}
		if workflowPromptBinding(binding.Field) {
			prompt, _ := req.Input["prompt"].(string)
			end := binding.Index + len(binding.Original)
			if binding.Index < 0 || end > len(prompt) || prompt[binding.Index:end] != binding.Original {
				return req, workflowBad("提示词变量位置失效，请重新保存工作流")
			}
			replacement := value.Text
			if binding.Field == "promptMention" {
				replacement = binding.ReferenceLabel
			}
			req.Input["prompt"] = prompt[:binding.Index] + replacement + prompt[end:]
			req.Prompt = req.Input["prompt"].(string)
			continue
		}
		resource, err := s.workflowResource(user, value.ResourceID, nodes[binding.NodeID].MediaType)
		if err != nil {
			return req, err
		}
		items, _ := req.Input[binding.Field].([]any)
		if binding.Index < 0 || binding.Index >= len(items) {
			return req, workflowBad("素材槽位缺失")
		}
		item, _ := items[binding.Index].(map[string]any)
		if item == nil {
			return req, workflowBad("原参考素材槽位格式无效，请重新保存工作流")
		}
		oldResourceID := workflowReferenceID(item)
		if logicalID, _ := item["id"].(string); logicalID == "" || logicalID == oldResourceID || strings.HasPrefix(logicalID, "resource:") || assets.IDFromFileURL(logicalID) != "" {
			item["id"] = resource.ID
		}
		delete(item, "url")
		delete(item, "dataUrl")
		if _, ok := item["resourceId"]; ok {
			item["resourceId"] = resource.ID
		}
		item["type"] = nodes[binding.NodeID].MediaType
		item["storageKey"] = "resource:" + resource.ID
		item["mimeType"] = resource.MimeType
		item["bytes"] = resource.Size
		item["width"] = resource.Width
		item["height"] = resource.Height
		item["durationMs"] = resource.DurationMs
		items[binding.Index] = item
		req.Input[binding.Field] = items
	}
	if id := recipe.VideoDurationSourceNodeID; id != "" {
		value := steps[id]
		if value == nil || value.Status != "succeeded" || nodes[id].MediaType != "video" {
			return req, workflowBad("时长参考视频尚未就绪")
		}
		resource, err := s.workflowResource(user, value.ResourceID, "video")
		if err != nil {
			return req, err
		}
		if resource.DurationMs <= 0 {
			return req, workflowBad("无法读取时长参考视频的有效时长，请更新视频素材信息后重试")
		}
		seconds := resource.DurationMs / 1000
		if resource.DurationMs%1000 != 0 {
			seconds++
		}
		config, _ := req.Input["config"].(map[string]any)
		if config == nil || config["videoSeconds"] == nil {
			return req, workflowBad("生成配方缺少时长参数")
		}
		if _, isString := config["videoSeconds"].(string); isString {
			config["videoSeconds"] = fmt.Sprint(seconds)
		} else {
			config["videoSeconds"] = float64(seconds)
		}
	}
	return req, nil
}

// These are delivery destinations and identities of the original manual run.
// Provider options, frame roles/order, edit operations and prompt template
// variables remain part of the immutable generation recipe.
func cleanCanvasWorkflowBindings(input map[string]any) {
	metadata, _ := input["metadata"].(map[string]any)
	for _, key := range []string{"nodeId", "projectId", "canvasId", "source", "conversationId", "messageId", "clientOperationId", "clientOperationHash", "retryTaskId", "retryOfTaskId", "retryOf", "attemptGroupId", "resumeTaskId", "resumeOf", "providerRequestId", "providerTaskId", "upstreamTaskId", "pollStage", "nextPollAt", "taskId", "generationId", "workflowStepId", "shotId", "operationId", "turnId", "proposalId", "requestId", "traceId", "effectKey", "domainProjectId", "chapterId", "batchIndex", "batchCount"} {
		delete(metadata, key)
		delete(input, key)
	}
}
