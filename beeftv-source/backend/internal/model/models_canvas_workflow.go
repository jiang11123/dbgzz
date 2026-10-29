package model

import "time"

// Private execution recipes live separately from the public definition.
type CanvasWorkflow struct {
	Revision       int    `gorm:"not null;default:1"`
	ID             string `gorm:"primaryKey;size:36"`
	UserID         string `gorm:"index;size:36"`
	Name           string
	Description    string
	DefinitionJSON string `gorm:"type:text"`
	RecipeCipher   string `gorm:"type:text" json:"-"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type CanvasWorkflowRevision struct {
	TemplateID     string `gorm:"primaryKey;size:36"`
	Revision       int    `gorm:"primaryKey"`
	UserID         string `gorm:"index;size:36"`
	Name           string
	Description    string
	DefinitionJSON string `gorm:"type:text"`
	RecipeCipher   string `gorm:"type:text" json:"-"`
}

type CanvasWorkflowRun struct {
	TemplateRevision  int    `gorm:"not null;default:1"`
	ID                string `gorm:"primaryKey;size:36"`
	UserID            string `gorm:"index;size:36;uniqueIndex:idx_canvas_workflow_operation,priority:1"`
	ClientOperationID string `gorm:"size:128;uniqueIndex:idx_canvas_workflow_operation,priority:2"`
	RequestHash       string
	TemplateID        string `gorm:"index;size:36"`
	TemplateName      string
	DefinitionJSON    string `gorm:"type:text"`
	RecipeCipher      string `gorm:"type:text" json:"-"`
	StateJSON         string `gorm:"type:text"`
	Status            string `gorm:"index;size:24"`
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type CanvasWorkflowResource struct {
	OwnerID    string `gorm:"primaryKey;size:36"`
	ResourceID string `gorm:"primaryKey;size:36;index"`
	UserID     string `gorm:"index;size:36"`
}
