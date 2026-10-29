package task

import (
	"encoding/json"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/depthcapture"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/transcription"
)

type localExecutorKind struct {
	Type     string
	Prompt   string
	Provider string
	Model    string
	Stage    string
	Progress int
	Log      string
}

func localExecutorSchema(taskType string) (localExecutorKind, error) {
	if err := ValidateLocalExecutorType(taskType); err != nil {
		return localExecutorKind{}, kernel.BadAuthRequest(err.Error())
	}
	switch taskType {
	case model.TaskTypeCanvasMediaTransform:
		return localExecutorKind{Type: taskType, Prompt: "画布媒体处理", Provider: "local", Model: "ffmpeg", Stage: LocalExecutorQueuedStage, Log: "画布媒体处理已进入队列"}, nil
	case model.TaskTypeTimelineRender:
		return localExecutorKind{
			Type:     model.TaskTypeTimelineRender,
			Prompt:   LocalExecutorRenderPrompt,
			Provider: LocalExecutorRenderProvider,
			Model:    LocalExecutorRenderModel,
			Stage:    LocalExecutorQueuedStage,
			Progress: 5,
			Log:      "时间线渲染任务已进入队列",
		}, nil
	case model.TaskTypeTimelineTranscription:
		return localExecutorKind{
			Type:     model.TaskTypeTimelineTranscription,
			Prompt:   LocalExecutorTranscriptionPrompt,
			Provider: LocalExecutorTranscriptionProvider,
			Model:    LocalExecutorTranscriptionModel,
			Stage:    LocalExecutorQueuedStage,
			Progress: 5,
			Log:      "字幕转写任务已进入队列",
		}, nil
	case model.TaskTypeDepthCapture:
		return localExecutorKind{
			Type:     model.TaskTypeDepthCapture,
			Prompt:   depthcapture.Prompt,
			Provider: depthcapture.Provider,
			Model:    depthcapture.ModelID,
			Stage:    depthcapture.InitialStage,
			Progress: 0,
			Log:      "深度动作捕捉任务已进入队列",
		}, nil
	default:
		return localExecutorKind{}, kernel.BadAuthRequest(errUnsupportedLocalExecutor(taskType))
	}
}

func errUnsupportedLocalExecutor(taskType string) string {
	return "不支持的本地执行任务类型：" + taskType
}

type specializedAdmission struct {
	kind      localExecutorKind
	projectID string
	input     map[string]any
	traceID   string
	requestID string
}

func (s *Service) CreateTimelineRenderTask(userID string, req TimelineRenderCreateRequest) (*model.Task, error) {
	kind, err := localExecutorSchema(model.TaskTypeTimelineRender)
	if err != nil {
		return nil, err
	}
	plan, err := editing.Compile(req.Timeline, nil, req.Options)
	if err != nil {
		return nil, kernel.BadAuthRequest(err.Error())
	}
	if !plan.HasMedia() {
		return nil, kernel.BadAuthRequest(NoRenderableMediaMessage)
	}
	input, err := marshalLocalExecutorInput(TimelineRenderInput{
		ProjectID: strings.TrimSpace(req.ProjectID),
		Timeline:  req.Timeline,
		Options:   req.Options,
	})
	if err != nil {
		return nil, err
	}
	return s.admitSpecialized(userID, specializedAdmission{
		kind:      kind,
		projectID: strings.TrimSpace(req.ProjectID),
		input:     withClientOperation(input, req.ClientOperationID),
		traceID:   req.TraceID,
		requestID: req.RequestID,
	})
}

func (s *Service) CreateTimelineTranscriptionTask(userID string, req TimelineTranscriptionCreateRequest) (*model.Task, error) {
	kind, err := localExecutorSchema(model.TaskTypeTimelineTranscription)
	if err != nil {
		return nil, err
	}
	if s.deps.Features == nil {
		return nil, unavailable()
	}
	if err := s.deps.Features.Require(TimelineTranscriptionFeature); err != nil {
		return nil, err
	}
	resourceID := strings.TrimSpace(req.ResourceID)
	if resourceID == "" {
		return nil, kernel.BadAuthRequest(NeedTranscribableMediaMessage)
	}
	if s.deps.OwnedMedia == nil {
		return nil, unavailable()
	}
	resource, err := s.deps.OwnedMedia.Resource(userID, resourceID)
	if err != nil || resource == nil {
		return nil, kernel.BadAuthRequest(MissingTranscribableMediaMessage)
	}
	if !transcription.IsTranscribableMIME(resource.MimeType) {
		return nil, kernel.BadAuthRequest(OnlyAudioVideoTranscriptionMessage)
	}
	managedTokenID := ""
	req.Model = strings.TrimSpace(req.Model)
	if req.Model != "" {
		if s.deps.BindTranscriptionModel == nil {
			return nil, kernel.BadAuthRequest("云端转写暂不可用")
		}
		managedTokenID, err = s.deps.BindTranscriptionModel(req.Model)
		if err != nil {
			return nil, err
		}
	}
	input, err := marshalLocalExecutorInput(TimelineTranscriptionInput{
		Model:          strings.TrimSpace(req.Model),
		ManagedTokenID: managedTokenID,
		ResourceID:     resourceID,
		Language:       strings.TrimSpace(req.Language),
	})
	if req.Model != "" {
		kind.Provider = "beefapi"
		kind.Model = strings.TrimSpace(req.Model)
	}
	if err != nil {
		return nil, err
	}
	return s.admitSpecialized(userID, specializedAdmission{
		kind:      kind,
		projectID: strings.TrimSpace(req.ProjectID),
		input:     withClientOperation(input, req.ClientOperationID),
		traceID:   req.TraceID,
		requestID: req.RequestID,
	})
}

func (s *Service) CreateDepthCaptureTask(userID string, req DepthCaptureCreateRequest) (*model.Task, error) {
	kind, err := localExecutorSchema(model.TaskTypeDepthCapture)
	if err != nil {
		return nil, err
	}
	resourceID := strings.TrimSpace(req.ResourceID)
	if resourceID == "" {
		return nil, kernel.BadAuthRequest(depthcapture.ErrNeedVideo.Error())
	}
	if s.deps.OwnedMedia == nil {
		return nil, unavailable()
	}
	resource, err := s.deps.OwnedMedia.Resource(userID, resourceID)
	if err != nil || resource == nil {
		return nil, kernel.BadAuthRequest(depthcapture.ErrMissingVideo.Error())
	}
	prepared, err := depthcapture.PrepareInput(resourceID, resource)
	if err != nil {
		return nil, kernel.BadAuthRequest(err.Error())
	}
	input, err := decodeObject(prepared)
	if err != nil {
		return nil, err
	}
	if nodeID := strings.TrimSpace(req.NodeID); nodeID != "" {
		if strings.TrimSpace(req.ProjectID) == "" {
			return nil, kernel.BadAuthRequest("指定深度结果节点时必须提供画布 ID")
		}
		input["metadata"] = map[string]any{"nodeId": nodeID, "source": "canvas"}
	}
	return s.admitSpecialized(userID, specializedAdmission{
		kind:      kind,
		projectID: strings.TrimSpace(req.ProjectID),
		input:     withClientOperation(input, req.ClientOperationID),
		traceID:   req.TraceID,
		requestID: req.RequestID,
	})
}

func (s *Service) admitSpecialized(userID string, req specializedAdmission) (*model.Task, error) {
	normalizedInput, err := NormalizeInput(req.input)
	if err != nil {
		return nil, err
	}
	operationKey, err := ClientOperationID(normalizedInput)
	if err != nil {
		return nil, err
	}
	fingerprintReq := CreateRequest{
		ProjectID: req.projectID,
		Type:      req.kind.Type,
		Prompt:    req.kind.Prompt,
		Provider:  req.kind.Provider,
		Model:     req.kind.Model,
		Input:     normalizedInput,
	}
	var operationHash string
	if operationKey != "" {
		operationHash, err = ClientOperationHash(fingerprintReq)
		if err != nil {
			return nil, err
		}
		if s.store == nil {
			return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
		}
		existing, lookupErr := s.store.TaskByClientOperation(userID, operationKey)
		if lookupErr != nil {
			return nil, lookupErr
		}
		if existing != nil {
			return admitExisting(*existing, fingerprintReq, s.deps.Present)
		}
	}
	if err := s.requireSpecializedCollaborators(); err != nil {
		return nil, err
	}
	if s.deps.Runtime.IsDraining() {
		return nil, drainError(DrainCreateMessage)
	}
	limit, err := s.deps.Policy.ActiveTaskLimit()
	if err != nil {
		return nil, err
	}
	if s.store == nil {
		return nil, localStorageFailed(errStoreRequired)
	}
	activeTasks, err := s.store.ActiveTaskCount(userID)
	if err != nil {
		return nil, localStorageFailed(err)
	}
	if activeTasks >= int64(limit) {
		return nil, activeLimitError(limit)
	}

	task := model.Task{
		ID:        s.newID(),
		UserID:    userID,
		TraceID:   req.traceID,
		RequestID: req.requestID,
		ProjectID: req.projectID,
		Type:      req.kind.Type,
		Status:    model.TaskStatusQueued,
		Stage:     req.kind.Stage,
		Progress:  req.kind.Progress,
		Prompt:    req.kind.Prompt,
		Provider:  req.kind.Provider,
		Model:     req.kind.Model,
	}
	if operationKey != "" {
		task.ClientOperationID = &operationKey
		task.ClientOperationHash = operationHash
	}
	if err := s.deps.Projects.EnsureActive(userID, req.projectID); err != nil {
		return nil, err
	}
	inputJSON, err := encodeTaskInput(normalizedInput)
	if err != nil {
		return nil, err
	}
	task.InputJSON = inputJSON
	if s.deps.Persist == nil {
		return nil, localStorageFailed(errors.New("task persistence is required"))
	}
	if s.deps.Present == nil {
		return nil, unavailable()
	}
	err = s.deps.Persist.CreateAdmitted(&task, limit)
	if mapped, mapErr := mapPersistError(err, fingerprintReq, s.deps.Present, limit); mapErr != nil || mapped != nil {
		return mapped, mapErr
	}
	if s.deps.Activity != nil {
		s.deps.Activity.Record(userID, "task", 1)
	}
	s.log(userID, task.ID, "info", req.kind.Log, "")
	return presentTask(s.deps.Present, task)
}

func (s *Service) requireSpecializedCollaborators() error {
	if s.deps.Runtime == nil || s.deps.Projects == nil || s.deps.Policy == nil {
		return unavailable()
	}
	return nil
}

func marshalLocalExecutorInput(value any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, kernel.BadAuthRequest("任务输入格式无效")
	}
	return decodeObject(encoded)
}

func decodeObject(raw []byte) (map[string]any, error) {
	var input map[string]any
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, kernel.BadAuthRequest("任务输入格式无效")
	}
	if input == nil {
		input = map[string]any{}
	}
	return input, nil
}

func withClientOperation(input map[string]any, clientOperationID string) map[string]any {
	if input == nil {
		input = map[string]any{}
	}
	id := strings.TrimSpace(clientOperationID)
	if id == "" {
		return input
	}
	copied := make(map[string]any, len(input)+1)
	for key, value := range input {
		copied[key] = value
	}
	metadata, _ := copied["metadata"].(map[string]any)
	if metadata == nil {
		copied["metadata"] = map[string]any{"clientOperationId": id}
		return copied
	}
	if _, exists := metadata["clientOperationId"]; exists {
		return copied
	}
	next := make(map[string]any, len(metadata)+1)
	for key, value := range metadata {
		next[key] = value
	}
	next["clientOperationId"] = id
	copied["metadata"] = next
	return copied
}
