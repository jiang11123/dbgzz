package model

import "time"

// AssistantContinuation is a user's one-shot authorization after a confirmed
// generation. Task/turn identities are immutable; the transcript stays in pi.
type AssistantContinuation struct {
	ID             string    `gorm:"primaryKey;size:64" json:"id"`
	UserID         string    `gorm:"index:idx_assistant_continuation_scope,priority:1" json:"-"`
	CanvasID       string    `gorm:"index:idx_assistant_continuation_scope,priority:2" json:"canvasId"`
	SessionID      string    `gorm:"index:idx_assistant_continuation_scope,priority:3" json:"sessionId"`
	ScopeID        string    `json:"-"`
	ScopeRevision  int64     `json:"-"`
	SourceTurnID   string    `json:"sourceTurnId"`
	ProposalID     string    `json:"proposalId"`
	Kind           string    `json:"-"`
	PermissionMode string    `json:"permissionMode"`
	SourceNodeIDs  string    `gorm:"type:text" json:"-"`
	ManifestJSON   string    `gorm:"type:text" json:"-"`
	TaskIDsJSON    string    `gorm:"type:text" json:"-"`
	RequestID      string    `json:"requestId"`
	TurnID         string    `gorm:"uniqueIndex:idx_assistant_continuation_turn" json:"turnId"`
	State          string    `json:"state"`
	Revision       int64     `json:"revision"`
	RevisionBefore int64     `json:"-"`
	CreatedAt      time.Time `json:"-"`
	UpdatedAt      time.Time `json:"-"`
}

func (AssistantContinuation) TableName() string { return "assistant_continuations" }
