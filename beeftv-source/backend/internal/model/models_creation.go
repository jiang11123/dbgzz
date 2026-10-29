package model

import "time"

// CreationRun keeps execution authority separate from untrusted conversation state.
type CreationRun struct {
	ID                      string     `json:"id" gorm:"primaryKey;size:36"`
	UserID                  string     `json:"userId" gorm:"size:36;index;uniqueIndex:idx_creation_client,priority:1"`
	ClientKey               string     `json:"-" gorm:"size:120;uniqueIndex:idx_creation_client,priority:2"`
	CreateHash              string     `json:"-" gorm:"size:64"`
	CanvasID                string     `json:"canvasId,omitempty" gorm:"size:80"`
	Revision                int64      `json:"revision"`
	ExecutionEpoch          int64      `json:"executionEpoch"`
	ExecutionOwner          string     `json:"executionOwner" gorm:"size:120"`
	LeaseExpiresAt          *time.Time `json:"leaseExpiresAt,omitempty"`
	Status                  string     `json:"status" gorm:"size:32"`
	StateJSON               string     `json:"-" gorm:"type:text"`
	ApprovedProposalVersion int64      `json:"approvedProposalVersion,omitempty"`
	ApprovedProposalHash    string     `json:"approvedProposalHash,omitempty" gorm:"size:64"`
	ApprovedOperationsJSON  string     `json:"-" gorm:"type:text"`
	ApprovedCanvasJSON      string     `json:"-" gorm:"type:text"`
	ApprovedAt              *time.Time `json:"-"`
	CreatedAt               time.Time  `json:"createdAt"`
	UpdatedAt               time.Time  `json:"updatedAt"`
}

type CreationSubmission struct {
	ID              string     `json:"id" gorm:"primaryKey;size:36"`
	UserID          string     `json:"-" gorm:"size:36;index"`
	RunID           string     `json:"runId" gorm:"size:36;uniqueIndex:idx_creation_item,priority:1"`
	ItemKey         string     `json:"itemKey" gorm:"size:160;uniqueIndex:idx_creation_item,priority:2"`
	ProposalVersion int64      `json:"-"`
	ProposalHash    string     `json:"-" gorm:"size:64"`
	RequestJSON     string     `json:"-" gorm:"type:text"`
	RequestHash     string     `json:"requestHash" gorm:"size:64"`
	ExecutionJSON   string     `json:"-" gorm:"type:text"`
	ConfigSignature string     `json:"-" gorm:"type:text"`
	ApprovedAt      *time.Time `json:"approvedAt,omitempty"`
	RevokedAt       *time.Time `json:"revokedAt,omitempty"`
	TaskID          *string    `json:"taskId,omitempty" gorm:"size:36;uniqueIndex"`
	CreatedAt       time.Time  `json:"-"`
	UpdatedAt       time.Time  `json:"-"`
}
