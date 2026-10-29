package app

import (
	"context"
	"encoding/json"
	"math"
	"strings"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/topaz"
)

type MediaUpscaleRequest = topaz.Request

func (s *Service) upscaleConfig(name string) (generation.Config, error) {
	key, base, _, _, err := s.lookupBeefAPICredential()
	if err != nil {
		return generation.Config{}, err
	}
	if key == "" {
		return generation.Config{}, BadAuthRequest("请先连接官方算力账号")
	}
	return generation.Config{BaseURL: base, APIKey: key, Model: name, InterfaceType: "newapi"}, nil
}

func (s *Service) MediaUpscaleCapabilities() map[string]any {
	return map[string]any{"modes": topaz.Modes(), "cloudProcessing": true, "maxVideoDurationMs": 300000}
}

func (s *Service) upscaleInput(ctx context.Context, user string, request topaz.Request) (generation.Input, *model.Resource, error) {
	var input generation.Input
	resource, err := s.EnsureResourceMediaMetadata(ctx, user, request.ResourceID)
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady {
		return input, nil, BadAuthRequest("输入素材不存在或未就绪")
	}
	kind := localasset.NormalizeKind(resource.Kind, resource.MimeType)
	if err := topaz.Validate(request, kind); err != nil {
		return input, nil, BadAuthRequest(err.Error())
	}
	config, err := s.upscaleConfig(topaz.ModelID(request.Model))
	if err != nil {
		return input, nil, err
	}
	format := request.OutputFormat
	if kind == "video" {
		format = ""
	}
	input = generation.Input{Mode: kind, Config: config, Upscale: &generation.UpscaleOptions{Factor: int(request.Scale), OutputFormat: format}}
	media := []generation.Media{{StorageKey: "resource:" + resource.ID, MimeType: resource.MimeType, Width: resource.Width, Height: resource.Height, DurationMs: resource.DurationMs}}
	if kind == "image" {
		input.ReferenceImages = media
	} else {
		input.ReferenceVideos = media
	}
	return input, resource, nil
}

func (s *Service) EstimateMediaUpscale(ctx context.Context, user string, request topaz.Request) (map[string]any, error) {
	input, resource, err := s.upscaleInput(ctx, user, request)
	if err != nil {
		return nil, err
	}
	ctx = s.bindGenerationRuntime(ctx, generation.CallMeta{UserID: user, RequestKind: "estimate"})
	estimate, err := generation.EstimateUpscale(ctx, input)
	if err != nil {
		return nil, BadAuthRequest(generation.ClassifyError(err).UserMessage())
	}
	return map[string]any{"mediaType": input.Mode, "source": map[string]any{"width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs}, "output": map[string]any{"width": int(math.Round(float64(resource.Width) * request.Scale)), "height": int(math.Round(float64(resource.Height) * request.Scale)), "durationMs": resource.DurationMs}, "reservation": estimate.Reservation, "currency": estimate.Currency, "generationSubmitted": estimate.GenerationSubmitted, "cloudProcessing": true}, nil
}

func (s *Service) CreateMediaUpscale(ctx context.Context, user string, request topaz.Request) (*model.Task, error) {
	if strings.TrimSpace(request.ClientOperationID) == "" {
		return nil, BadAuthRequest("缺少本次确认的操作 ID")
	}
	input, _, err := s.upscaleInput(ctx, user, request)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	config := payload["config"].(map[string]any)
	config["credentialRef"] = managedBeefAPIRef
	payload["metadata"] = map[string]any{"clientOperationId": request.ClientOperationID, "nodeId": request.NodeID, "source": "canvas", "operation": "media.upscale.topaz"}
	return s.CreateTask(user, CreateTaskRequest{ProjectID: request.ProjectID, Type: "canvas_" + input.Mode, Operation: "media.upscale.topaz", Prompt: "AI 超分", Model: input.Config.Model, Provider: "beefapi", Input: payload})
}

// Recover the accepted original gateway task, or retry only a proven unaccepted
// command. Neither path creates a different local or provider operation ID.
func (s *Service) RecoverMediaUpscale(ctx context.Context, user, id string) (*model.Task, error) {
	task, err := s.repo.TaskForUser(user, id)
	if err != nil {
		return nil, err
	}
	if generation.UpscaleMediaType(task.Model) == "" {
		return nil, BadAuthRequest("此任务不是超分任务")
	}
	if task.Status == model.TaskStatusCancelled {
		return nil, BadAuthRequest("原超分任务已取消，请在任务详情核对结果与扣费状态")
	}
	if task.Status == model.TaskStatusSucceeded {
		if err := s.DeliverSucceededTask(*task); err != nil {
			return nil, err
		}
		return s.Task(user, id)
	}
	if task.Status != model.TaskStatusFailed {
		return taskForOutput(*task), nil
	}
	if task.ProviderRequestID == "" {
		attempt, err := s.repo.LatestRouteAttempt(task.ID)
		if err != nil || (attempt.DispatchState != "not_sent" && attempt.DispatchState != "rejected_no_job") {
			return nil, BadAuthRequest("原超分提交状态尚未确认，请保留任务记录并联系支持查询，暂勿重复提交")
		}
		return s.RetryTask(user, id)
	}
	result, err := s.QueryFailedVideoTask(ctx, user, id)
	if err != nil {
		return nil, err
	}
	if !result.Recovered {
		return nil, BadAuthRequest("原超分任务仍在处理中，请稍后取回原结果")
	}
	return result.Task, nil
}
