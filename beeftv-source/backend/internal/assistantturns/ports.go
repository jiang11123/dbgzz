package assistantturns

import (
	"encoding/json"

	"gorm.io/gorm"
)

// CanvasSession is a canvas read/write bound to one database connection.
// Undo injects a transaction-bound session so canvas restore and the undone
// marker share a commit.
type CanvasSession interface {
	UserCanvasProject(userID, canvasID string) (json.RawMessage, error)
	UpsertUserCanvasProject(userID string, raw json.RawMessage) (int64, error)
}

// CanvasFactory produces a session on the root connection or inside a caller
// transaction. Nested root-DB transactions deadlock SQLite; the factory must
// bind the existing tx rather than opening a second one.
type CanvasFactory interface {
	BoundTo(tx *gorm.DB) CanvasSession
}
