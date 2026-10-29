package model

import "time"

// Workspace is the single durable ownership root of a native installation.
// Existing user_id columns store this ID until their physical column names can
// be changed without rewriting every large local table in one release.
type Workspace struct {
	ID        string    `json:"id" gorm:"primaryKey;size:36"`
	Name      string    `json:"name" gorm:"size:80;not null"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
