package creation

import (
	"encoding/json"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Tasks is the typed task-admission seam. Creation never imports internal/app
// or calls Service.CreateTask. Prepare quotes without persisting. Admit is a
// local SQLite insert on the MutateCreationRun transaction repository.
type Tasks interface {
	Prepare(userID string, req TaskRequest) (*PreparedTask, error)
	Admit(userID string, repo *repository.Repository, task *model.Task) (*model.Task, error)
}

// Secrets protects credentials after quoting and before durable submit.
type Secrets interface {
	Protect(input map[string]any) error
}

// Quota is workspace structured-storage policy. Creation records and canvas
// documents share the canvas quota class but are measured separately.
type Quota interface {
	ValidateRun(userID string, repo *repository.Repository, creating bool, delta int64) error
	ValidateCanvas(userID string, repo *repository.Repository, creating bool, delta int64) error
}

// Media rejects canvas documents that point at unowned or unreadied assets.
// The repository must be the MutateCreationRun transaction, not the root
// connection, so concurrent asset/resource deletion is visible to the write.
type Media interface {
	ValidateDocument(userID string, repo *repository.Repository, raw json.RawMessage) error
}

// TaskKinds identifies generation modes that creation refuses to quote.
type TaskKinds interface {
	UsesWorkflow(input map[string]any) bool
	UsesTextReplay(input map[string]any) bool
}

// Dependencies are the explicit collaborators. Missing ports fail closed on
// the path that needs them.
type Dependencies struct {
	Tasks   Tasks
	Secrets Secrets
	Quota   Quota
	Media   Media
	Kinds   TaskKinds
	Now     func() time.Time
	NewID   func() string
}

func (d Dependencies) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Dependencies) newID() string {
	if d.NewID != nil {
		return d.NewID()
	}
	return kernel.NewID()
}
