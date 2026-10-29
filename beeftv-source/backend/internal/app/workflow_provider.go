package app

import (
	"context"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/provider/workflow"
)

// RunningHubWorkflowFetchRequest 只用于独立工作流设置页，不进入 ModelChannel。
type RunningHubWorkflowFetchRequest = workflow.FetchRequest

func isRunningHubInterface(value string) bool {
	pluginID, ok := workflowPluginIDForInterface(value)
	return ok && pluginID == WorkflowPluginRunningHub
}

func isWorkflowProviderInterface(value string) bool {
	return isRunningHubInterface(value)
}

func validateWorkflowProviderConfig(mode string, config providerConfig) error {
	return mapOutboundError(workflow.ValidateConfig(mode, workflowConfigFromProvider(config)))
}

func (s *Service) runWorkflowProviderTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	if isRunningHubInterface(input.Config.InterfaceType) {
		return s.runRunningHubWorkflow(ctx, input)
	}
	return nil, errors.New("未知工作流协议")
}

func (s *Service) updateWorkflowProviderState(ctx context.Context, requestID string, stage string, nextPollAt *time.Time) error {
	metadata, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if !ok || metadata.TaskID == "" {
		return nil
	}
	return s.repo.UpdateTaskProviderState(metadata.TaskID, requestID, stage, nextPollAt)
}

func (s *Service) recordWorkflowProviderRequest(ctx context.Context, requestID string, stage string, nextPollAt *time.Time) error {
	if s == nil || s.repo == nil {
		return errors.New("工作流缺少本地任务回执上下文")
	}
	metadata, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if !ok || strings.TrimSpace(metadata.TaskID) == "" {
		return errors.New("工作流缺少本地任务回执上下文")
	}
	return s.repo.UpdateTaskProviderState(metadata.TaskID, requestID, stage, nextPollAt)
}

func (s *Service) runRunningHubWorkflow(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	converted := s.workflowInputFromCanvas(ctx, input)
	result, err := s.workflowClient(nil).Run(ctx, converted)
	if err != nil {
		return nil, s.fenceWorkflowSubmission(ctx, converted, err)
	}
	return result, nil
}

// fenceWorkflowSubmission maps domain create-path uncertainty onto the current
// app providerSubmissionUnknownError contract. That type may move with the
// provider worker; keep this alias boundary.
func (s *Service) fenceWorkflowSubmission(ctx context.Context, input workflow.Input, err error) error {
	if err == nil {
		return nil
	}
	var accepted workflow.AcceptedNotRecorded
	if errors.As(err, &accepted) {
		if requestID := strings.TrimSpace(accepted.RequestID); requestID != "" {
			_ = s.recordWorkflowProviderRequest(ctx, requestID, firstNonEmpty(strings.TrimSpace(accepted.Stage), "submitted"), nil)
		}
		return providerSubmissionUnknownError{Cause: err}
	}
	if strings.TrimSpace(input.ResumedRequestID) != "" {
		return err
	}
	var uncertain workflow.CreateUncertain
	if !errors.As(err, &uncertain) {
		return err
	}
	mapped := uncertainVideoSubmission(ctx, err)
	var notSent generation.RequestNotSentError
	if errors.As(mapped, &notSent) {
		return mapped
	}
	var unknown providerSubmissionUnknownError
	if errors.As(mapped, &unknown) {
		return mapped
	}
	if errors.Is(mapped, context.Canceled) || safeRouteRejection(mapped) {
		return mapped
	}
	var circuit providerCircuitOpenError
	if errors.As(mapped, &circuit) {
		return mapped
	}
	return providerSubmissionUnknownError{Cause: err}
}

func (s *Service) fetchRunningHubWorkflowJSON(ctx context.Context, root string, config providerConfig, workflowID string) (map[string]interface{}, error) {
	return s.workflowClient(nil).FetchWorkflowJSON(ctx, root, workflowConfigFromProvider(config), workflowID)
}

func (s *Service) uploadRunningHubMedia(ctx context.Context, root string, config providerConfig, media providerMedia) (string, error) {
	return s.workflowClient(nil).UploadMedia(ctx, root, workflowConfigFromProvider(config), workflowMedia(media), s.IsLocalMode())
}

func (s *Service) runningHubJSON(ctx context.Context, config providerConfig, endpoint string, body interface{}, target *map[string]any) error {
	result, err := s.workflowClient(nil).PostJSON(ctx, workflowConfigFromProvider(config), endpoint, "", body)
	if err != nil {
		return err
	}
	if target != nil {
		*target = result
	}
	return nil
}

func (s *Service) pollRunningHubWorkflow(ctx context.Context, config providerConfig, root string, taskID string, mode string) (map[string]interface{}, error) {
	return s.workflowClient(nil).Poll(ctx, workflowConfigFromProvider(config), root, taskID, mode)
}

func (s *Service) pollRunningHubVideoWorkflowWithPolicy(ctx context.Context, config providerConfig, root string, taskID string, policy videoPollPolicy) (map[string]interface{}, error) {
	return s.workflowClient(&policy).PollVideo(ctx, workflowConfigFromProvider(config), root, taskID, toWorkflowPollPolicy(policy))
}

func (s *Service) pollRunningHubWorkflowLegacy(ctx context.Context, config providerConfig, root string, taskID string) (map[string]interface{}, error) {
	return s.workflowClient(nil).Poll(ctx, workflowConfigFromProvider(config), root, taskID, "image")
}

func (s *Service) downloadWorkflowOutputs(ctx context.Context, urls []string) (map[string]interface{}, error) {
	return s.workflowClient(nil).DownloadOutputs(ctx, urls, "", nil)
}

func (s *Service) downloadWorkflowVideoOutputs(ctx context.Context, urls []string, taskID string, policy videoPollPolicy) (map[string]interface{}, error) {
	mapped := toWorkflowPollPolicy(policy)
	return s.workflowClient(&policy).DownloadOutputs(ctx, urls, taskID, &mapped)
}

func runningHubRootURL(value string) string { return workflow.RootURL(value) }

func runningHubAPIKey(config providerConfig) string {
	return workflow.APIKey(workflowConfigFromProvider(config))
}

func runningHubPayloadCode(payload map[string]any) (int, bool) { return workflow.PayloadCode(payload) }

func runningHubFailureMessage(payload map[string]any) string {
	return workflow.FailureMessage(payload)
}
