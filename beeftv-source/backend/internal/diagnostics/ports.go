package diagnostics

import (
	"time"

	"infinite-canvas/backend/internal/model"
)

type Store interface {
	TaskForUser(userID string, id string) (*model.Task, error)
	DiagnosticTasks(userID string, from time.Time, to time.Time, taskID string, projectID string) ([]model.Task, error)
	DiagnosticTaskLogs(userID string, from time.Time, to time.Time, taskID string, projectID string) ([]model.TaskLog, error)
	DiagnosticAPICallLogs(userID string, from time.Time, to time.Time, taskID string, projectID string) ([]model.ApiCallLog, error)
	CanvasProjectForUser(userID string, id string) (*model.CanvasProject, error)
}

// ModelConfigProvider exposes the local workspace provider snapshot so the
// diagnostics bundle can include a redacted model-configuration summary.
type ModelConfigProvider interface {
	ReadLocalModelConfig() ([]byte, error)
}

type Brand interface {
	NameAndSlug() (string, string)
}

type staticBrand struct {
	name string
	slug string
}

func (b staticBrand) NameAndSlug() (string, string) {
	if b.name == "" {
		return defaultBrandName, defaultBrandSlug
	}
	if b.slug == "" {
		return b.name, defaultBrandSlug
	}
	return b.name, b.slug
}

const (
	defaultBrandName = "BeefTV"
	defaultBrandSlug = "beeftv"
)
