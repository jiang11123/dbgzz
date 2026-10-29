package creation

import (
	"encoding/json"

	"infinite-canvas/backend/internal/model"
)

// Guard is the page-held execution fence. Models cannot mint one.
type Guard struct {
	ExecutionEpoch int64  `json:"executionEpoch"`
	Owner          string `json:"owner"`
}

// CanvasOp is an approved canvas mutation. The allowed set is add, update,
// connect, and select; it is not a generic document patch language.
type CanvasOp struct {
	Type         string         `json:"type"`
	ID           string         `json:"id,omitempty"`
	NodeType     string         `json:"nodeType,omitempty"`
	Title        string         `json:"title,omitempty"`
	Position     map[string]any `json:"position,omitempty"`
	X            *float64       `json:"x,omitempty"`
	Y            *float64       `json:"y,omitempty"`
	Width        *float64       `json:"width,omitempty"`
	Height       *float64       `json:"height,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	Patch        map[string]any `json:"patch,omitempty"`
	FromNodeID   string         `json:"fromNodeId,omitempty"`
	ToNodeID     string         `json:"toNodeId,omitempty"`
	FromHandleID string         `json:"fromHandleId,omitempty"`
	ToHandleID   string         `json:"toHandleId,omitempty"`
	IDs          []string       `json:"ids,omitempty"`
}

// Command is the transport-neutral write command. HTTP payloads stay on the
// app alias until handlers switch over.
type Command struct {
	Guard
	ClientKey            string
	CanvasID             string
	Revision             int64
	ExpectedEpoch        int64
	State                map[string]any
	Status               string
	ProposalVersion      int64
	Proposal             json.RawMessage
	Ops                  []CanvasOp
	ItemKey              string
	Task                 TaskRequest
	SubmissionIDs        []string
	SubmissionID         string
	ExpectedSnapshotHash string
	Document             json.RawMessage
}

// TaskRequest is the creation-owned quote/submit intent. PrepareOnly and
// AdmissionID are in-process only; JSON transports cannot set them.
type TaskRequest struct {
	ProjectID      string         `json:"projectId"`
	Type           string         `json:"type"`
	Operation      string         `json:"operation"`
	Prompt         string         `json:"prompt"`
	Provider       string         `json:"provider"`
	Model          string         `json:"model"`
	LogicalModelID string         `json:"logicalModelId"`
	Input          map[string]any `json:"input"`
	TraceID        string         `json:"-"`
	RequestID      string         `json:"-"`
	PrepareOnly    bool           `json:"-"`
	AdmissionID    string         `json:"-"`
}

type RunOutput struct {
	model.CreationRun
	State map[string]any `json:"state"`
}

type Execution struct {
	Model      string         `json:"model"`
	ConfigHash string         `json:"configHash"`
	Options    map[string]any `json:"options,omitempty"`
}

type SubmissionOutput struct {
	model.CreationSubmission
	Execution Execution `json:"execution"`
}

type Detail struct {
	Run         RunOutput          `json:"run"`
	Submissions []SubmissionOutput `json:"submissions"`
}

type PreparedTask struct {
	Task   *model.Task
	Input  map[string]any
	Config map[string]any
}

func RunView(run model.CreationRun) RunOutput {
	state := map[string]any{}
	_ = json.Unmarshal([]byte(run.StateJSON), &state)
	return RunOutput{CreationRun: run, State: state}
}

func SubmissionView(item model.CreationSubmission) SubmissionOutput {
	var execution Execution
	_ = json.Unmarshal([]byte(item.ExecutionJSON), &execution)
	return SubmissionOutput{CreationSubmission: item, Execution: execution}
}
