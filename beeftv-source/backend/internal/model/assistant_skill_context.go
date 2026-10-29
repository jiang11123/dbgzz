package model

import "time"

// AssistantSkillContext stores package identities, never copied instructions.
type AssistantSkillContext struct {
	UserID           string `gorm:"primaryKey;size:36"`
	CanvasID         string `gorm:"primaryKey;size:80"`
	DurableSessionID string `gorm:"primaryKey;size:80"`
	ScopeID          string `gorm:"size:64;not null"`
	Revision         int64  `gorm:"not null"`
	ActivePinsJSON   string `gorm:"type:text;not null"`
	Lifecycle        string `gorm:"size:24;not null"`
	UpdatedAt        time.Time
}

func (AssistantSkillContext) TableName() string { return "assistant_skill_contexts" }

// Mutation receipts make replay safe even after later context changes.
type AssistantSkillContextMutation struct {
	UserID           string `gorm:"primaryKey;size:36"`
	CanvasID         string `gorm:"primaryKey;size:80"`
	DurableSessionID string `gorm:"primaryKey;size:80"`
	RequestID        string `gorm:"primaryKey;size:160"`
	Digest           string `gorm:"size:64;not null"`
	ResultJSON       string `gorm:"type:text;not null"`
	CreatedAt        time.Time
}

func (AssistantSkillContextMutation) TableName() string { return "assistant_skill_context_mutations" }
