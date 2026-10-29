package creation

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/repository"
)

var allowedConfigKeys = []string{
	"channelId", "channelModelKey", "model", "variantId", "apiFormat", "interfaceType",
	"size", "quality", "transparentBackground", "count", "videoSeconds", "vquality",
	"videoGenerateAudio", "videoWatermark", "videoArkPrivateAssetUpload", "systemPrompt",
}

func (s *Service) constrainTask(userID string, repo *repository.Repository, req *TaskRequest) error {
	config, _ := req.Input["config"].(map[string]any)
	if req.LogicalModelID == "" && strings.TrimSpace(stringValue(config["channelId"])) == "" {
		return kernel.BadAuthRequest("智能创作目前仅支持后端受管模型，请在原入口使用其他渠道")
	}
	if s.deps.Kinds != nil && (s.deps.Kinds.UsesWorkflow(req.Input) || s.deps.Kinds.UsesTextReplay(req.Input)) {
		return kernel.BadAuthRequest("智能创作不支持本机、工作流或文本回放任务")
	}
	safeConfig := map[string]any{}
	for _, key := range allowedConfigKeys {
		if value, ok := config[key]; ok {
			safeConfig[key] = value
		}
	}
	if req.Input == nil {
		req.Input = map[string]any{}
	}
	req.Input["config"] = safeConfig
	if err := ValidateJSON(req); err != nil {
		return err
	}
	if req.Type != "canvas_text" && req.Type != "text" && req.Type != "canvas_image" && req.Type != "canvas_video" {
		return kernel.BadAuthRequest("智能创作任务类型不受支持")
	}
	expectedMode := map[string]string{"text": "text", "canvas_text": "text", "canvas_image": "image", "canvas_video": "video"}[req.Type]
	if stringValue(req.Input["mode"]) != expectedMode || strings.TrimSpace(stringValue(req.Input["prompt"])) != strings.TrimSpace(req.Prompt) {
		return kernel.BadAuthRequest("任务类型、模式和实际提示词必须一致")
	}
	if expectedMode != "text" && req.Input["agentRequests"] != nil {
		return kernel.BadAuthRequest("媒体任务不允许携带独立模型协议请求")
	}
	if count := stringValue(safeConfig["count"]); count != "" && count != "1" {
		return kernel.BadAuthRequest("每个获批执行项只能生成一个产物")
	}
	if req.Input["mask"] != nil {
		return kernel.BadAuthRequest("本期智能创作暂不支持蒙版任务")
	}
	if expectedMode != "text" {
		if err := validateLiveImageReferences(userID, repo, req); err != nil {
			return err
		}
	}
	return hydrateResourceStats(userID, repo, req.Input)
}

func validateLiveImageReferences(userID string, repo *repository.Repository, req *TaskRequest) error {
	canvas, err := repo.CanvasProjectForUser(userID, req.ProjectID)
	if err != nil {
		return MapError(err)
	}
	doc, err := parseDocument(canvas.PayloadJSON)
	if err != nil {
		return err
	}
	nodes, err := documentObjects(doc["nodes"])
	if err != nil {
		return err
	}
	refs, ok := req.Input["referenceImages"].([]any)
	if !ok {
		return nil
	}
	for _, raw := range refs {
		ref, _ := raw.(map[string]any)
		node := nodes[stringValue(ref["id"])]
		meta, _ := node["metadata"].(map[string]any)
		if node == nil || node["type"] != "image" || meta["status"] != "success" || stringValue(ref["storageKey"]) != stringValue(meta["storageKey"]) {
			return Conflict("参考素材已变化或尚未就绪")
		}
	}
	return nil
}

func hydrateResourceStats(userID string, repo *repository.Repository, input map[string]any) error {
	for _, name := range []string{"referenceImages", "referenceVideos", "referenceAudios"} {
		list, ok := input[name].([]any)
		if !ok {
			continue
		}
		for _, raw := range list {
			media, ok := raw.(map[string]any)
			if !ok {
				return kernel.BadAuthRequest("素材引用格式无效")
			}
			key := stringValue(media["storageKey"])
			if !strings.HasPrefix(key, "resource:") {
				return kernel.BadAuthRequest("请先将参考素材保存到当前账号资源库")
			}
			resource, err := repo.ResourceForUser(userID, strings.TrimPrefix(key, "resource:"))
			if err != nil {
				return MapError(err)
			}
			if resource.Status != model.ResourceStatusReady {
				return kernel.BadAuthRequest("参考素材尚未就绪")
			}
			delete(media, "url")
			delete(media, "dataUrl")
			media["bytes"] = resource.Size
			media["durationMs"] = resource.DurationMs
		}
	}
	return nil
}

func matchResolvedSpec(requested, resolved map[string]any) error {
	for _, key := range []string{"size", "videoSeconds", "vquality", "quality"} {
		want := stringValue(requested[key])
		if want != "" && !strings.EqualFold(want, stringValue(resolved[key])) {
			return Conflict("模型解析后的生成规格与请求不同，请调整方案后重新确认")
		}
	}
	return nil
}

func assertTextReferenceCapacity(repo *repository.Repository, task *model.Task, channelID, modelKey string, imageCount int) error {
	if imageCount == 0 {
		return nil
	}
	queryModel := modelKey
	cm, err := repo.ChannelModelByKey(channelID, queryModel)
	if err != nil {
		return err
	}
	profile, err := modelcatalog.DecodeModelCapabilityConfig(cm.CapabilityConfigJSON)
	if err != nil || profile == nil || profile.Text == nil || profile.Text.References.MaxImages < imageCount {
		return kernel.BadAuthRequest("当前文本模型未配置足够的图片理解能力")
	}
	return nil
}

func executionFor(task *model.Task, signature string) Execution {
	execution := Execution{Model: task.Model, Options: map[string]any{}}
	var input map[string]any
	_ = json.Unmarshal([]byte(task.InputJSON), &input)
	config, _ := input["config"].(map[string]any)
	for _, key := range []string{"size", "videoSeconds", "vquality", "quality", "maxTokens"} {
		if value, ok := config[key]; ok {
			execution.Options[key] = value
		}
	}
	execution.ConfigHash = Hash([]any{signature, execution.Options})
	return execution
}

func checkConfigSignature(repo *repository.Repository, task *model.Task, want string) error {
	var input map[string]any
	_ = json.Unmarshal([]byte(task.InputJSON), &input)
	config, _ := input["config"].(map[string]any)
	got, err := repo.CreationConfigSignature(task, stringValue(config["channelId"]), stringValue(config["model"]))
	if err != nil {
		return err
	}
	if got != want {
		return Conflict("模型执行配置已更新，请重新确认")
	}
	return nil
}
