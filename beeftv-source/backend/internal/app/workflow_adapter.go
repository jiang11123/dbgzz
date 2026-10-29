package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/provider/workflow"
)

func (s *Service) workflowClient(policy *videoPollPolicy) *workflow.Client {
	return &workflow.Client{
		Requests: workflowRequestExecutor{},
		Media:    workflowMediaLoader{},
		Receipt:  workflowReceipt{service: s},
		Progress: workflowProgress{service: s},
		Plugins:  workflowPlugins{service: s},
		Time:     workflowTime{},
		Poller:   workflowVideoPoller{policy: policy},
	}
}

func workflowConfigFromProvider(config providerConfig) workflow.Config {
	return workflow.Config{
		InterfaceType:         config.InterfaceType,
		BaseURL:               config.BaseURL,
		APIKey:                config.APIKey,
		Headers:               config.Headers,
		Model:                 config.Model,
		Size:                  config.Size,
		Quality:               config.Quality,
		TransparentBackground: config.TransparentBackground,
		Count:                 config.Count,
		VideoSeconds:          config.VideoSeconds,
		VQuality:              config.VQuality,
		VideoGenerateAudio:    config.VideoGenerateAudio,
		VideoWatermark:        config.VideoWatermark,
		AudioVoice:            config.AudioVoice,
		AudioFormat:           config.AudioFormat,
		AudioSpeed:            config.AudioSpeed,
		AudioInstructions:     config.AudioInstructions,
		SystemPrompt:          config.SystemPrompt,
		WorkflowID:            config.WorkflowID,
		WebappID:              config.WebappID,
		WorkflowJSON:          config.WorkflowJSON,
		WorkflowFields:        config.WorkflowFields,
		RunningHubUploadKey:   config.RunningHubUploadKey,
	}
}

func (s *Service) workflowInputFromCanvas(ctx context.Context, input canvasGenerationInput) workflow.Input {
	converted := workflow.Input{
		Mode:             input.Mode,
		Prompt:           input.Prompt,
		Config:           workflowConfigFromProvider(input.Config),
		ReferenceImages:  workflowMediaList(input.ReferenceImages),
		ReferenceVideos:  workflowMediaList(input.ReferenceVideos),
		ReferenceAudios:  workflowMediaList(input.ReferenceAudios),
		ResumedRequestID: resumedProviderRequestID(ctx),
		LocalWorkspace:   s.IsLocalMode(),
	}
	if input.Mask != nil {
		media := workflowMedia(*input.Mask)
		converted.Mask = &media
	}
	return converted
}

func workflowMediaList(items []providerMedia) []workflow.Media {
	if items == nil {
		return nil
	}
	result := make([]workflow.Media, len(items))
	for i, item := range items {
		result[i] = workflowMedia(item)
	}
	return result
}

func workflowMedia(media providerMedia) workflow.Media {
	return workflow.Media{
		ID:       media.ID,
		Name:     media.Name,
		Type:     media.Type,
		DataURL:  media.DataURL,
		URL:      media.URL,
		MimeType: media.MimeType,
	}
}

func toWorkflowPollPolicy(policy videoPollPolicy) workflow.PollPolicy {
	return workflow.PollPolicy{
		InitialDelay:          policy.InitialDelay,
		Interval:              policy.Interval,
		MaxNotFoundMisses:     policy.MaxNotFoundMisses,
		MaxMalformedResponses: policy.MaxMalformedResponses,
		MaxDownloadTries:      policy.MaxDownloadTries,
		RetryTransient:        policy.RetryTransient,
	}
}

type workflowRequestExecutor struct{}

func (workflowRequestExecutor) Execute(ctx context.Context, req workflow.Request) ([]byte, string, error) {
	if req.Kind != "" {
		ctx = withProviderRequestKind(ctx, req.Kind)
	}
	var body *bytes.Reader
	if len(req.Body) > 0 {
		body = bytes.NewReader(req.Body)
	} else {
		body = bytes.NewReader(nil)
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, body)
	if err != nil {
		return nil, "", err
	}
	if req.ContentType != "" {
		httpReq.Header.Set("Content-Type", req.ContentType)
	}
	ApplyOutboundHeaders(httpReq, req.Headers)
	data, mimeType, err := doBinary(httpReq)
	if err != nil {
		var httpErr providerHTTPError
		if errors.As(err, &httpErr) {
			return nil, "", workflow.StatusError{StatusCode: httpErr.StatusCode, Body: httpErr.Body, Err: err}
		}
		return nil, "", err
	}
	return data, mimeType, nil
}

type workflowMediaLoader struct{}

func (workflowMediaLoader) LocalBytes(media workflow.Media) ([]byte, string, error) {
	return mediaBytes(providerMedia{
		ID:       media.ID,
		Name:     media.Name,
		Type:     media.Type,
		DataURL:  media.DataURL,
		URL:      media.URL,
		MimeType: media.MimeType,
	})
}

type workflowReceipt struct{ service *Service }

func (r workflowReceipt) Ready(ctx context.Context) error {
	if r.service == nil {
		return errors.New("工作流缺少受理回执端口")
	}
	if r.service.repo == nil {
		return errors.New("工作流缺少本地任务回执上下文")
	}
	metadata, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	taskID := strings.TrimSpace(metadata.TaskID)
	userID := strings.TrimSpace(metadata.UserID)
	if !ok || taskID == "" || userID == "" {
		return errors.New("工作流缺少本地任务回执上下文")
	}
	if _, err := r.service.repo.TaskForUser(userID, taskID); err != nil {
		return fmt.Errorf("工作流缺少本地任务回执上下文：%w", err)
	}
	return nil
}

func (r workflowReceipt) RecordAccepted(ctx context.Context, requestID, stage string, nextPollAt *time.Time) error {
	if r.service == nil {
		return errors.New("工作流缺少受理回执端口")
	}
	return r.service.recordWorkflowProviderRequest(ctx, requestID, stage, nextPollAt)
}

func (r workflowReceipt) UpdateStage(ctx context.Context, requestID, stage string, nextPollAt *time.Time) error {
	if r.service == nil {
		return errors.New("工作流缺少受理回执端口")
	}
	return r.service.updateWorkflowProviderState(ctx, requestID, stage, nextPollAt)
}

type workflowProgress struct{ service *Service }

func (p workflowProgress) Log(ctx context.Context, level, message, payload string) {
	if p.service == nil {
		return
	}
	metadata, _ := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	_ = p.service.log(metadata.UserID, metadata.TaskID, level, message, payload)
}

type workflowPlugins struct{ service *Service }

func (p workflowPlugins) EnsureEnabled(_ context.Context, interfaceType string) error {
	if p.service == nil {
		return errors.New("工作流缺少插件授权端口")
	}
	return p.service.RequireWorkflowPluginForInterface(interfaceType)
}

type workflowTime struct{}

func (workflowTime) Now() time.Time { return time.Now() }

func (workflowTime) Sleep(ctx context.Context, d time.Duration) error {
	return sleepContext(ctx, d)
}

func (workflowTime) PollDeadline(ctx context.Context) time.Time {
	return providerPollingDeadline(ctx)
}

func (workflowTime) LegacyPollInterval() time.Duration { return 2500 * time.Millisecond }

// workflowVideoPoller maps domain PollPolicy onto app videoPollPolicy.
// Sleep/Notify/transient retry stay in provider_video_polling.go until the
// provider worker owns that type.
type workflowVideoPoller struct {
	policy *videoPollPolicy
}

func (p workflowVideoPoller) appPolicy(policy workflow.PollPolicy) videoPollPolicy {
	appPolicy := defaultVideoPollPolicy()
	if p.policy != nil {
		appPolicy = *p.policy
	}
	if policy.InitialDelay > 0 {
		appPolicy.InitialDelay = policy.InitialDelay
	}
	if policy.Interval > 0 {
		appPolicy.Interval = policy.Interval
	}
	if policy.MaxNotFoundMisses > 0 {
		appPolicy.MaxNotFoundMisses = policy.MaxNotFoundMisses
	}
	if policy.MaxMalformedResponses > 0 {
		appPolicy.MaxMalformedResponses = policy.MaxMalformedResponses
	}
	if policy.MaxDownloadTries > 0 {
		appPolicy.MaxDownloadTries = policy.MaxDownloadTries
	}
	if policy.RetryTransient {
		appPolicy.RetryTransient = true
	}
	return appPolicy
}

func (p workflowVideoPoller) Poll(ctx context.Context, taskID string, policy workflow.PollPolicy, query func(context.Context) (workflow.PollOutcome, error)) (map[string]interface{}, error) {
	return runVideoPollLoop(ctx, taskID, p.appPolicy(policy), func(ctx context.Context) (videoPollOutcome, error) {
		out, err := query(ctx)
		return videoPollOutcome{Done: out.Done, Result: out.Result}, err
	})
}

func (p workflowVideoPoller) Download(ctx context.Context, taskID string, policy workflow.PollPolicy, source workflow.BinarySource, renew func(context.Context) (workflow.BinarySource, error)) ([]byte, string, error) {
	var resolve func(context.Context) (generation.VideoResultSource, error)
	if renew != nil {
		resolve = func(ctx context.Context) (generation.VideoResultSource, error) {
			fresh, err := renew(ctx)
			var pending workflow.StatusError
			if errors.As(err, &pending) && pending.Err == nil {
				err = providerHTTPError{StatusCode: pending.StatusCode, Body: pending.Body}
			}
			return generation.VideoResultSource{URL: fresh.URL, Read: fresh.Read, CredentialValues: fresh.CredentialValues}, err
		}
	}
	download := generation.VideoResultDownloader(providerConfig{BaseURL: source.ProviderURL}, taskID, generation.VideoResultSource{URL: source.URL, Read: source.Read, CredentialValues: source.CredentialValues}, resolve)
	data, mimeType, err := runVideoDownload(ctx, taskID, p.appPolicy(policy), download)
	return data, generation.NormalizedMediaMIMEType(mimeType, data), err
}
