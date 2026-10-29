package agentops

import (
	"gorm.io/gorm"

	"infinite-canvas/backend/internal/operations"
)

type (
	Store      = operations.Store
	RunRequest = operations.RunRequest
	RunOutcome = operations.RunOutcome
)

func NewStore(db *gorm.DB) *Store { return operations.NewStore(db) }

func PayloadHash(op string, payload []byte) string { return operations.PayloadHash(op, payload) }
