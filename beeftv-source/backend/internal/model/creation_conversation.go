package model

import "time"

// CreationConversation is the durable /create page conversation aggregate.
// It is not a CreationRun, assistant business turn, or pi session transcript.
type CreationConversation struct {
	UserID            string    `json:"userId" gorm:"primaryKey;size:64;not null"`
	ConversationID    string    `json:"conversationId" gorm:"primaryKey;size:80;not null"`
	Revision          int64     `json:"revision" gorm:"not null"`
	Document          string    `json:"-" gorm:"type:text;not null"`
	Deleted           bool      `json:"deleted" gorm:"not null;default:0"`
	ImportOperationID string    `json:"-" gorm:"size:160"`
	ImportHash        string    `json:"-" gorm:"size:64"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

func (CreationConversation) TableName() string { return "creation_conversations" }
