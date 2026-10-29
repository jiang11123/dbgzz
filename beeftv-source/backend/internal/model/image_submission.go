package model

import "time"

// ImageSubmission keeps the exact encrypted wire request separate from mutable
// task input. It is never exposed by the task API.
type ImageSubmission struct {
	AttemptID        string    `gorm:"primaryKey;size:36" json:"-"`
	TaskID           string    `gorm:"size:36;index" json:"-"`
	UserID           string    `gorm:"size:36;index" json:"-"`
	RequestCipher    string    `gorm:"type:text" json:"-"`
	SendCount        int       `json:"-"`
	ResponseAccepted bool      `json:"-"`
	CreatedAt        time.Time `json:"-"`
}
