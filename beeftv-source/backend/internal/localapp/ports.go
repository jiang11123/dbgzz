package localapp

import (
	"context"
	"mime/multipart"

	"infinite-canvas/backend/internal/model"
	localproject "infinite-canvas/backend/internal/project"
	localtask "infinite-canvas/backend/internal/task"
)

// These ports intentionally expose one cohesive local capability each.
// ProjectPort is implemented by internal/project; remaining ports are still
// adapted from the application kernel while those domains are extracted.
type WorkspacePort interface {
	WorkspaceOwner(string) (*model.User, error)
}

type ProjectPort interface {
	ListProjects(string) ([]localproject.Summary, error)
}

type AssetPort interface {
	Resources(string, int) ([]model.Resource, error)
	UploadLocalResource(string, *multipart.FileHeader, string, int, int, int64, ...string) (*model.Resource, error)
}

type TaskPort interface {
	TasksWithOptions(string, localtask.ListOptions) ([]localtask.Summary, error)
	CreateTimelineRenderTask(string, localtask.TimelineRenderCreateRequest) (*model.Task, error)
	CreateTimelineTranscriptionTask(string, localtask.TimelineTranscriptionCreateRequest) (*model.Task, error)
	CreateDepthCaptureTask(string, localtask.DepthCaptureCreateRequest) (*model.Task, error)
}

type GenerationPort interface {
	CreateTask(string, localtask.CreateRequest) (*model.Task, error)
}

type ProviderConfigPort interface {
	ReadLocalModelConfig() ([]byte, error)
	SaveLocalModelConfig([]byte) error
}

type Lifecycle interface {
	StartWorker()
	StopWorker(context.Context) error
	Close() error
}
