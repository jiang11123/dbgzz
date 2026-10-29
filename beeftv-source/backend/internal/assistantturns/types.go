package assistantturns

import (
	"encoding/json"
	"infinite-canvas/backend/internal/skills"
	"reflect"
	"sort"
	"strings"
	"time"
)

const (
	ReasonNotFound      = "turn_not_found"
	ReasonNoChange      = "turn_has_no_change"
	ReasonAlreadyUndone = "turn_already_undone"
	ReasonCanvasChanged = "canvas_changed_since_turn"
	ReasonIDCollision   = "turn_id_conflict"
	ReasonCorruptFile   = "turn_file_corrupt"
	ReasonOwnership     = "turn_file_ownership"
	ReasonNotOpen       = "turn_not_open"
	ReasonIdentity      = "turn_identity_required"
	ReasonStore         = "turn_store_unavailable"
	ReasonUndone        = "turn_undone"
)

const (
	StateOpen    = "open"
	StateSettled = "settled"
)

const retainSettled = 64

// Error carries a stable reason so HTTP handlers can project 409/404.
type Error struct {
	Reason  string
	Message string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if strings.TrimSpace(e.Message) != "" {
		return e.Message
	}
	return e.Reason
}

func errNotFound() *Error {
	return &Error{Reason: ReasonNotFound, Message: "轮次不存在"}
}

func errInvalidID() *Error {
	return &Error{Reason: ReasonNotFound, Message: "轮次标识无效"}
}

func errCorruptStored() *Error {
	return &Error{Reason: ReasonCorruptFile, Message: "轮次记录损坏，已保留现场"}
}

// Change is the canvas effect of one business round, reconstructed from
// operation receipts that share this turn identity.
type Change struct {
	DocumentHash    string   `json:"documentHash,omitempty"`
	UpdatedFields   []string `json:"updatedFields,omitempty"`
	CanvasID        string   `json:"canvasId,omitempty"`
	CanvasChanges   []Change `json:"canvasChanges,omitempty"`
	DeletedNodeIDs  []string `json:"deletedNodeIds,omitempty"`
	DeletedEdgeIDs  []string `json:"deletedEdgeIds,omitempty"`
	DocumentUpdated bool     `json:"documentUpdated,omitempty"`
	RevisionBefore  int64    `json:"revisionBefore"`
	RevisionAfter   int64    `json:"revisionAfter"`
	CreatedNodeIDs  []string `json:"createdNodeIds"`
	UpdatedNodeIDs  []string `json:"updatedNodeIds"`
	CreatedEdgeIDs  []string `json:"createdEdgeIds"`
	OperationIDs    []string `json:"operationIds,omitempty"`
	TimelineUpdated bool     `json:"timelineUpdated,omitempty"`
}

// Input is the backend-verified explicit context at Begin. The model cannot
// grant extra references.
type Input struct {
	PermissionMode  string
	SelectedNodeIDs []string
	AssetIDs        []string
	CanvasIDs       []string
	SkillPins       []skills.Pin
}

// Scope is the backend-verified read/write range for an open round.
type Scope struct {
	PermissionMode  string
	CanvasID        string
	AssetIDs        []string
	CanvasIDs       []string
	TaskIDs         []string
	SkillPins       []skills.Pin
	ActiveSkillPins []skills.Pin
	// SessionSkillPins are pins of earlier rounds of the same Durable
	// conversation and owner. Their bodies are already in that transcript.
	SessionSkillPins []skills.Pin
}

// HistoryState supplements pi conversation history with business receipts.
// Reading it never settles or cancels an active round.
type HistoryState struct {
	ContinuationInvalidated bool
	PermissionMode          string
	Change                  *Change
	Undone                  bool
	SkillPins               []skills.Pin
}

// Record is the in-memory business round. Document is the pre-turn canvas
// snapshot, not a chat transcript.
type Record struct {
	ContinuationInvalidated     bool
	GenerationAuthorizationJSON string

	DurableNativeSources string
	DurableSessionID     string
	PermissionMode       string
	CanvasSnapshots      map[string]CanvasSnapshot
	TurnID               string
	UserID               string
	CanvasID             string
	RevisionBefore       int64
	CreatedAt            time.Time
	State                string
	SelectedNodeIDs      []string
	ReferencedAssetIDs   []string
	ReferencedCanvasIDs  []string
	AssociatedAssetIDs   []string
	AssociatedTaskIDs    []string
	SkillPins            []skills.Pin
	Undone               bool
	Change               *Change
	Document             json.RawMessage
}

func (r Record) effectiveState() string {
	if strings.TrimSpace(r.State) == "" {
		return StateSettled
	}
	return r.State
}

func (r Record) sameBeginScope(userID, canvasID string, input Input) bool {
	return r.UserID == userID && r.CanvasID == canvasID &&
		Mode(r.PermissionMode) == Mode(input.PermissionMode) &&
		equalStringLists(r.SelectedNodeIDs, uniqueSorted(input.SelectedNodeIDs)) &&
		equalStringLists(r.ReferencedAssetIDs, uniqueSorted(input.AssetIDs)) &&
		equalStringLists(r.ReferencedCanvasIDs, uniqueSorted(input.CanvasIDs)) &&
		reflect.DeepEqual(skillPinIdentities(r.SkillPins), skillPinIdentities(input.SkillPins))
}

const (
	PermissionCanvas     = "canvas"
	PermissionReadOnly   = "read-only"
	PermissionFullAccess = "full-access"
)

func Mode(value string) string {
	if value == "" {
		return PermissionCanvas
	}
	return value
}
func ValidMode(value string) bool {
	switch Mode(value) {
	case PermissionCanvas, PermissionReadOnly, PermissionFullAccess:
		return true
	}
	return false
}

type CanvasSnapshot struct {
	RevisionBefore int64           `json:"revisionBefore"`
	Document       json.RawMessage `json:"document"`
}

// skillPinIdentities ignores display labels: a skill renamed between a
// replayed Begin and the stored round is still the same pinned package.
func skillPinIdentities(pins []skills.Pin) []skills.Pin {
	result := make([]skills.Pin, 0, len(pins))
	for _, pin := range SortedSkillPins(pins) {
		result = append(result, pin.Identity())
	}
	return result
}

func SortedSkillPins(pins []skills.Pin) []skills.Pin {
	result := append([]skills.Pin{}, pins...)
	sort.Slice(result, func(i, j int) bool { return result[i].SkillID < result[j].SkillID })
	return result
}

func equalStringLists(a, b []string) bool {
	left := uniqueSorted(a)
	right := uniqueSorted(b)
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
