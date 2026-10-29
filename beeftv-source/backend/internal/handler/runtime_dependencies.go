package handler

import (
	"context"
	"mime/multipart"
	"net/http"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/appearance"
	"infinite-canvas/backend/internal/assistantruntime"
	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/conversation"
	"infinite-canvas/backend/internal/diagnostics"
	"infinite-canvas/backend/internal/eagle"
	"infinite-canvas/backend/internal/localapp"
	"infinite-canvas/backend/internal/model"
	localproject "infinite-canvas/backend/internal/project"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/textreplay"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
)

// RequestCoordinator is the narrow runtime boundary required by request
// throttling. Keeping it separate from app.Service prevents handlers from
// depending on process-global mutable state and makes multiple runtimes safe.
type RequestCoordinator interface {
	AllowRequest(context.Context, string, int, time.Duration) (bool, error)
	RequestRetryAfter(context.Context, string, time.Duration) time.Duration
}

type ProviderConfig interface {
	ReadLocalModelConfig() ([]byte, error)
	SaveLocalModelConfig([]byte) error
}

type VersionedProviderConfig interface {
	ProviderConfig
	LoadEffectiveModelConfig() (workspace.EffectiveModelConfig, workspace.ConfigHealth, error)
	SaveLocalModelConfigRevision([]byte, int64) (int64, error)
}

type RuntimeDependencies struct {
	RequestCoordinator RequestCoordinator
	ProviderConfig     ProviderConfig
	Assets             localapp.AssetPort
	Projects           localapp.ProjectPort
	Tasks              localapp.TaskPort
	Generation         localapp.GenerationPort
	Conversations      *conversation.Service
	// TextReplay is the archive owned by the runtime; legacy callers use its app facade.
	TextReplay  textreplay.API
	BeefAPI     *beefapi.Service
	Eagle       *eagle.Client
	Diagnostics *diagnostics.Service
	Appearance  *appearance.Service
	// AssistantHost is the per-runtime supervisor for the built-in agent-host child.
	// Separate runtimes must not share this value.
	AssistantHost *assistantruntime.Host
	// DesktopTrust verifies both the launch token and the separate Wails UI bootstrap credential.
	// 桌面形态用它代替开发引导开关签发 UI 会话；服务端形态为 nil。
	DesktopTrust func(*http.Request) bool
}

type serviceRuntimeAdapter struct {
	allowRequest                func(context.Context, string, int, time.Duration) (bool, error)
	requestRetryAfter           func(context.Context, string, time.Duration) time.Duration
	readModelConfig             func() ([]byte, error)
	saveModelConfig             func([]byte) error
	resources                   func(string, int) ([]model.Resource, error)
	uploadLocalResource         func(string, *multipart.FileHeader, string, int, int, int64, ...string) (*model.Resource, error)
	listProjects                func(string) ([]localproject.Summary, error)
	tasksWithOptions            func(string, localtask.ListOptions) ([]localtask.Summary, error)
	createTask                  func(string, localtask.CreateRequest) (*model.Task, error)
	createTimelineRender        func(string, localtask.TimelineRenderCreateRequest) (*model.Task, error)
	createTimelineTranscription func(string, localtask.TimelineTranscriptionCreateRequest) (*model.Task, error)
	createDepthCapture          func(string, localtask.DepthCaptureCreateRequest) (*model.Task, error)
}

func newServiceRuntimeAdapter(value *app.Service) serviceRuntimeAdapter {
	return serviceRuntimeAdapter{
		allowRequest: value.AllowRequest, requestRetryAfter: value.RequestRetryAfter,
		readModelConfig: value.ReadLocalModelConfig, saveModelConfig: value.SaveLocalModelConfig,
		resources: value.Resources, uploadLocalResource: value.UploadLocalResource,
		listProjects: value.ListProjects, tasksWithOptions: value.TasksWithOptions, createTask: value.CreateLocalTask,
		createTimelineRender: value.CreateTimelineRenderTask, createTimelineTranscription: value.CreateTimelineTranscriptionTask,
		createDepthCapture: value.CreateDepthCaptureTask,
	}
}

func (a serviceRuntimeAdapter) AllowRequest(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	return a.allowRequest(ctx, key, limit, window)
}

func (a serviceRuntimeAdapter) RequestRetryAfter(ctx context.Context, key string, window time.Duration) time.Duration {
	return a.requestRetryAfter(ctx, key, window)
}

func (a serviceRuntimeAdapter) ReadLocalModelConfig() ([]byte, error) {
	return a.readModelConfig()
}

func (a serviceRuntimeAdapter) SaveLocalModelConfig(value []byte) error {
	return a.saveModelConfig(value)
}

func (a serviceRuntimeAdapter) Resources(userID string, limit int) ([]model.Resource, error) {
	return a.resources(userID, limit)
}

func (a serviceRuntimeAdapter) UploadLocalResource(userID string, header *multipart.FileHeader, kind string, width, height int, durationMs int64, identity ...string) (*model.Resource, error) {
	return a.uploadLocalResource(userID, header, kind, width, height, durationMs, identity...)
}

func (a serviceRuntimeAdapter) ListProjects(userID string) ([]localproject.Summary, error) {
	return a.listProjects(userID)
}

func (a serviceRuntimeAdapter) TasksWithOptions(userID string, options localtask.ListOptions) ([]localtask.Summary, error) {
	return a.tasksWithOptions(userID, options)
}

func (a serviceRuntimeAdapter) CreateTask(userID string, request localtask.CreateRequest) (*model.Task, error) {
	return a.createTask(userID, request)
}

func (a serviceRuntimeAdapter) CreateTimelineRenderTask(userID string, request localtask.TimelineRenderCreateRequest) (*model.Task, error) {
	return a.createTimelineRender(userID, request)
}

func (a serviceRuntimeAdapter) CreateTimelineTranscriptionTask(userID string, request localtask.TimelineTranscriptionCreateRequest) (*model.Task, error) {
	return a.createTimelineTranscription(userID, request)
}

func (a serviceRuntimeAdapter) CreateDepthCaptureTask(userID string, request localtask.DepthCaptureCreateRequest) (*model.Task, error) {
	return a.createDepthCapture(userID, request)
}

func requestAssetPort(c *gin.Context, fallback *app.Service) localapp.AssetPort {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Assets != nil {
		return dependencies.Assets
	}
	return newServiceRuntimeAdapter(fallback)
}

func requestProjectPort(c *gin.Context, fallback *app.Service) localapp.ProjectPort {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Projects != nil {
		return dependencies.Projects
	}
	return newServiceRuntimeAdapter(fallback)
}

func requestTaskPort(c *gin.Context, fallback *app.Service) localapp.TaskPort {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Tasks != nil {
		return dependencies.Tasks
	}
	return newServiceRuntimeAdapter(fallback)
}

func requestGenerationPort(c *gin.Context, fallback *app.Service) localapp.GenerationPort {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Generation != nil {
		return dependencies.Generation
	}
	return newServiceRuntimeAdapter(fallback)
}

func requestProviderConfig(c *gin.Context, fallback *app.Service) ProviderConfig {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.ProviderConfig != nil {
		return dependencies.ProviderConfig
	}
	return newServiceRuntimeAdapter(fallback)
}

func requestTextReplay(c *gin.Context, fallback *app.Service) textReplayAPI {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.TextReplay != nil {
		return dependencies.TextReplay
	}
	return appTextReplayAPI{fallback}
}

const runtimeDependenciesKey = "canvas.runtime-dependencies"

func RuntimeDependenciesMiddleware(dependencies RuntimeDependencies) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(runtimeDependenciesKey, dependencies)
		c.Next()
	}
}

func runtimeDependencies(c *gin.Context) (RuntimeDependencies, bool) {
	value, ok := c.Get(runtimeDependenciesKey)
	if !ok {
		return RuntimeDependencies{}, false
	}
	dependencies, ok := value.(RuntimeDependencies)
	return dependencies, ok
}
