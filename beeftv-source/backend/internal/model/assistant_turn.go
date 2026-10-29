package model

import "time"

// AssistantTurn is the durable assistant business round. It stores scope,
// the pre-turn canvas snapshot, settlement, and the undo marker. It is not a
// model-session transcript; pi owns that history.
type AssistantTurn struct {
	ContinuationInvalidated     bool   `json:"-" gorm:"not null;default:false"`
	GenerationAuthorizationJSON string `json:"-" gorm:"type:text"`

	DurableNativeSources string    `json:"-" gorm:"type:text"`
	DurableSessionID     string    `json:"-" gorm:"size:80"`
	TurnID               string    `json:"turnId" gorm:"primaryKey;size:64"`
	UserID               string    `json:"userId" gorm:"size:36;not null;index:idx_assistant_turns_user_canvas,priority:1"`
	CanvasID             string    `json:"canvasId" gorm:"size:80;not null;index:idx_assistant_turns_user_canvas,priority:2"`
	PermissionMode       string    `json:"permissionMode" gorm:"size:16"`
	CanvasSnapshotsJSON  string    `json:"-" gorm:"type:text"`
	RevisionBefore       int64     `json:"revisionBefore"`
	CreatedAt            time.Time `json:"createdAt"`
	UpdatedAt            time.Time `json:"updatedAt"`
	State                string    `json:"state" gorm:"size:16;not null"`
	SelectedNodeIDs      string    `json:"-" gorm:"type:text"`
	ReferencedAssetIDs   string    `json:"-" gorm:"type:text"`
	ReferencedCanvasIDs  string    `json:"-" gorm:"type:text"`
	AssociatedAssetIDs   string    `json:"-" gorm:"type:text"`
	AssociatedTaskIDs    string    `json:"-" gorm:"type:text"`
	SkillPinsJSON        string    `json:"-" gorm:"type:text"`
	Undone               bool      `json:"undone"`
	ChangeJSON           string    `json:"-" gorm:"type:text"`
	Document             string    `json:"-" gorm:"type:text"`
}

func (AssistantTurn) TableName() string { return "assistant_turns" }
