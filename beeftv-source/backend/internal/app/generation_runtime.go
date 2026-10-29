package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
)

type appResourcePort struct{ service *Service }

func (p appResourcePort) EnsureMetadata(ctx context.Context, userID, resourceID string) (generation.ResourceInfo, error) {
	resource, err := p.service.resourceDomain().EnsureMediaMetadata(ctx, userID, resourceID)
	if err != nil {
		return generation.ResourceInfo{}, err
	}
	return resourceInfoFromModel(userID, resource), nil
}

func (p appResourcePort) Lookup(userID, resourceID string) (generation.ResourceInfo, error) {
	resource, err := p.service.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return generation.ResourceInfo{}, err
	}
	return resourceInfoFromModel(userID, resource), nil
}

func (p appResourcePort) Open(userID, resourceID string) (generation.ResourceInfo, io.ReadCloser, error) {
	resource, body, err := p.service.OpenResource(userID, resourceID)
	if err != nil {
		return generation.ResourceInfo{}, nil, err
	}
	return resourceInfoFromModel(userID, resource), body, nil
}

func (p appResourcePort) PublicURL(info generation.ResourceInfo, expiresAt time.Time) (string, error) {
	resource, err := p.service.repo.ResourceForUser(info.UserID, info.ID)
	if err != nil {
		return "", err
	}
	return p.service.directResourceURL(resource, expiresAt)
}

func (p appResourcePort) HTTPSPublicURL(info generation.ResourceInfo, expiresAt time.Time) (string, error) {
	resource, err := p.service.repo.ResourceForUser(info.UserID, info.ID)
	if err != nil {
		return "", err
	}
	return p.service.signedHTTPSPublicResourceURL(resource, expiresAt)
}

func (p appResourcePort) LocalMode() bool {
	return p.service != nil && p.service.IsLocalMode()
}

type appLimitsPort struct{ service *Service }

func (p appLimitsPort) GeneratedFileBytes(ctx context.Context) (int64, error) {
	policy, err := p.service.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return megabytes(policy.Resource.GeneratedFileMB), nil
}

func (p appLimitsPort) ResourceUploadBytes(ctx context.Context) (int64, error) {
	policy, err := p.service.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return megabytes(policy.Resource.ResourceUploadMB), nil
}

func (p appLimitsPort) CircuitOpen(ctx context.Context, channelID string) (bool, error) {
	if p.service == nil || p.service.coordinator == nil {
		return false, nil
	}
	return p.service.coordinator.CircuitOpen(ctx, channelID)
}

func (p appLimitsPort) AcquireChannelSlot(ctx context.Context, channelID, slotID string, timeout time.Duration) (func(), int, error) {
	return p.service.AcquireChannelSlot(ctx, channelID, slotID, timeout)
}

func (p appLimitsPort) RecordChannelResult(ctx context.Context, channelID string, failure bool) error {
	return p.service.RecordChannelResult(ctx, channelID, failure)
}

type appReceiptPort struct{ service *Service }

type appTaskStagePort struct {
	service *Service
	task    model.Task
}

func (p appTaskStagePort) SetStage(ctx context.Context, stage string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	err := p.service.repo.WithContext(ctx).UpdateTaskStageForLease(p.task.ID, p.task.LeaseOwner, stage)
	if err == nil && stage == "正在取回生成结果" {
		p.service.logTaskPhase(p.task.ID, "result_transfer_start")
	}
	return err
}

// appTaskDeliveryPort mirrors in-generation result downloads into the same
// task delivery projection that post-success artifact delivery uses.
type appTaskDeliveryPort struct {
	service *Service
	taskID  string
}

type appTaskDownloadCachePort struct {
	service        *Service
	userID, taskID string
}

func (p appTaskDownloadCachePort) PartialPath() string {
	return (generationDeliveryMediaAdapter{service: p.service}).artifactDownloadPartialPath(p.userID, p.taskID+":provider")
}

func (p appTaskDeliveryPort) ReportDelivery(progress outbound.ResumableProgress) {
	taskID := strings.TrimSpace(p.taskID)
	if p.service == nil || taskID == "" {
		return
	}
	identity := taskID + ":0"
	p.service.deliveryProgressRegistry().record(identity, deliveryProgressFromOutbound(identity, progress))
}

func (p appTaskDeliveryPort) ClearDelivery() {
	taskID := strings.TrimSpace(p.taskID)
	if p.service == nil || taskID == "" {
		return
	}
	p.service.deliveryProgressRegistry().clear(taskID + ":0")
	p.service.logTaskPhase(taskID, "result_transfer_end")
}

// Store only phase boundaries in the existing task log, never URLs or bytes.
// Transfer end includes a failed attempt; terminal task status owns success.
func (s *Service) logTaskPhase(taskID, phase string) {
	if s.repo == nil {
		return
	}
	task, err := s.repo.Task(taskID)
	if err != nil || task == nil {
		return
	}
	payload, _ := json.Marshal(map[string]string{"phase": phase})
	message := "开始取回生成结果"
	if phase == "result_transfer_end" {
		message = "取回生成结果阶段结束"
	}
	_ = s.log(task.UserID, task.ID, "info", message, string(payload))
}

func (p appReceiptPort) Observe(observation generation.TransportObservation) {
	if observation.Request == nil {
		return
	}
	evidence := model.TaskRequestEvidence{
		StartedAt:             observation.StartedAt.Format(time.RFC3339Nano),
		ResponseLimitBytes:    observation.ResponseLimitBytes,
		Dispatched:            observation.Dispatched,
		TransportPhase:        observation.TransportPhase,
		TransportRoute:        observation.TransportRoute,
		HTTPStatus:            observation.HTTPStatus,
		DeclaredResponseBytes: observation.DeclaredResponseBytes,
		ReceivedBytes:         observation.ReceivedBytes,
		RequestID:             observation.RequestID,
		Outcome:               observation.Outcome,
	}
	recordTaskRequestEvidence(observation.Request, evidence, observation.Body, observation.Err)
	recordProviderRequest(p.service, observation.Request, observation.StartedAt, observation.StatusCode, observation.Body, observation.Err)
}

func (p appReceiptPort) NotifyPoll(ctx context.Context, event string, err error) {
	if p.service == nil || p.service.repo == nil {
		return
	}
	call := canonicalCallMeta(ctx)
	if strings.TrimSpace(call.TaskID) == "" {
		return
	}
	message := "上游视频查询暂时异常，将继续轮询原任务"
	level := "warn"
	payload := ""
	if err != nil {
		payload = err.Error()
	}
	if videoPollEvent(event) == videoPollEventRecovered {
		message = "上游视频查询已恢复"
		level = "info"
	}
	_ = p.service.log(call.UserID, call.TaskID, level, message, payload)
}

func (p appReceiptPort) SyncProgress(taskID string, body []byte) {
	if p.service == nil {
		return
	}
	p.service.syncProviderTaskProgress(taskID, body)
}

type appImagePort struct{ service *Service }

func (p appImagePort) Intercept(req *http.Request) (bool, []byte, string, error) {
	if !generation.RecoverableImageEndpoint(req) {
		return false, nil, "", nil
	}
	if p.service == nil {
		return true, nil, "", imagePreparationError{generation.ErrImageOwnerMissing}
	}
	row, handled, err := prepareImageSubmission(p.service, req)
	if err != nil {
		return true, nil, "", imagePreparationError{err}
	}
	if !handled {
		data, mimeType, sendErr := generation.DoBinaryWithConsumer(req, nil)
		return true, data, mimeType, sendErr
	}
	task := req.Context().Value(imageTaskContext{}).(model.Task)
	data, mimeType, sendErr := p.service.sendImageSubmission(req.Context(), task, row)
	return true, data, mimeType, sendErr
}

type appPromptPort struct{ service *Service }

func (p appPromptPort) Compile(userID, operation string, values map[string]string) (string, error) {
	if p.service == nil {
		return "", errors.New("编译用户提示词失败：提示词端口未接入")
	}
	compiled, err := p.service.compilePrompt(userID, operation, values)
	if err != nil {
		return "", err
	}
	return compiled.Content, nil
}

func (p appPromptPort) ValidateResult(operation string, result map[string]any) error {
	return validatePromptTemplateResult(operation, result)
}

type appConfigPort struct{ service *Service }

func (p appConfigPort) Resolve(config generation.Config) (generation.Config, error) {
	if p.service == nil {
		return generation.Config{}, errors.New("无法解析系统渠道配置")
	}
	return p.service.resolveProviderConfig(config)
}

func (p appConfigPort) ApplyCapabilities(ctx context.Context, input *generation.Input) error {
	if p.service == nil || input == nil {
		return nil
	}
	switch input.Mode {
	case "image":
		return p.service.validateResolvedImageCapability(input)
	case "video":
		if isBeefAPISeedancePreuploadConfig(ctx, input.Config) {
			if err := p.service.resolveVideoCapability(ctx, input); err != nil {
				return err
			}
			if input.VideoCapability != nil {
				return validateVideoTaskParameters(input.VideoCapability, *input)
			}
			return nil
		}
		return p.service.validateResolvedVideoCapabilityContext(ctx, input)
	default:
		return nil
	}
}

func (p appConfigPort) RequireWorkflow(interfaceType string) error {
	if p.service == nil {
		return errors.New("无法执行工作流任务，请重试")
	}
	return p.service.RequireWorkflowPluginForInterface(interfaceType)
}

func (p appConfigPort) SyncArkPrivateAssets(ctx context.Context, userID string, input *generation.Input) error {
	if p.service == nil || input == nil {
		return nil
	}
	return p.service.prepareArkPrivateAssetReferences(ctx, userID, input)
}

type appStylePort struct{ service *Service }

func (p appStylePort) Apply(userID, projectID string, input *generation.Input) error {
	if p.service == nil {
		return errors.New("项目画风执行配置无效：画风端口未接入")
	}
	return p.service.applyGenerationStyleProfile(userID, projectID, input)
}

type appWorkflowPort struct{ service *Service }

func (p appWorkflowPort) Execute(ctx context.Context, input generation.Input) (map[string]interface{}, error) {
	return p.service.runWorkflowProviderTask(ctx, input)
}

type appMediaProbe struct{}

func (appMediaProbe) ProbeSeedance2Video(config generation.Config, index int, media *generation.Media, data []byte) error {
	return applySeedance2VideoProbe(config, index, media, data)
}

func resourceInfoFromModel(userID string, resource *model.Resource) generation.ResourceInfo {
	if resource == nil {
		return generation.ResourceInfo{UserID: userID}
	}
	return generation.ResourceInfo{
		UserID:     userID,
		ID:         resource.ID,
		Status:     string(resource.Status),
		Kind:       resource.Kind,
		MimeType:   resource.MimeType,
		Provider:   resource.Provider,
		Size:       resource.Size,
		Width:      resource.Width,
		Height:     resource.Height,
		DurationMs: resource.DurationMs,
	}
}

func (s *Service) bindGenerationRuntime(ctx context.Context, meta generation.CallMeta) context.Context {
	return s.applyGenerationRuntime(ctx, meta, true)
}

func (s *Service) enrichGenerationRuntime(ctx context.Context, meta generation.CallMeta) context.Context {
	return s.applyGenerationRuntime(ctx, meta, false)
}

func (s *Service) applyGenerationRuntime(ctx context.Context, meta generation.CallMeta, replaceCall bool) context.Context {
	if s == nil {
		if replaceCall {
			ctx = generation.WithCallMeta(ctx, meta)
		} else {
			ctx = generation.EnrichCallMeta(ctx, meta)
		}
		return bindRequestReceipts(ctx)
	}
	runtime := generation.Runtime{
		ReferenceStorage: appReferenceStoragePort{service: s},
		Resources:        appResourcePort{service: s},
		Limits:           appLimitsPort{service: s},
		Receipts:         appReceiptPort{service: s},
		Images:           appImagePort{service: s},
		Workflow:         appWorkflowPort{service: s},
		Prompt:           appPromptPort{service: s},
		Config:           appConfigPort{service: s},
		Style:            appStylePort{service: s},
		Probe:            appMediaProbe{},
		Call:             meta,
	}
	if existing, ok := generation.RuntimeFromContext(ctx); ok {
		runtime.Endpoints = existing.Endpoints
		runtime.Stages = existing.Stages
		runtime.Delivery = existing.Delivery
		runtime.ReferenceProgress = existing.ReferenceProgress
		if !replaceCall {
			runtime.Call = generation.IdentityCallMeta(existing.Call, meta)
		}
	}
	if s.dataDir != "" && runtime.Call.UserID != "" && runtime.Call.TaskID != "" {
		runtime.DownloadCache = appTaskDownloadCachePort{service: s, userID: runtime.Call.UserID, taskID: runtime.Call.TaskID}
	}
	return generation.WithRuntime(ctx, runtime)
}

// bindRequestReceipts attaches a receipts port so DoJSON/DoBinary can record
// sanitized HTTP evidence. It never looks up Service from a process map.
// API call logs still require a Service already bound on this runtime.
func bindRequestReceipts(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	runtime, _ := generation.RuntimeFromContext(ctx)
	if runtime.Receipts != nil {
		return ctx
	}
	if metadata, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext); ok {
		if strings.TrimSpace(runtime.Call.UserID) == "" && strings.TrimSpace(runtime.Call.TaskID) == "" {
			runtime.Call = generationCallMeta(metadata)
		}
	}
	// Missing receipts may be intentional (WithoutCallAccounting). Restore only
	// the context diagnostic recorder; never recover accounting authority from
	// unrelated ports. Normal task/admin entrypoints bind their Service explicitly.
	runtime.Receipts = appReceiptPort{}
	return generation.WithRuntime(ctx, runtime)
}

func generationCallMeta(metadata providerAnalyticsContext) generation.CallMeta {
	return generation.CallMeta{
		UserID:            metadata.UserID,
		TaskID:            metadata.TaskID,
		ProjectID:         metadata.ProjectID,
		TaskType:          metadata.TaskType,
		TraceID:           metadata.TraceID,
		RequestID:         metadata.RequestID,
		Capability:        metadata.Capability,
		Operation:         metadata.Operation,
		ChannelID:         metadata.ChannelID,
		Model:             metadata.Model,
		VideoSeconds:      metadata.VideoSeconds,
		RequestKind:       metadata.RequestKind,
		ProviderRequestID: metadata.ProviderRequestID,
		ConcurrencyLimit:  metadata.ConcurrencyLimit,
	}
}
