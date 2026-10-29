package model

import "time"

// CanvasLibraryFolder is a user-owned canvas library grouping. Membership lives
// on CanvasProject.LibraryFolderID; cover bytes live on a Resource.
type CanvasLibraryFolder struct {
	ID              string     `json:"id" gorm:"primaryKey;size:80"`
	UserID          string     `json:"userId" gorm:"index:idx_canvas_library_folders_user,priority:1;size:36"`
	Name            string     `json:"name" gorm:"size:120"`
	CoverResourceID string     `json:"coverResourceId,omitempty" gorm:"size:36"`
	TombstonedAt    *time.Time `json:"-" gorm:"column:deleted_at"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

func (CanvasLibraryFolder) TableName() string { return "canvas_library_folders" }

// CanvasDrawing is the committed drawing snapshot for one canvas drawing node.
// Preview and render bytes are Resource IDs, not inline payloads.
type CanvasDrawing struct {
	UserID            string     `json:"userId" gorm:"primaryKey;size:36;priority:1"`
	CanvasID          string     `json:"canvasId" gorm:"primaryKey;size:80;priority:2;index:idx_canvas_drawings_canvas"`
	DrawingID         string     `json:"drawingId" gorm:"primaryKey;size:80;priority:3"`
	Engine            string     `json:"engine" gorm:"size:32;not null"`
	Revision          int64      `json:"revision" gorm:"not null;default:1"`
	SnapshotJSON      string     `json:"snapshotJson" gorm:"type:text"`
	ShapeCount        int        `json:"shapeCount"`
	PageCount         int        `json:"pageCount"`
	PreviewResourceID string     `json:"previewResourceId,omitempty" gorm:"size:36"`
	RenderResourceID  string     `json:"renderResourceId,omitempty" gorm:"size:36"`
	RenderPageID      string     `json:"renderPageId,omitempty" gorm:"size:80"`
	RenderWidth       int        `json:"renderWidth"`
	RenderHeight      int        `json:"renderHeight"`
	RenderMimeType    string     `json:"renderMimeType,omitempty" gorm:"size:80"`
	RenderBackground  string     `json:"renderBackground,omitempty" gorm:"size:16"`
	RenderStorageKey  string     `json:"renderStorageKey,omitempty" gorm:"size:120"`
	TombstonedAt      *time.Time `json:"-" gorm:"column:deleted_at"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

func (CanvasDrawing) TableName() string { return "canvas_drawings" }
