package model

import "time"

// CloudAgentExecution checkpoints orchestration independently of billed tasks.
type CloudAgentExecution struct {
	ID       string `gorm:"primaryKey;size:80"`
	UserID   string `gorm:"index;size:36"`
	Status   string `gorm:"index;size:32"`
	Revision int64
	// Control fields remain writable even when the transcript cannot be decoded or saved.
	CanvasID       string `gorm:"size:80"`
	ActiveTaskID   string `gorm:"size:80"`
	MediaTaskID    string `gorm:"size:80"`
	CleanupPending bool   `gorm:"not null;default:false;index"`
	FailureMessage string `gorm:"size:1000"`
	StateJSON      string `gorm:"type:text"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// CloudAgentCanvasMutation records one atomic canvas change made by an Agent.
// BeforeJSON is intentionally bounded by the application layer; mutations that
// cannot retain a safe snapshot are marked not_undoable instead of truncating it.
type CloudAgentCanvasMutation struct {
	ID                 string     `json:"id" gorm:"primaryKey;size:80"`
	RunID              string     `json:"runId" gorm:"index;size:80"`
	UserID             string     `json:"userId" gorm:"index;size:36"`
	CanvasID           string     `json:"canvasId" gorm:"index;size:80"`
	StepID             string     `json:"stepId" gorm:"index;size:160"`
	Operation          string     `json:"operation" gorm:"size:64"`
	BeforeSnapshotHash string     `json:"beforeSnapshotHash" gorm:"size:64"`
	AfterSnapshotHash  string     `json:"afterSnapshotHash" gorm:"size:64"`
	BeforeJSON         string     `json:"-" gorm:"type:text"`
	HasSubmittedTask   bool       `json:"hasSubmittedTask"`
	Status             string     `json:"status" gorm:"index;size:24"`
	CreatedAt          time.Time  `json:"createdAt" gorm:"index"`
	UndoneAt           *time.Time `json:"undoneAt,omitempty"`
}
