package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	localtask "infinite-canvas/backend/internal/task"
)

func (s *Service) taskDomain() *localtask.Service {
	if s.tasks != nil {
		return s.tasks
	}
	s.tasksOnce.Do(func() {
		if s.tasks == nil {
			s.tasks = localtask.NewService(localtask.NewStore(s.repo), s.taskDependencies())
		}
	})
	return s.tasks
}

// TaskService exposes the same domain owner used by internal orchestration.
func (s *Service) TaskService() *localtask.Service { return s.taskDomain() }

func (s *Service) taskDependencies() localtask.Dependencies {
	return localtask.Dependencies{
		BindTranscriptionModel: s.bindTranscriptionModel,
		Catalog:                taskCatalogAdapter{s},
		Secrets:                taskSecretsAdapter{s},
		Media:                  taskMediaAdapter{s},
		Projects:               taskProjectsAdapter{s},
		Policy:                 taskPolicyAdapter{s},
		Persist:                taskPersistAdapter{s},
		Runtime:                taskRuntimeAdapter{s},
		Images:                 taskImagesAdapter{s},
		Failures:               taskFailuresAdapter{},
		TextReplay:             s.TextReplay(),
		Provider:               taskProviderAdapter{s},
		Present:                taskPresenterAdapter{s},
		Logs:                   taskLogAdapter{s},
		Activity:               taskActivityAdapter{s},
		OwnedMedia:             taskOwnedMediaAdapter{s},
		Features:               taskFeaturesAdapter{s},
		NewID:                  newID,
	}
}

func toTaskCreateRequest(req CreateTaskRequest) localtask.CreateRequest {
	out := localtask.CreateRequest{
		ProjectID:      req.ProjectID,
		Type:           req.Type,
		Operation:      req.Operation,
		Prompt:         req.Prompt,
		Provider:       req.Provider,
		Model:          req.Model,
		LogicalModelID: req.LogicalModelID,
		Input:          req.Input,
		TraceID:        req.TraceID,
		RequestID:      req.RequestID,
	}
	return out
}

type taskCatalogAdapter struct{ s *Service }

func (a taskCatalogAdapter) Select(userID string, req localtask.SelectRequest) (localtask.SelectResult, error) {
	input := req.Input
	if config, ok := input["config"].(map[string]any); ok {
		if strings.HasPrefix(strings.TrimSpace(fmt.Sprint(config["model"])), "topaz/upscale/") || config["channelId"] == "fal-topaz-upscale" {
			return localtask.SelectResult{}, BadAuthRequest("Topaz 请使用素材节点的 AI 超分入口")
		}
	}
	config, _ := input["config"].(map[string]any)
	name := stringValue(config["model"])
	if kind := generation.UpscaleMediaType(name); kind != "" {
		if req.Model != name || req.Type != "canvas_"+kind || stringValue(input["mode"]) != kind {
			return localtask.SelectResult{}, BadAuthRequest("超分模型与任务类型不一致")
		}
		managed, err := a.s.upscaleConfig(name)
		if err != nil {
			return localtask.SelectResult{}, err
		}
		if stringValue(config["credentialRef"]) != managedBeefAPIRef || stringValue(config["apiKey"]) != managed.APIKey || stringValue(config["baseUrl"]) != managed.BaseURL {
			return localtask.SelectResult{}, BadAuthRequest("AI 超分需要使用已连接的官方算力账号")
		}
	}
	if modelcatalog.TaskInputUsesWorkflowProvider(input) {
		config, _ := input["config"].(map[string]any)
		if err := a.s.RequireWorkflowPluginForUser(userID, strings.TrimSpace(fmt.Sprint(config["interfaceType"]))); err != nil {
			return localtask.SelectResult{}, err
		}
		return localtask.SelectResult{Input: input, Workflow: true}, nil
	}
	frontendEnabled, err := a.s.FeatureEnabled(FeatureFrontendModels)
	if err != nil {
		return localtask.SelectResult{}, err
	}
	selected, err := modelcatalog.SelectTaskModel(modelcatalog.TaskSelectRequest{
		Input:           input,
		LogicalModelID:  req.LogicalModelID,
		Type:            req.Type,
		Operation:       req.Operation,
		FrontendEnabled: frontendEnabled,
	}, a.s.taskSelectLookup())
	if err != nil {
		return localtask.SelectResult{}, err
	}
	result := localtask.SelectResult{Input: selected.Input}
	if selected.Routed != nil {
		routed := selected.Routed
		result.Binding = &localtask.RouteBinding{
			LogicalModelID:         routed.LogicalModel.ID,
			LogicalModelRevisionID: routed.Revision.ID,
			RouteID:                routed.Route.ID,
			ChannelModelID:         routed.ChannelModel.ID,
			Model:                  routed.LogicalModel.Code,
			Provider:               "managed",
		}
	}
	return result, nil
}

func (a taskCatalogAdapter) PrepareRetry(task *model.Task, input map[string]any) error {
	if err := a.s.prepareLogicalTaskRetry(task, input); err != nil {
		return err
	}
	// RetryTask clears the provider ID and submits again. Poll/download recovery
	// uses a separate path and must not depend on current catalog availability.
	return a.s.validatePortraitTaskQuote(input)
}

func (a taskCatalogAdapter) RequireCustomChannels(input map[string]any) error {
	return a.s.requireCustomChannelsForTaskInput(input)
}

func (a taskCatalogAdapter) ValidateCapability(input map[string]any) error {
	config, _ := input["config"].(map[string]any)
	if generation.UpscaleMediaType(stringValue(config["model"])) != "" {
		raw, err := json.Marshal(input)
		if err != nil {
			return err
		}
		var prepared generation.Input
		if err := json.Unmarshal(raw, &prepared); err != nil {
			return err
		}
		return generation.ValidateUpscaleInput(prepared)
	}
	if err := a.s.ValidateTaskCapability(input); err != nil {
		return err
	}
	return a.s.validatePortraitTaskQuote(input)
}

func (taskCatalogAdapter) HasExecutableVideoConfig(input map[string]any) bool {
	return modelcatalog.HasExecutableVideoConfig(input)
}

type taskSecretsAdapter struct{ s *Service }

func (a taskSecretsAdapter) ResolveManaged(input map[string]any) (map[string]any, error) {
	return a.s.resolveManagedBeefAPISecrets(input)
}

func (a taskSecretsAdapter) Protect(input map[string]any) error {
	return a.s.protectTaskSecrets(input)
}

func (a taskSecretsAdapter) DecryptInputJSON(raw string) (string, error) {
	return a.s.decryptTaskInputJSON(raw)
}

type taskMediaAdapter struct{ s *Service }

func (a taskMediaAdapter) ValidateTransport(userID string, input map[string]any) error {
	raw, err := json.Marshal(input)
	if err != nil {
		return BadAuthRequest("任务输入格式无效")
	}
	var prepared generation.Input
	if err := json.Unmarshal(raw, &prepared); err != nil {
		return BadAuthRequest("任务参数格式无效，请检查模型设置后重新提交")
	}
	if len(prepared.ReferenceImages)+len(prepared.ReferenceVideos)+len(prepared.ReferenceAudios) == 0 && prepared.Mask == nil {
		return nil
	}
	if isWorkflowProviderInterface(prepared.Config.InterfaceType) {
		return nil
	}
	// System selections need their stored endpoint/model. Custom selections
	// already carry these; leave network/DNS validation to execution.
	if prepared.Config.ChannelID != "" || systemChannelIDFromBaseURL(prepared.Config.BaseURL) != "" {
		prepared.Config, err = a.s.resolveProviderConfig(prepared.Config)
		if err != nil {
			return err
		}
	}
	ctx := a.s.bindGenerationRuntime(context.Background(), generation.CallMeta{UserID: userID})
	ctx = withProtocolRegistry(ctx, a.s.protocolRegistry())
	return generation.ValidateMediaTransport(ctx, prepared)
}

func (taskMediaAdapter) ContainsInlineData(input map[string]any) bool {
	return containsInlineMediaDataURL(input)
}

type taskProjectsAdapter struct{ s *Service }

func (a taskProjectsAdapter) EnsureActive(userID, canvasOrProjectID string) error {
	return a.s.ensureTaskProjectActive(userID, canvasOrProjectID)
}

type taskOwnedMediaAdapter struct{ s *Service }

func (a taskOwnedMediaAdapter) Resource(userID, id string) (*model.Resource, error) {
	return a.s.Resource(userID, id)
}

type taskFeaturesAdapter struct{ s *Service }

func (a taskFeaturesAdapter) Require(name string) error {
	return a.s.RequireFeature(name)
}

type taskPolicyAdapter struct{ s *Service }

func (a taskPolicyAdapter) ActiveTaskLimit() (int, error) {
	policy, err := a.s.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return policy.Task.ActiveTaskLimit, nil
}

type taskPersistAdapter struct{ s *Service }

func (a taskPersistAdapter) CreateAdmitted(task *model.Task, limit int) error {
	policy, err := a.s.RuntimePolicy()
	if err != nil {
		return err
	}
	policy.Task.ActiveTaskLimit = limit
	return a.s.createTaskWithinStorageQuota(task, policy)
}

type taskRuntimeAdapter struct{ s *Service }

func (a taskRuntimeAdapter) IsDraining() bool { return a.s.IsDraining() }

func (a taskRuntimeAdapter) StopLocalWait(taskID string) { a.s.cancelActiveTask(taskID) }

func (a taskRuntimeAdapter) Dispatch(fn func()) bool { return a.s.runWorkerTask(fn) }

type taskImagesAdapter struct{ s *Service }

func (a taskImagesAdapter) ValidateRetry(task *model.Task) error {
	return a.s.validateImageTaskRetry(task)
}

type taskFailuresAdapter struct{}

func (taskFailuresAdapter) BlocksRetry(message, stage string) bool {
	return persistedFailureBlocksRetry(message, stage)
}

func (taskFailuresAdapter) IsModeration(message string) bool {
	return isContentModerationFailure(message)
}

func (taskFailuresAdapter) Category(message, stage string) generation.FailureCategory {
	if stage == "submission_unknown" {
		return generation.CategorySubmissionUncertain
	}
	return classifyTaskFailure(errors.New(message)).Category
}

func (taskFailuresAdapter) UserMessage(message string) string {
	return classifyTaskFailure(errors.New(message)).UserMessage()
}

type taskProviderAdapter struct{ s *Service }

func (a taskProviderAdapter) RequestCancel(ctx context.Context, task *model.Task) error {
	return a.s.requestProviderCancellation(ctx, task)
}

type taskPresenterAdapter struct{ s *Service }

func (a taskPresenterAdapter) Task(task model.Task) *model.Task {
	projected := taskForOutput(task)
	a.s.attachTaskDelivery(projected)
	return projected
}

func (a taskPresenterAdapter) Summaries(tasks []model.Task) []localtask.Summary {
	summaries := taskSummariesForOutput(tasks)
	a.s.attachTaskSummaryDeliveries(tasks, summaries)
	return summaries
}

func (taskPresenterAdapter) Logs(logs []model.TaskLog) []model.TaskLog {
	for i := range logs {
		logs[i].Summary = generation.DiagnosticSummary(logs[i].Message)
		if logs[i].Level == "error" && logs[i].Payload != "" {
			logs[i].Summary += "：" + generation.ClassifyText(logs[i].Payload).UserMessage()
		}
		logs[i].Message, logs[i].Payload = "", ""
	}
	return logs
}

type taskLogAdapter struct{ s *Service }

func (a taskLogAdapter) Log(userID, taskID, level, message, payload string) error {
	return a.s.log(userID, taskID, level, message, payload)
}

type taskActivityAdapter struct{ s *Service }

func (a taskActivityAdapter) Record(userID, kind string, n int) {
	a.s.recordActivity(userID, kind, n)
}

func isRetiredAgentOperation(operation string) bool {
	return localtask.IsRetiredAgentOperation(operation)
}

func isRetiredAgentTaskInput(operation string, input map[string]any) bool {
	return localtask.IsRetiredAgentTaskInput(operation, input)
}

func retiredAgentTask(task *model.Task) bool {
	return localtask.RetiredAgentTask(task)
}

func clientOperationHash(req CreateTaskRequest) (string, error) {
	return localtask.ClientOperationHash(toTaskCreateRequest(req))
}

func clientOperationID(input map[string]any) (string, error) {
	return localtask.ClientOperationID(input)
}

func normalizeTaskInput(input map[string]any) (map[string]any, error) {
	return localtask.NormalizeInput(input)
}

func validateTaskType(taskType string) error {
	return localtask.ValidateType(taskType)
}

func (s *Service) validateRetryTaskType(userID string, taskType string, input map[string]any) error {
	return s.taskDomain().ValidateRetryType(userID, taskType, input)
}
